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

function loadRenderer({
    platform = 'darwin',
    mode = 'mic_only',
    mediaDevices,
    invokeOverride,
    createElement,
    FileReaderClass,
    reviewFrameChecker,
    reviewTrackerBytes,
    intervalTimers,
    frameClock,
} = {}) {
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
            if (name === './utils/reviewFrame') {
                return {
                    createReviewFrameTracker: (snapshot, answer) => ({
                        retainedBytes: reviewTrackerBytes ?? snapshot.data.byteLength,
                        locate(frame) {
                            const result = reviewFrameChecker ? reviewFrameChecker(snapshot, frame, answer) : true;
                            if (result === true) return { state: 'matched', offset: { x: 0, y: 0 }, reviewAnswer: answer };
                            if (result === false) return { state: 'hidden', reason: 'unmatched' };
                            return result;
                        },
                    }),
                };
            }
            assert.equal(name, 'electron');
            return { ipcRenderer };
        },
        process: { platform },
        window,
        AudioContext,
        navigator: { mediaDevices },
        document: { querySelector: () => app, readyState: 'loading', addEventListener() {}, createElement },
        console: { log() {}, warn() {}, error() {} },
        setInterval: intervalTimers?.setInterval || setInterval,
        clearInterval: intervalTimers?.clearInterval || clearInterval,
        setTimeout,
        clearTimeout,
        performance: frameClock,
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

test('macOS Screen Recording denial explains the real OS permission and does not start audio', async () => {
    const harness = loadRenderer({
        mediaDevices: {
            async getDisplayMedia() {
                const error = new Error('Permission denied');
                error.name = 'NotAllowedError';
                throw error;
            },
            async getUserMedia() {
                assert.fail('Microphone capture must not start after screen permission denial');
            },
        },
    });
    assert.equal(await harness.api.startCapture(), false);
    assert.match(harness.app.status, /System Settings > Privacy & Security > Screen & System Audio Recording/);
    assert.equal(
        harness.calls.some(call => call.channel === 'start-macos-audio'),
        false
    );
    assert.equal(harness.contexts.length, 0);
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
                const error = new Error('Permission denied');
                error.name = 'NotAllowedError';
                throw error;
            },
        },
    });
    assert.equal(await harness.api.startCapture(), false);
    assert.equal(screen.videoTrack.stopped, true);
    assert.match(harness.app.status, /Permission denied/);
    assert.doesNotMatch(harness.app.status, /Screen & System Audio Recording/);
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
    assert.equal(options.video.frameRate, 1);
    harness.api.stopCapture();
});

