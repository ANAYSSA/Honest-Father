// Adapted from sohzm/systemAudioDump, commit 19caa4f6c0661c03a10d1f08c79a11f0b00f251a.
// Copyright (c) 2025 Mohammed Yasin Mulla. See LICENSE in this directory.
// Honest Father changes: clean PCM stdout, fixed stereo format, safe converter input,
// macOS 13 support, and a nonzero exit on capture failure.
import Foundation
import AVFoundation
@preconcurrency import ScreenCaptureKit
import CoreMedia
import CoreGraphics

func report(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

@main
struct SystemAudioDump {
    static func main() async {
        do {
            guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
                report("Screen Recording permission is required. Enable Honest Father in System Settings > Privacy & Security > Screen Recording.")
                exit(1)
            }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else {
                report("No display is available for system audio capture.")
                exit(1)
            }
            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.sampleRate = 24_000
            config.channelCount = 2
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.showsCursor = false

            let dumper = AudioDumper()
            let stream = SCStream(filter: filter, configuration: config, delegate: dumper)
            try stream.addStreamOutput(dumper, type: .audio, sampleHandlerQueue: DispatchQueue(label: "honest-father.audio"))
            try await stream.startCapture()
            report("System audio capture started: 24000 Hz, stereo, signed 16-bit PCM.")
            while true {
                try await Task.sleep(nanoseconds: 1_000_000_000)
                withExtendedLifetime(stream) {}
            }
        } catch {
            report("System audio capture failed: \(error.localizedDescription)")
            exit(1)
        }
    }
}

final class AudioDumper: NSObject, SCStreamDelegate, SCStreamOutput {
    private var converter: AVAudioConverter?
    private var outputFormat: AVAudioFormat?

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio, sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }
        do {
            try sampleBuffer.withAudioBufferList { buffers, _ in
                guard let description = sampleBuffer.formatDescription?.audioStreamBasicDescription else { return }
                if converter == nil || converter?.inputFormat.sampleRate != description.mSampleRate || converter?.inputFormat.channelCount != description.mChannelsPerFrame {
                    guard let sourceFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: description.mSampleRate, channels: description.mChannelsPerFrame, interleaved: false),
                          let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 2, interleaved: true) else {
                        report("Could not create an audio conversion format.")
                        return
                    }
                    outputFormat = targetFormat
                    converter = AVAudioConverter(from: sourceFormat, to: targetFormat)
                }
                guard let converter, let outputFormat,
                      let source = AVAudioPCMBuffer(pcmFormat: converter.inputFormat, frameCapacity: AVAudioFrameCount(sampleBuffer.numSamples)),
                      let channelData = source.floatChannelData else { return }
                source.frameLength = source.frameCapacity
                for channel in 0..<min(Int(converter.inputFormat.channelCount), buffers.count) {
                    guard let bytes = buffers[channel].mData else { return }
                    let size = min(Int(buffers[channel].mDataByteSize), Int(source.frameLength) * MemoryLayout<Float>.size)
                    memcpy(channelData[channel], bytes, size)
                }
                let capacity = AVAudioFrameCount(ceil(Double(source.frameLength) * outputFormat.sampleRate / converter.inputFormat.sampleRate)) + 64
                guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
                var conversionError: NSError?
                var supplied = false
                let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
                    if supplied {
                        inputStatus.pointee = .noDataNow
                        return nil
                    }
                    supplied = true
                    inputStatus.pointee = .haveData
                    return source
                }
                guard status != .error, output.frameLength > 0, let samples = output.int16ChannelData?[0] else {
                    if let conversionError { report("Audio conversion failed: \(conversionError.localizedDescription)") }
                    return
                }
                let byteCount = Int(output.frameLength) * Int(outputFormat.streamDescription.pointee.mBytesPerFrame)
                try FileHandle.standardOutput.write(contentsOf: Data(bytes: samples, count: byteCount))
            }
        } catch {
            report("Audio processing failed: \(error.localizedDescription)")
            exit(1)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        report("System audio stream stopped: \(error.localizedDescription)")
        exit(1)
    }
}
