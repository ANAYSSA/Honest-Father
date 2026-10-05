const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function makeStream(audio = false) {
    const videoTrack = {
        stopped: false,
        stop() {
            this.stopped = true;
        },
        addEventListener() {},
    };
    const audioTrack = {
        stopped: false,
        stop() {
            this.stopped = true;
        },
    };
    return {
        videoTrack,
        audioTrack,
        getTracks: () => (audio ? [videoTrack, audioTrack] : [videoTrack]),
        getVideoTracks: () => [videoTrack],
        getAudioTracks: () => (audio ? [audioTrack] : []),
    };
}

function loadRenderer({ platform = 'darwin', mode = 'mic_only', mediaDevices, invokeOverride, createElement, FileReaderClass } = {}) {
    const listeners = new Map();
    const calls = [];
    const contexts = [];
    const app = {
        status: '',
        responses: [],
        setStatus(status) {
            this.status = status;
        },
        handleSessionEnded(reason) {
            this.ended = reason;
        },
        addNewResponse(response) {
            this.responses.push(response);
        },
    };
    class AudioContext {
        constructor() {
            this.closed = false;
            contexts.push(this);
        }
        createMediaStreamSource() {
            return { connect() {} };
        }
        createScriptProcessor() {
            return {
                connect() {},
                disconnect() {
                    this.disconnected = true;
                },
            };
        }
        async close() {
            this.closed = true;
        }
    }
    const ipcRenderer = {
        on(channel, callback) {
            listeners.set(channel, callback);
        },
        async invoke(channel, ...args) {
            calls.push({ channel, args });
            if (invokeOverride) {
                const override = invokeOverride(channel, args);
                if (override !== undefined) return override;
            }
            if (channel === 'storage:get-preferences') return { success: true, data: { audioMode: mode } };
            if (channel === 'storage:get-api-key') return { success: true, data: 'test-key' };
            return { success: true };
        },
    };
    const window = { addEventListener() {} };
    const context = vm.createContext({
        require: name => {
            assert.equal(name, 'electron');
            return { ipcRenderer };
        },
        process: { platform },
        window,
        AudioContext,
        navigator: { mediaDevices },
        document: { querySelector: () => app, readyState: 'loading', addEventListener() {}, createElement },
        console: { log() {}, warn() {}, error() {} },
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout,
        Uint8Array,
        Int16Array,
        FileReader: FileReaderClass,
        btoa: value => Buffer.from(value, 'binary').toString('base64'),
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/utils/renderer.js'), 'utf8'), context);
    return { api: window.cheatingDaddy, screenshot: window.captureManualScreenshot, listeners, calls, contexts, app };
}

test('microphone only on macOS skips native system capture and releases every resource', async () => {
    const screen = makeStream();
    const mic = makeStream(true);
    let displayOptions;
    const harness = loadRenderer({
        mediaDevices: {
            async getDisplayMedia(options) {
                displayOptions = options;
                return screen;
            },
            async getUserMedia() {
                return mic;
            },
        },
    });
    assert.equal(await harness.api.startCapture(), true);
    assert.equal(displayOptions.audio, false);
    assert.equal(
        harness.calls.some(call => call.channel === 'start-macos-audio'),
        false
    );
    harness.api.stopCapture();
    assert.equal(screen.videoTrack.stopped, true);
    assert.equal(mic.audioTrack.stopped, true);
    assert.equal(harness.contexts.length, 1);
    assert.equal(harness.contexts[0].closed, true);
});

test('Windows dual capture closes both streams and both audio contexts after provider failure', async () => {
    const screen = makeStream(true);
    const mic = makeStream(true);
    const harness = loadRenderer({
        platform: 'win32',
        mode: 'both',
        mediaDevices: {
            async getDisplayMedia() {
                return screen;
            },
            async getUserMedia() {
                return mic;
            },
        },
    });
    assert.equal(await harness.api.startCapture(), true);
    harness.listeners.get('provider-session-ended')({}, { reason: 'Quota exhausted' });
    assert.equal(harness.app.ended, 'Quota exhausted');
    assert.equal(screen.audioTrack.stopped, true);
    assert.equal(mic.audioTrack.stopped, true);
    assert.equal(harness.contexts.length, 2);
    assert.equal(
        harness.contexts.every(context => context.closed),
        true
    );
});

test('denied microphone permission rolls back the screen stream', async () => {
    const screen = makeStream();
    const harness = loadRenderer({
        mediaDevices: {
            async getDisplayMedia() {
                return screen;
            },
            async getUserMedia() {
                throw new Error('Permission denied');
            },
        },
    });
    assert.equal(await harness.api.startCapture(), false);
    assert.equal(screen.videoTrack.stopped, true);
    assert.match(harness.app.status, /Permission denied/);
});

test('ending session while permission prompt is pending prevents late capture startup', async () => {
    const screen = makeStream();
    let release;
    const permission = new Promise(resolve => {
        release = resolve;
    });
    const harness = loadRenderer({ mediaDevices: { getDisplayMedia: () => permission } });
    const start = harness.api.startCapture();
    await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    release(screen);
    assert.equal(await start, false);
    assert.equal(screen.videoTrack.stopped, true);
    assert.equal(harness.contexts.length, 0);
});

test('failed Gemini initialization returns false and preserves the actionable main-process error', async () => {
    let harness;
    harness = loadRenderer({
        invokeOverride(channel) {
            if (channel === 'initialize-gemini') {
                harness.listeners.get('update-status')({}, 'Error: API key is invalid.');
                return false;
            }
        },
    });
    assert.equal(await harness.api.initializeGemini(), false);
    assert.equal(harness.app.status, 'Error: API key is invalid.');
});

test('Windows microphone only does not request loopback audio', async () => {
    let options;
    const harness = loadRenderer({
        platform: 'win32',
        mediaDevices: {
            async getDisplayMedia(value) {
                options = value;
                return makeStream();
            },
            async getUserMedia() {
                return makeStream(true);
            },
        },
    });
    assert.equal(await harness.api.startCapture(), true);
    assert.equal(options.audio, false);
    harness.api.stopCapture();
});

function makeScreenshotEnvironment({ play, blob, read, width = 1920, height = 1080 } = {}) {
    const canvases = [];
    const videos = [];
    const readers = [];
    const imageData = 'data:image/jpeg;base64,' + 'a'.repeat(160);
    return {
        canvases,
        videos,
        readers,
        createElement(type) {
            if (type === 'video') {
                const video = {
                    videoWidth: width,
                    videoHeight: height,
                    readyState: 2,
                    play: play || (() => Promise.resolve()),
                    pause() {},
                    addEventListener() {},
                    removeEventListener() {},
                };
                videos.push(video);
                return video;
            }
            assert.equal(type, 'canvas');
            const canvas = {
                getContext: () => ({ drawImage() {} }),
                toBlob(callback, mimeType, quality) {
                    canvas.mimeType = mimeType;
                    canvas.quality = quality;
                    if (blob) blob(callback);
                    else callback({});
                },
            };
            canvases.push(canvas);
            return canvas;
        },
        FileReaderClass: class {
            readAsDataURL() {
                readers.push(this);
                const complete = () => {
                    this.result = imageData;
                    this.onload();
                };
                if (read) read(complete);
                else complete();
            }
        },
    };
}

function screenshotHarness(environment, invokeOverride) {
    return loadRenderer({
        platform: 'win32',
        mediaDevices: {
            async getDisplayMedia() {
                return makeStream();
            },
            async getUserMedia() {
                return makeStream(true);
            },
        },
        createElement: environment.createElement,
        FileReaderClass: environment.FileReaderClass,
        invokeOverride,
    });
}

test('stopping capture while the screenshot video starts cancels cleanly without using cleared globals', async () => {
    let releaseVideo;
    const environment = makeScreenshotEnvironment({
        play: () =>
            new Promise(resolve => {
                releaseVideo = resolve;
            }),
    });
    const harness = screenshotHarness(environment);
    await harness.api.startCapture();
    const screenshot = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    releaseVideo();
    assert.equal(await screenshot, false);
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content'),
        false
    );
    assert.equal(harness.app.responses.length, 0);
});

test('a canceled JPEG callback cannot send an old screen into a new session or unlock its active screenshot', async () => {
    const callbacks = [];
    const environment = makeScreenshotEnvironment({ blob: callback => callbacks.push(callback) });
    const harness = screenshotHarness(environment);
    await harness.api.startCapture();
    const previous = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    await harness.api.startCapture();
    const current = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(callbacks.length, 2);
    callbacks[0]({});
    assert.equal(await previous, false);
    assert.equal(await harness.screenshot(), false);
    assert.match(harness.app.status, /already being processed/);
    callbacks[1]({});
    assert.equal(await current, true);
    const requests = harness.calls.filter(call => call.channel === 'send-image-content');
    assert.equal(requests.length, 1);
    assert.match(requests[0].args[0].prompt, /practice question/);
    assert.equal(environment.canvases[1].width, 1920);
    assert.equal(environment.canvases[1].height, 1080);
    harness.api.stopCapture();
});

test('late FileReader completion after capture stops never reaches the provider', async () => {
    let releaseReader;
    const environment = makeScreenshotEnvironment({
        read: complete => {
            releaseReader = complete;
        },
    });
    const harness = screenshotHarness(environment);
    await harness.api.startCapture();
    const screenshot = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    releaseReader();
    assert.equal(await screenshot, false);
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content'),
        false
    );
});