function makeScreenshotEnvironment({ play, blob, read, frame, frameData, frameCallbacks = true, width = 1920, height = 1080 } = {}) {
    const canvases = [];
    const videos = [];
    const readers = [];
    const imageData = 'data:image/jpeg;base64,' + 'a'.repeat(160);
    let frameTime = 0;
    return {
        canvases,
        videos,
        readers,
        frameClock: { now: () => frameTime },
        createElement(type) {
            if (type === 'video') {
                let callbackId = 0;
                const callbacks = new Map();
                const listeners = new Map();
                const video = {
                    videoWidth: width,
                    videoHeight: height,
                    readyState: 2,
                    currentTime: 0,
                    play: play || (() => Promise.resolve()),
                    pause() {},
                    addEventListener(type, callback) {
                        if (!listeners.has(type)) listeners.set(type, new Set());
                        listeners.get(type).add(callback);
                    },
                    removeEventListener(type, callback) {
                        listeners.get(type)?.delete(callback);
                    },
                    emit(type) {
                        if (type === 'timeupdate') frameTime += 200;
                        for (const callback of listeners.get(type) || []) callback();
                    },
                    listeners,
                    requestVideoFrameCallback(callback) {
                        const id = ++callbackId;
                        callbacks.set(id, callback);
                        const complete = (metadata = {}) => {
                            if (!callbacks.delete(id)) return;
                            video.currentTime += 1;
                            frameTime += 200;
                            callback(frameTime, { mediaTime: video.currentTime, captureTime: frameTime, ...metadata });
                        };
                        if (frame) frame(complete);
                        else setImmediate(complete);
                        return id;
                    },
                    cancelVideoFrameCallback(id) {
                        video.canceledFrames = (video.canceledFrames || 0) + 1;
                        callbacks.delete(id);
                    },
                };
                if (!frameCallbacks) delete video.requestVideoFrameCallback;
                videos.push(video);
                return video;
            }
            assert.equal(type, 'canvas');
            const canvas = {
                getContext: () => ({
                    drawImage() {},
                    getImageData: () => ({
                        width: canvas.width,
                        height: canvas.height,
                        data: frameData ? frameData() : new Uint8ClampedArray(16),
                    }),
                }),
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

function screenshotHarness(environment, invokeOverride, reviewFrameChecker, intervalTimers, reviewTrackerBytes) {
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
        reviewFrameChecker,
        intervalTimers,
        reviewTrackerBytes,
        frameClock: environment.frameClock,
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

test('requesting a new screenshot while viewing history follows the latest answer before streaming starts', async () => {
    const environment = makeScreenshotEnvironment();
    let harness;
    let sent = false;
    harness = screenshotHarness(environment, channel => {
        if (channel === 'send-image-content') {
            sent = true;
            assert.equal(harness.app.currentResponseIndex, 1);
        }
    });
    harness.app.responses = ['Earlier answer', 'Most recent answer'];
    harness.app.currentResponseIndex = 0;
    await harness.api.startCapture(5, 'medium', true);
    assert.equal(await harness.screenshot(), true);
    assert.equal(sent, true);
    harness.api.stopCapture();
});

test('a main-process screenshot skipped during session handoff is not presented as a completed answer', async () => {
    for (const code of ['busy', 'cancelled']) {
        const environment = makeScreenshotEnvironment();
        let skipped = true;
        const harness = screenshotHarness(environment, channel => {
            if (channel === 'send-image-content' && skipped) return { success: true, skipped: true, code };
        });
        await harness.api.startCapture(5, 'medium', true);
        assert.equal(await harness.screenshot(), false);
        assert.notEqual(harness.app.status, 'Screen ready');
        assert.match(harness.app.status, code === 'busy' ? /previous request is finishing/ : /canceled/);
        assert.equal(harness.app.responses.length, 0);
        skipped = false;
        assert.equal(await harness.screenshot(), true);
        assert.equal(harness.app.status, 'Screen ready');
        harness.api.stopCapture();
    }
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

const REVIEW_CAPTURE_TOKEN = {
    captureId: 'capture-1',
    requestId: 'request-1',
    display: { id: 'display-1', bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, rotation: 0 },
};
const REVIEW_ANSWER = {
    questionBox: [0, 0, 1000, 1000],
    answers: [{ label: 'A', box: [100, 100, 130, 130] }],
    confidence: 0.99,
};

function reviewHarness(environment, override, checker, intervalTimers, reviewTrackerBytes) {
    return screenshotHarness(
        environment,
        (channel, args) => {
            const result = override?.(channel, args);
            if (result !== undefined) return result;
            if (channel === 'review:prepare-capture') return REVIEW_CAPTURE_TOKEN;
            if (channel === 'send-image-content') return { success: true, reviewAnswer: REVIEW_ANSWER };
            if (channel === 'review:reuse-answer') return { success: true, reviewAnswer: REVIEW_ANSWER };
        },
        checker,
        intervalTimers,
        reviewTrackerBytes
    );
}

test('screen initialization explicitly selects review or text without changing the profile', async () => {
    const harness = loadRenderer();
    await harness.api.initializeScreenSession('exam', true);
    await harness.api.initializeScreenSession('interview');
    const requests = harness.calls.filter(call => call.channel === 'initialize-screen-session');
    assert.deepEqual(Array.from(requests[0].args), ['exam', '', 'test-review']);
    assert.deepEqual(Array.from(requests[1].args), ['interview', '', 'text']);
});

test('review mode begins only after the screen stream is ready and requests no audio', async () => {
    let release;
    const stream = makeStream();
    const permission = new Promise(resolve => {
        release = resolve;
    });
    let options;
    const harness = loadRenderer({
        platform: 'win32',
        mode: 'both',
        mediaDevices: {
            getDisplayMedia(value) {
                options = value;
                return permission;
            },
            getUserMedia() {
                assert.fail('Test Review must not open the microphone');
            },
        },
    });
    const start = harness.api.startCapture(5, 'medium', false, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
        harness.calls.some(call => call.channel === 'review:begin'),
        false
    );
    release(stream);
    assert.equal(await start, true);
    assert.equal(options.audio, false);
    assert.equal(options.video.frameRate, 5);
    assert.equal(harness.calls.filter(call => call.channel === 'review:begin').length, 1);
    assert.equal(harness.contexts.length, 0);
    harness.api.stopCapture();
    assert.equal(harness.calls.filter(call => call.channel === 'review:end').length, 1);
});

test('canceling review while screen permission is pending prevents a late overlay startup', async () => {
    let release;
    const stream = makeStream();
    const harness = loadRenderer({
        mediaDevices: {
            getDisplayMedia: () => new Promise(resolve => (release = resolve)),
        },
    });
    const start = harness.api.startCapture(5, 'medium', true, true);
    await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    release(stream);
    assert.equal(await start, false);
    assert.equal(stream.videoTrack.stopped, true);
    assert.equal(
        harness.calls.some(call => call.channel === 'review:begin'),
        false
    );
});

test('review capture waits for fresh frames, sends display geometry, and validates the screen before showing cached markers', async () => {
    const pendingFrames = [];
    let queuedOverlayVisible = true;
    const environment = makeScreenshotEnvironment({
        frame: callback => pendingFrames.push(callback),
        frameData: () => Uint8ClampedArray.from([queuedOverlayVisible ? 1 : 2, 0, 0, 255]),
    });
    const comparisons = [];
    const harness = reviewHarness(environment, undefined, (...args) => {
        comparisons.push(args);
        return true;
    });
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pendingFrames.length, 1);
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content'),
        false
    );
    pendingFrames.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content'),
        false,
        'The first queued frame may still contain the overlay'
    );
    assert.equal(environment.readers.length, 0);
    queuedOverlayVisible = false;
    pendingFrames.shift()();
    await new Promise(resolve => setImmediate(resolve));
    const request = harness.calls.find(call => call.channel === 'send-image-content').args[0];
    assert.deepEqual(request.reviewCapture, REVIEW_CAPTURE_TOKEN);
    assert.equal(request.imageWidth, 1920);
    assert.equal(request.imageHeight, 1080);
    assert.equal(request.prompt, undefined);
    assert.equal(pendingFrames.length, 1);
    assert.equal(
        harness.calls.some(call => call.channel === 'review:show-answer'),
        false
    );
    pendingFrames.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
        harness.calls.some(call => call.channel === 'review:show-answer'),
        false,
        'One queued status-notice frame must not publish markers'
    );
    pendingFrames.shift()();
    assert.equal(await capture, true);
    assert.equal(comparisons.length, 1);
    assert.deepEqual(comparisons[0][2], REVIEW_ANSWER);
    assert.equal(comparisons[0][0].data[0], 2);
    assert.equal(harness.calls.filter(call => call.channel === 'review:show-answer').length, 1);
    assert.equal(harness.app.responses.length, 0);
    harness.api.stopCapture();
});

test('ending review during a fresh-frame wait cancels the callback and never sends the screenshot', async () => {
    const pendingFrames = [];
    const environment = makeScreenshotEnvironment({ frame: callback => pendingFrames.push(callback) });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    assert.equal(await capture, false);
    assert.equal(environment.videos[0].canceledFrames, 1);
    pendingFrames[0]();
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content' || call.channel === 'review:show-answer'),
        false
    );
    assert.equal(harness.app.responses.length, 0);
});

test('review ignores a video frame captured before the window was hidden even when it arrives afterward', async () => {
    const pendingFrames = [];
    const environment = makeScreenshotEnvironment({ frame: callback => pendingFrames.push(callback) });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    pendingFrames.shift()({ captureTime: -1 });
    pendingFrames.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content'),
        false
    );
    pendingFrames.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    pendingFrames.shift()();
    pendingFrames.shift()();
    assert.equal(await capture, true);
    harness.api.stopCapture();
});

test('canceling review after the first advancing frame cancels the second frame and cannot restart the wait', async () => {
    const pendingFrames = [];
    const environment = makeScreenshotEnvironment({ frame: callback => pendingFrames.push(callback) });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    pendingFrames.shift()();
    harness.api.stopCapture();
    assert.equal(await capture, false);
    assert.equal(environment.videos[0].canceledFrames, 1);
    pendingFrames.shift()();
    assert.equal(pendingFrames.length, 0);
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content'),
        false
    );
});

test('an unmatched screen after AI processing keeps the cached review hidden for scroll-back without showing markers', async () => {
    const environment = makeScreenshotEnvironment();
    const harness = reviewHarness(environment, undefined, () => false);
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    assert.equal(
        harness.calls.some(call => call.channel === 'review:show-answer'),
        false
    );
    const hidden = harness.calls.find(call => call.channel === 'review:hide-answer');
    assert.deepEqual(hidden.args[0], REVIEW_CAPTURE_TOKEN);
    assert.equal(
        harness.calls.some(call => call.channel === 'review:clear'),
        false
    );
    assert.match(harness.app.status, /Question is off screen/);
    assert.equal(harness.app.responses.length, 0);
    harness.api.stopCapture();
});

test('review watchdog moves markers with scrolling, hides unmatched questions, and restores cached markers without AI calls', async () => {
    const timers = [];
    const intervalTimers = {
        setInterval(callback, interval) {
            assert.equal(interval, 500);
            const timer = { callback, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearInterval(timer) {
            timer.cleared = true;
        },
    };
    let location = { state: 'matched', offset: { x: 0, y: 0 }, reviewAnswer: REVIEW_ANSWER };
    const harness = reviewHarness(makeScreenshotEnvironment(), undefined, () => location, intervalTimers);
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    const oldTimer = timers[0];
    assert.equal(await harness.screenshot(), true);
    assert.equal(oldTimer.cleared, true);
    oldTimer.callback();
    assert.equal(
        harness.calls.some(call => call.channel === 'review:clear'),
        false
    );
    location = { state: 'matched', offset: { x: 0, y: -25 }, reviewAnswer: REVIEW_ANSWER };
    timers[1].callback();
    timers[1].callback();
    const moves = harness.calls.filter(call => call.channel === 'review:move-answer');
    assert.equal(moves.length, 1);
    assert.deepEqual(moves[0].args, [REVIEW_CAPTURE_TOKEN, location.offset]);
    location = { state: 'hidden', reason: 'unmatched' };
    timers[1].callback();
    timers[1].callback();
    assert.equal(harness.calls.filter(call => call.channel === 'review:hide-answer').length, 1);
    assert.equal(timers[1].cleared, false);
    assert.match(harness.app.status, /Question is off screen/);
    location = { state: 'matched', offset: { x: 0, y: 0 }, reviewAnswer: REVIEW_ANSWER };
    timers[1].callback();
    assert.equal(harness.calls.filter(call => call.channel === 'review:move-answer').length, 2);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    assert.equal(harness.calls.filter(call => call.channel === 'review:clear').length, 0);
    harness.api.stopCapture();
    assert.equal(timers[1].cleared, true);
});

test('review provider errors remain session status errors and never append a text response', async () => {
    const harness = reviewHarness(makeScreenshotEnvironment(), channel => {
        if (channel === 'send-image-content') return { success: false, error: 'Quota exhausted. Try another configured provider.' };
    });
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), false);
    assert.match(harness.app.status, /Quota exhausted/);
    assert.equal(harness.app.responses.length, 0);
    assert.equal(
        harness.calls.some(call => call.channel === 'review:show-answer'),
        false
    );
    assert.equal(harness.calls.filter(call => call.channel === 'review:clear').length, 1);
    harness.api.stopCapture();
});