test('repeated screenshot presses issue one request and provider completion releases the gate', async () => {
    let releaseProvider;
    let delayed = true;
    const environment = makeScreenshotEnvironment();
    const harness = screenshotHarness(environment, channel => {
        if (channel === 'send-image-content' && delayed)
            return new Promise(resolve => {
                releaseProvider = resolve;
            });
    });
    await harness.api.startCapture();
    const first = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await harness.screenshot(), false);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    releaseProvider({ success: true });
    assert.equal(await first, true);
    delayed = false;
    assert.equal(await harness.screenshot(), true);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 2);
    harness.api.stopCapture();
});

test('provider rejection reports an actionable screenshot error and permits retry', async () => {
    const environment = makeScreenshotEnvironment();
    let failed = true;
    const harness = screenshotHarness(environment, channel => {
        if (channel === 'send-image-content' && failed) return Promise.reject(new Error('Network unavailable. Check your connection.'));
    });
    await harness.api.startCapture();
    assert.equal(await harness.screenshot(), false);
    assert.match(harness.app.status, /Network unavailable.*Check your connection/);
    assert.equal(harness.app.responses.length, 1);
    failed = false;
    assert.equal(await harness.screenshot(), true);
    harness.api.stopCapture();
});

test('screenshot quality preserves small text with bounded dimensions for every setting', async () => {
    const environment = makeScreenshotEnvironment({ width: 3840, height: 2160 });
    const harness = screenshotHarness(environment);
    await harness.api.startCapture();
    for (const [quality, width, height, jpeg] of [
        ['high', 2560, 1440, 0.95],
        ['medium', 1920, 1080, 0.88],
        ['low', 1280, 720, 0.7],
    ]) {
        assert.equal(await harness.screenshot(quality), true);
        const canvas = environment.canvases.at(-1);
        assert.equal(canvas.width, width);
        assert.equal(canvas.height, height);
        assert.equal(canvas.mimeType, 'image/jpeg');
        assert.equal(canvas.quality, jpeg);
    }
    harness.api.stopCapture();
});