test('canceling review during AI processing cannot display a late answer or start a watchdog', async () => {
    let release;
    const harness = reviewHarness(makeScreenshotEnvironment(), channel => {
        if (channel === 'send-image-content') return new Promise(resolve => (release = resolve));
    });
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    release({ success: true, reviewAnswer: REVIEW_ANSWER });
    assert.equal(await capture, false);
    assert.equal(
        harness.calls.some(call => call.channel === 'review:show-answer'),
        false
    );
    assert.equal(harness.app.responses.length, 0);
});

test('review falls back to advancing loaded video frames when requestVideoFrameCallback is unavailable', async () => {
    const environment = makeScreenshotEnvironment({ frameCallbacks: false });
    const advance = () =>
        setImmediate(() => {
            const video = environment.videos[0];
            video.currentTime += 1;
            video.emit('timeupdate');
            setImmediate(() => {
                video.currentTime += 1;
                video.emit('timeupdate');
            });
        });
    const harness = reviewHarness(environment, channel => {
        if (channel === 'review:prepare-capture' || channel === 'send-image-content') advance();
    });
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    assert.equal(
        [...environment.videos[0].listeners.values()].every(listeners => listeners.size === 0),
        true
    );
    harness.api.stopCapture();
});

test('canceling a fallback review frame wait removes its event listeners without sending an image', async () => {
    const environment = makeScreenshotEnvironment({ frameCallbacks: false });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    assert.equal(await capture, false);
    assert.equal(
        [...environment.videos[0].listeners.values()].every(listeners => listeners.size === 0),
        true
    );
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content'),
        false
    );
});