test('screen-only capture requests neither microphone nor system audio and survives unrelated Live failures', async () => {
    const screen = makeStream();
    let displayOptions;
    const harness = loadRenderer({
        mode: 'both',
        mediaDevices: {
            async getDisplayMedia(options) {
                displayOptions = options;
                return screen;
            },
            async getUserMedia() {
                throw new Error('Microphone must not be requested');
            },
        },
    });
    assert.equal(await harness.api.startCapture(5, 'medium', true), true);
    assert.equal(displayOptions.audio, false);
    assert.equal(harness.contexts.length, 0);
    assert.equal(
        harness.calls.some(call => call.channel === 'start-macos-audio'),
        false
    );
    harness.listeners.get('provider-session-ended')({}, { reason: 'Old Live connection ended' });
    assert.equal(screen.videoTrack.stopped, false);
    harness.api.stopCapture();
    assert.equal(screen.videoTrack.stopped, true);
});

test('typed follow-up in screen-only mode analyzes the current screen without opening Live', async () => {
    const environment = makeScreenshotEnvironment();
    const harness = screenshotHarness(environment);
    assert.equal(await harness.api.startCapture(5, 'medium', true), true);
    const result = await harness.api.sendTextMessage('Explain option B');
    assert.equal(result.success, true);
    assert.equal(result.completed, true);
    const request = harness.calls.find(call => call.channel === 'send-image-content');
    assert.equal(request.args[0].prompt, 'Explain option B');
    assert.equal(
        harness.calls.some(call => call.channel === 'send-text-message' || call.channel === 'initialize-gemini'),
        false
    );
    harness.api.stopCapture();
});