test('a repeated practice question reuses a validated cached answer without JPEG encoding or an AI request', async () => {
    let sequence = 0;
    const environment = makeScreenshotEnvironment();
    const harness = reviewHarness(environment, channel => {
        if (channel === 'review:prepare-capture') return { ...REVIEW_CAPTURE_TOKEN, requestId: `request-${++sequence}` };
    });
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    assert.equal(await harness.screenshot(), true);
    const calls = harness.calls;
    assert.equal(calls.filter(call => call.channel === 'send-image-content').length, 1);
    assert.equal(environment.readers.length, 1);
    assert.equal(environment.canvases[1].mimeType, undefined);
    const reused = calls.find(call => call.channel === 'review:reuse-answer');
    assert.equal(reused.args[0].requestId, 'request-2');
    assert.equal(reused.args[1].requestId, 'request-1');
    assert.deepEqual(reused.args[2], { x: 0, y: 0 });
    assert.equal(calls.filter(call => call.channel === 'review:show-answer').length, 2);
    harness.api.stopCapture();
});

test('canceling a cached review lookup cannot redraw an old answer or fall back to the provider', async () => {
    let release;
    let reusePending = false;
    const harness = reviewHarness(makeScreenshotEnvironment(), channel => {
        if (channel === 'review:reuse-answer' && reusePending) return new Promise(resolve => (release = resolve));
    });
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    reusePending = true;
    const capture = harness.screenshot();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    release({ success: true, reviewAnswer: REVIEW_ANSWER });
    assert.equal(await capture, false);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    assert.equal(harness.calls.filter(call => call.channel === 'review:show-answer').length, 1);
});

test('a missing main-process cache entry falls back to exactly one provider request', async () => {
    const harness = reviewHarness(makeScreenshotEnvironment(), channel => {
        if (channel === 'review:reuse-answer') return { success: false, error: 'Cached answer is no longer available' };
    });
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    assert.equal(await harness.screenshot(), true);
    assert.equal(harness.calls.filter(call => call.channel === 'review:reuse-answer').length, 1);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 2);
    harness.api.stopCapture();
});

test('local review cache retains at most three distinct questions and clears when the session stops', async () => {
    let question = 1;
    const environment = makeScreenshotEnvironment({ frameData: () => Uint8ClampedArray.from([question, 0, 0, 255]) });
    const harness = reviewHarness(environment, undefined, (snapshot, frame) => snapshot.data[0] === frame.data[0]);
    await harness.api.startCapture(5, 'medium', true, true);
    for (question = 1; question <= 4; question++) assert.equal(await harness.screenshot(), true);
    question = 2;
    assert.equal(await harness.screenshot(), true);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 4);
    question = 1;
    assert.equal(await harness.screenshot(), true);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 5);
    harness.api.stopCapture();
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 6);
    harness.api.stopCapture();
});

test('review cache respects the tracker retained-memory estimate within its 32 MB budget', async () => {
    let question = 1;
    const environment = makeScreenshotEnvironment({ frameData: () => Uint8ClampedArray.from([question, 0, 0, 255]) });
    const harness = reviewHarness(environment, undefined, (snapshot, frame) => snapshot.data[0] === frame.data[0], undefined, 17 * 1024 * 1024);
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    question = 2;
    assert.equal(await harness.screenshot(), true);
    question = 1;
    assert.equal(await harness.screenshot(), true);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 3);
    assert.equal(
        harness.calls.some(call => call.channel === 'review:reuse-answer'),
        false
    );
    harness.api.stopCapture();
});

test('unexpected Test Review ending releases the screen, watchdog and local cache while ignoring unrelated Live failures', async () => {
    const timers = [];
    const intervalTimers = {
        setInterval(callback) {
            const timer = { callback, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearInterval(timer) {
            timer.cleared = true;
        },
    };
    const environment = makeScreenshotEnvironment();
    const harness = reviewHarness(environment, undefined, undefined, intervalTimers);
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    const stream = environment.videos[0].srcObject;
    harness.listeners.get('provider-session-ended')({}, { reason: 'Unrelated old Live quota error' });
    assert.equal(stream.videoTrack.stopped, false);
    assert.equal(timers[0].cleared, false);
    assert.equal(harness.app.ended, undefined);
    harness.listeners.get('provider-session-ended')({}, { code: 'test_review', reason: 'Display configuration changed. Start Test Review again.' });
    assert.equal(stream.videoTrack.stopped, true);
    assert.equal(timers[0].cleared, true);
    assert.match(harness.app.ended, /Display configuration changed/);
    assert.equal(harness.calls.filter(call => call.channel === 'review:end').length, 1);
    const previousMoves = harness.calls.filter(call => call.channel === 'review:move-answer').length;
    timers[0].callback();
    assert.equal(harness.calls.filter(call => call.channel === 'review:move-answer').length, previousMoves);
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 2);
    assert.equal(
        harness.calls.some(call => call.channel === 'review:reuse-answer'),
        false
    );
    harness.api.stopCapture();
});

test('unexpected Test Review ending during an AI request blocks its late answer from reopening the overlay', async () => {
    let release;
    const environment = makeScreenshotEnvironment();
    const harness = reviewHarness(environment, channel => {
        if (channel === 'send-image-content') return new Promise(resolve => (release = resolve));
    });
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const stream = environment.videos[0].srcObject;
    harness.listeners.get('provider-session-ended')({}, { code: 'test_review', reason: 'Test Review overlay closed.' });
    release({ success: true, reviewAnswer: REVIEW_ANSWER });
    assert.equal(await capture, false);
    assert.equal(stream.videoTrack.stopped, true);
    assert.equal(
        harness.calls.some(call => call.channel === 'review:show-answer'),
        false
    );
    assert.equal(harness.calls.filter(call => call.channel === 'review:end').length, 1);
    assert.match(harness.app.ended, /overlay closed/);
});
