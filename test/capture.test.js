const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function makeStream(audio = false) {
    const listeners = new Map();
    const videoTrack = {
        stopped: false,
        stop() {
            this.stopped = true;
        },
        addEventListener(event, callback) {
            listeners.set(event, callback);
        },
        emitEnded() {
            listeners.get('ended')?.();
        },
        async applyConstraints(constraints) {
            this.constraints = constraints;
        },
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
    ImageCaptureClass,
    reviewFrameChecker,
    reviewTrackerBytes,
    intervalTimers,
    timeoutTimers,
    frameClock,
} = {}) {
    const listeners = new Map();
    const windowListeners = new Map();
    const calls = [];
    const contexts = [];
    const warnings = [];
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
    const window = { addEventListener: (event, callback) => windowListeners.set(event, callback) };
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
        console: { log() {}, warn: (...args) => warnings.push(args), error() {} },
        setInterval: intervalTimers?.setInterval || setInterval,
        clearInterval: intervalTimers?.clearInterval || clearInterval,
        setTimeout: timeoutTimers?.setTimeout || setTimeout,
        clearTimeout: timeoutTimers?.clearTimeout || clearTimeout,
        performance: frameClock,
        Uint8Array,
        Int16Array,
        FileReader: FileReaderClass,
        ImageCapture: ImageCaptureClass,
        btoa: value => Buffer.from(value, 'binary').toString('base64'),
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/utils/renderer.js'), 'utf8'), context);
    return { api: window.cheatingDaddy, screenshot: window.captureManualScreenshot, listeners, windowListeners, calls, contexts, warnings, app };
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

function failingScreenCapture({ name = 'AbortError', message = 'Invalid capture constraints', diagnostics, platform = 'darwin' } = {}) {
    let acquisitions = 0;
    const harness = loadRenderer({
        platform,
        mediaDevices: {
            async getDisplayMedia() {
                acquisitions += 1;
                const error = new Error(message);
                error.name = name;
                throw error;
            },
            getUserMedia() {
                assert.fail('A failed screen request must not open audio capture');
            },
        },
        invokeOverride(channel) {
            if (channel === 'screen-capture:diagnostics' && diagnostics instanceof Error) return Promise.reject(diagnostics);
            if (channel === 'screen-capture:diagnostics') return diagnostics;
        },
    });
    return { ...harness, acquisitions: () => acquisitions };
}

for (const permissionStatus of ['denied', 'restricted']) {
    test(`macOS native capture rejection with ${permissionStatus} permission gives permission help without reacquiring`, async () => {
        const harness = failingScreenCapture({ diagnostics: { permissionStatus, failure: null } });
        assert.equal(await harness.api.startCapture(5, 'medium', true, true), false);
        assert.match(harness.app.status, /Allow Honest Father.*Screen & System Audio Recording.*restart/);
        assert.doesNotMatch(harness.app.status, /permission is enabled|Invalid capture constraints/);
        assert.equal(harness.acquisitions(), 1);
        assert.equal(
            harness.calls.some(call => call.channel === 'review:begin' || call.channel === 'start-macos-audio'),
            false
        );
    });
}

test('macOS AbortError with granted permission prioritizes a full restart before changing the installed app entry', async () => {
    const harness = failingScreenCapture({ diagnostics: { permissionStatus: 'granted', failure: null } });
    assert.equal(await harness.api.startCapture(5, 'medium', true, true), false);
    assert.match(harness.app.status, /could not start screen capture even though Screen Recording permission is enabled/);
    assert.match(harness.app.status, /Quit Honest Father completely and reopen it\. If this continues/);
    assert.match(harness.app.status, /remove Honest Father, add the installed app again, then restart/);
    assert.doesNotMatch(harness.app.status, /Allow Honest Father|Invalid capture constraints/);
    assert.equal(harness.acquisitions(), 1);
});

test('fresh native source diagnostics are normalized and included without misreporting granted permission', async () => {
    const harness = failingScreenCapture({
        name: 'NotReadableError',
        message: 'The native screen stream could not start',
        diagnostics: {
            permissionStatus: 'granted',
            failure: { code: 'source_enumeration_failed', error: 'No available\n screen\u0000 source', stage: 'sources', at: Date.now() },
        },
    });
    assert.equal(await harness.api.startCapture(5, 'medium', true), false);
    assert.match(harness.app.status, /Capture failure \(code: source_enumeration_failed, stage: sources\): No available screen source/);
    assert.match(harness.app.status, /permission is enabled/);
    assert.doesNotMatch(harness.app.status, /\u0000|\n/);
    assert.equal(harness.acquisitions(), 1);
});

for (const permissionStatus of ['denied', 'restricted']) {
    test(`macOS source enumeration failure with ${permissionStatus} access distinguishes the running copy from an old enabled entry`, async () => {
        const harness = failingScreenCapture({
            diagnostics: {
                permissionStatus,
                failure: { code: 'source_enumeration_failed', error: 'Failed to get sources.', stage: 'sources', at: Date.now() },
            },
        });
        assert.equal(await harness.api.startCapture(5, 'medium', true, true), false);
        assert.match(harness.app.status, /macOS rejected screen capture for the running copy of Honest Father/);
        assert.match(harness.app.status, /code: source_enumeration_failed, stage: sources\): Failed to get sources/);
        assert.match(harness.app.status, /enabled Honest Father entry.*may refer to an older copy/);
        assert.match(
            harness.app.status,
            /remove the old Honest Father entry, add the installed app again, then quit Honest Father completely and reopen it/
        );
        assert.doesNotMatch(harness.app.status, /Allow Honest Father|permission is enabled|Invalid capture constraints/);
        assert.equal(harness.acquisitions(), 1);
        assert.equal(
            harness.calls.some(call => call.channel === 'review:begin' || call.channel === 'start-macos-audio'),
            false
        );
    });
}

const requestFailureFixtures = [
    { code: 'invalid_request', stage: 'request', error: 'The request came from another frame' },
    { code: 'capture_cancelled', stage: 'request', error: 'The capture frame changed during source enumeration' },
    { code: 'source_selection_failed', stage: 'source-selected', error: 'The selected monitor disappeared' },
    { code: 'capture_callback_failed', stage: 'callback', error: 'The native callback frame ended' },
];
for (const permissionStatus of ['denied', 'restricted', 'granted', 'unknown', 'not-determined']) {
    for (const fixture of requestFailureFixtures) {
        test(`fresh ${fixture.code} with ${permissionStatus} permission preserves its own cause without permission repair advice`, async () => {
            const harness = failingScreenCapture({ diagnostics: { permissionStatus, failure: { ...fixture, at: Date.now() } } });
            assert.equal(await harness.api.startCapture(5, 'medium', true, true), false);
            assert.ok(harness.app.status.includes(`code: ${fixture.code}, stage: ${fixture.stage}`));
            assert.ok(harness.app.status.includes(fixture.error));
            assert.doesNotMatch(
                harness.app.status,
                /Allow Honest Father|Screen & System Audio Recording|older copy|permission is enabled|Invalid capture constraints/
            );
            assert.equal(harness.acquisitions(), 1);
            assert.equal(
                harness.calls.some(call => call.channel === 'review:begin' || call.channel === 'start-macos-audio'),
                false
            );
        });
    }
}

test('a denied screen with no available sources retains the source code and stage alongside permission help', async () => {
    const harness = failingScreenCapture({
        diagnostics: {
            permissionStatus: 'denied',
            failure: { code: 'no_screen_sources', error: 'No screen capture sources are available.', stage: 'sources', at: Date.now() },
        },
    });
    assert.equal(await harness.api.startCapture(5, 'medium', true), false);
    assert.match(harness.app.status, /code: no_screen_sources, stage: sources\): No screen capture sources are available/);
    assert.match(harness.app.status, /Allow Honest Father/);
    assert.equal(harness.acquisitions(), 1);
});

test('unknown source diagnostic codes cannot replace the current native failure', async () => {
    const harness = failingScreenCapture({
        name: 'NotReadableError',
        message: 'Current native device failure',
        diagnostics: {
            permissionStatus: 'granted',
            failure: { code: 'unrecognized_failure', error: 'Irrelevant unknown source error', stage: 'sources', at: Date.now() },
        },
    });
    assert.equal(await harness.api.startCapture(5, 'medium', true), false);
    assert.match(harness.app.status, /Current native device failure/);
    assert.doesNotMatch(harness.app.status, /unrecognized_failure|Irrelevant unknown source error|Allow Honest Father/);
    assert.equal(harness.acquisitions(), 1);
});

for (const age of ['expired', 'future']) {
    test(`${age} source diagnostics do not replace an unrelated current native capture error`, async () => {
        const harness = failingScreenCapture({
            name: 'NotReadableError',
            message: 'Current native device failure',
            diagnostics: {
                permissionStatus: 'granted',
                failure: {
                    code: 'source_enumeration_failed',
                    error: 'OLD SOURCE ERROR',
                    stage: 'sources',
                    at: Date.now() + (age === 'expired' ? -11000 : 60000),
                },
            },
        });
        assert.equal(await harness.api.startCapture(5, 'medium', true), false);
        assert.match(harness.app.status, /Current native device failure/);
        assert.doesNotMatch(harness.app.status, /OLD SOURCE ERROR|remove Honest Father|Allow Honest Father/);
        assert.equal(harness.acquisitions(), 1);
    });
}

for (const name of ['TypeError', 'InvalidStateError']) {
    test(`${name} is preserved instead of being replaced with OS permission advice`, async () => {
        const harness = failingScreenCapture({
            name,
            message: 'Current request must run from an active browser context',
            diagnostics: {
                permissionStatus: 'denied',
                failure: { code: 'source_enumeration_failed', error: 'Irrelevant source diagnostic', stage: 'sources', at: Date.now() },
            },
        });
        assert.equal(await harness.api.startCapture(5, 'medium', true), false);
        assert.match(harness.app.status, /Current request must run from an active browser context/);
        assert.doesNotMatch(harness.app.status, /Allow Honest Father|Irrelevant source diagnostic|remove Honest Father/);
        assert.equal(harness.acquisitions(), 1);
    });
}

test('missing or unavailable diagnostics translate the callback rejection without blaming illegal constraints', async () => {
    for (const diagnostics of [undefined, new Error('The diagnostic IPC is unavailable')]) {
        const harness = failingScreenCapture({ diagnostics });
        assert.equal(await harness.api.startCapture(5, 'medium', true), false);
        assert.match(harness.app.status, /macOS could not provide the screen stream/);
        assert.doesNotMatch(harness.app.status, /Invalid capture constraints|Allow Honest Father/);
        assert.equal(harness.acquisitions(), 1);
    }
});

test('stopping capture while diagnostic IPC is pending suppresses late failure advice and review startup', async () => {
    let resolveDiagnostics;
    const harness = loadRenderer({
        mediaDevices: {
            async getDisplayMedia() {
                const error = new Error('Invalid capture constraints');
                error.name = 'AbortError';
                throw error;
            },
        },
        invokeOverride(channel) {
            if (channel === 'screen-capture:diagnostics') return new Promise(resolve => (resolveDiagnostics = resolve));
        },
    });
    const start = harness.api.startCapture(5, 'medium', true, true);
    while (!resolveDiagnostics) await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    resolveDiagnostics({ permissionStatus: 'granted', failure: null });
    assert.equal(await start, false);
    assert.equal(harness.app.status, '');
    assert.equal(
        harness.calls.some(call => call.channel === 'review:begin'),
        false
    );
});

test('Windows capture failures preserve their original reason without consulting macOS diagnostic IPC', async () => {
    const harness = failingScreenCapture({ platform: 'win32', message: 'The Windows screen source is unavailable' });
    assert.equal(await harness.api.startCapture(5, 'medium', true), false);
    assert.match(harness.app.status, /The Windows screen source is unavailable/);
    assert.equal(
        harness.calls.some(call => call.channel === 'screen-capture:diagnostics'),
        false
    );
    assert.equal(harness.acquisitions(), 1);
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
    const screen = makeStream();
    const harness = loadRenderer({
        platform: 'win32',
        mediaDevices: {
            async getDisplayMedia(value) {
                options = value;
                return screen;
            },
            async getUserMedia() {
                return makeStream(true);
            },
        },
    });
    assert.equal(await harness.api.startCapture(), true);
    assert.equal(options.audio, false);
    assert.equal(options.video, true);
    assert.deepEqual(JSON.parse(JSON.stringify(screen.videoTrack.constraints)), { frameRate: { ideal: 1, max: 1 } });
    harness.api.stopCapture();
});

for (const platform of ['darwin', 'win32']) {
    for (const testReview of [false, true]) {
        for (const mode of ['mic_only', 'speaker_only', 'both']) {
            test(`${platform} ${testReview ? 'review' : 'ordinary'} ${mode} acquires native display dimensions and tunes only the video rate`, async () => {
                const events = [];
                const screen = makeStream(platform === 'win32' && mode !== 'mic_only' && !testReview);
                const mic = makeStream(true);
                let options;
                screen.videoTrack.applyConstraints = async constraints => {
                    screen.videoTrack.constraints = constraints;
                    events.push('rate');
                };
                const harness = loadRenderer({
                    platform,
                    mode,
                    mediaDevices: {
                        async getDisplayMedia(value) {
                            options = value;
                            events.push('display');
                            return screen;
                        },
                        async getUserMedia() {
                            assert.equal(testReview, false, 'Review must never request a microphone');
                            events.push('mic');
                            return mic;
                        },
                    },
                });
                assert.equal(await harness.api.startCapture(5, 'medium', false, testReview), true);
                assert.equal(options.video, true);
                assert.deepEqual(Object.keys(options).sort(), ['audio', 'video']);
                assert.deepEqual(JSON.parse(JSON.stringify(screen.videoTrack.constraints)), {
                    frameRate: { ideal: testReview ? 5 : 1, max: testReview ? 5 : 1 },
                });
                assert.deepEqual(events.slice(0, 2), ['display', 'rate']);
                const expectsLoopback = platform === 'win32' && mode !== 'mic_only' && !testReview;
                assert.equal(typeof options.audio === 'object', expectsLoopback);
                if (!expectsLoopback) assert.equal(options.audio, false);
                assert.equal(events.includes('mic'), !testReview && mode !== 'speaker_only');
                assert.equal(
                    harness.calls.some(call => call.channel === 'start-macos-audio'),
                    platform === 'darwin' && mode !== 'mic_only' && !testReview
                );
                harness.api.stopCapture();
                assert.equal(screen.videoTrack.stopped, true);
            });
        }
    }
}

for (const testReview of [false, true]) {
    for (const support of ['missing', 'rejected']) {
        test(`${testReview ? 'review' : 'screen-only'} capture stays usable when optional frame-rate constraints are ${support}`, async () => {
            const screen = makeStream();
            let acquired = 0;
            if (support === 'missing') delete screen.videoTrack.applyConstraints;
            else {
                screen.videoTrack.applyConstraints = async () => {
                    const error = new Error('Invalid capture constraints');
                    error.name = 'OverconstrainedError';
                    throw error;
                };
            }
            const harness = loadRenderer({
                mediaDevices: {
                    async getDisplayMedia(options) {
                        assert.equal(options.video, true);
                        assert.equal(options.audio, false);
                        acquired += 1;
                        return screen;
                    },
                    getUserMedia() {
                        assert.fail('Screen-only capture must not open a microphone');
                    },
                },
            });
            assert.equal(await harness.api.startCapture(5, 'medium', true, testReview), true);
            assert.equal(acquired, 1, 'Unsupported tuning must not reacquire the display or prompt again');
            assert.equal(screen.videoTrack.stopped, false);
            assert.doesNotMatch(harness.app.status, /Error: Capture/);
            assert.equal(harness.warnings.length, 1);
            assert.match(harness.warnings[0][0], /native rate/);
            assert.equal(
                harness.calls.some(call => call.channel === 'review:begin'),
                testReview
            );
            harness.api.stopCapture();
            assert.equal(screen.videoTrack.stopped, true);
        });
    }
}

test('canceling optional frame-rate setup stops its stream immediately and cannot restart capture after a late rejection', async () => {
    const screen = makeStream();
    let rejectRate;
    screen.videoTrack.applyConstraints = () => new Promise((resolve, reject) => (rejectRate = reject));
    const harness = loadRenderer({
        mediaDevices: {
            async getDisplayMedia() {
                return screen;
            },
            getUserMedia() {
                assert.fail('Audio must not start after screen capture is canceled');
            },
        },
    });
    const start = harness.api.startCapture(5, 'medium', true, true);
    while (!rejectRate) await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    assert.equal(screen.videoTrack.stopped, true);
    rejectRate(new Error('Invalid capture constraints'));
    assert.equal(await start, false);
    assert.equal(
        harness.calls.some(call => call.channel === 'review:begin'),
        false
    );
    assert.doesNotMatch(harness.app.status, /Error: Capture/);
});

test('late frame-rate setup completion only cleans its old stream and leaves a newer review session running', async () => {
    const oldScreen = makeStream();
    const currentScreen = makeStream();
    let resolveRate;
    oldScreen.videoTrack.applyConstraints = () => new Promise(resolve => (resolveRate = resolve));
    let acquisitions = 0;
    const harness = loadRenderer({
        mediaDevices: {
            async getDisplayMedia() {
                acquisitions += 1;
                return acquisitions === 1 ? oldScreen : currentScreen;
            },
        },
    });
    const oldStart = harness.api.startCapture(5, 'medium', true, true);
    while (!resolveRate) await new Promise(resolve => setImmediate(resolve));
    assert.equal(await harness.api.startCapture(5, 'medium', true, true), true);
    resolveRate();
    assert.equal(await oldStart, false);
    assert.equal(oldScreen.videoTrack.stopped, true);
    assert.equal(currentScreen.videoTrack.stopped, false);
    assert.equal(harness.calls.filter(call => call.channel === 'review:begin').length, 1);
    harness.api.stopCapture();
});

function makeScreenshotEnvironment({
    play,
    blob,
    read,
    frame,
    frameData,
    frameCallbacks = true,
    playbackQuality,
    imageCapture,
    timeoutTimers,
    width = 1920,
    height = 1080,
} = {}) {
    const canvases = [];
    const videos = [];
    const readers = [];
    const imageCaptures = [];
    const bitmapReads = [];
    const drawnFrames = [];
    const imageData = 'data:image/jpeg;base64,' + 'a'.repeat(160);
    let frameTime = 0;
    return {
        canvases,
        videos,
        readers,
        imageCaptures,
        bitmapReads,
        drawnFrames,
        timeoutTimers,
        ImageCaptureClass: imageCapture
            ? class {
                  constructor(track) {
                      this.track = track;
                      imageCaptures.push(this);
                  }
                  grabFrame() {
                      bitmapReads.push(this.track);
                      return imageCapture(bitmapReads.length, this.track);
                  }
              }
            : undefined,
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
                if (playbackQuality) video.getVideoPlaybackQuality = () => playbackQuality(video);
                videos.push(video);
                return video;
            }
            assert.equal(type, 'canvas');
            let drawnFrame;
            const canvas = {
                getContext: () => ({
                    drawImage(source) {
                        drawnFrame = source;
                        drawnFrames.push(source);
                    },
                    getImageData: () => ({
                        width: canvas.width,
                        height: canvas.height,
                        data: frameData ? frameData(drawnFrame) : new Uint8ClampedArray(16),
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
        ImageCaptureClass: environment.ImageCaptureClass,
        invokeOverride,
        reviewFrameChecker,
        intervalTimers,
        reviewTrackerBytes,
        frameClock: environment.frameClock,
        timeoutTimers: environment.timeoutTimers,
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
    assert.equal(options.video, true);
    assert.deepEqual(JSON.parse(JSON.stringify(stream.videoTrack.constraints)), { frameRate: { ideal: 5, max: 5 } });
    assert.equal(harness.calls.filter(call => call.channel === 'review:begin').length, 1);
    assert.equal(harness.contexts.length, 0);
    harness.api.stopCapture();
    assert.equal(harness.calls.filter(call => call.channel === 'review:end').length, 1);
    assert.equal(harness.calls.find(call => call.channel === 'review:end').args.length, 0, 'An explicit stop restores main controls');
});

test('review startup failure stops its stream and requests a silent end instead of revealing main controls', async () => {
    const stream = makeStream();
    const harness = loadRenderer({
        platform: 'win32',
        mediaDevices: { getDisplayMedia: async () => stream },
        invokeOverride(channel) {
            if (channel === 'review:begin') return { success: false, error: 'Overlay startup failed.' };
        },
    });
    assert.equal(await harness.api.startCapture(5, 'medium', true, true), false);
    assert.equal(stream.videoTrack.stopped, true);
    assert.match(harness.app.status, /Overlay startup failed/);
    const ends = harness.calls.filter(call => call.channel === 'review:end');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].args[0].silent, true);
});

test('losing the review video stream quietly ends the session exactly once', async () => {
    for (const platform of ['darwin', 'win32']) {
        const stream = makeStream();
        const harness = loadRenderer({ platform, mediaDevices: { getDisplayMedia: async () => stream } });
        assert.equal(await harness.api.startCapture(5, 'medium', true, true), true);
        stream.videoTrack.emitEnded();
        assert.equal(stream.videoTrack.stopped, true);
        assert.match(harness.app.ended, /Screen capture stopped/);
        const ends = harness.calls.filter(call => call.channel === 'review:end');
        assert.equal(ends.length, 1);
        assert.equal(ends[0].args[0].silent, true);
        assert.equal(harness.calls.find(call => call.channel === 'close-session').args[0].silent, true);
        stream.videoTrack.emitEnded();
        assert.equal(harness.calls.filter(call => call.channel === 'review:end').length, 1);
    }
});

test('unloading the renderer quietly stops review even when the DOM event has unrelated properties', async () => {
    const stream = makeStream();
    const harness = loadRenderer({ mediaDevices: { getDisplayMedia: async () => stream } });
    assert.equal(await harness.api.startCapture(5, 'medium', true, true), true);
    harness.windowListeners.get('beforeunload')({ type: 'beforeunload', silentReviewEnd: 'false' });
    assert.equal(stream.videoTrack.stopped, true);
    const ends = harness.calls.filter(call => call.channel === 'review:end');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].args[0].silent, true);
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

test('live review frames with zero PTS use presented-frame progress before upload and before drawing', async () => {
    const pendingFrames = [];
    const environment = makeScreenshotEnvironment({ frame: callback => pendingFrames.push(callback) });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    pendingFrames.shift()({ mediaTime: 0, captureTime: 0, presentedFrames: 11 });
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content'),
        false
    );
    pendingFrames.shift()({ mediaTime: 0, captureTime: 0, presentedFrames: 12 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    pendingFrames.shift()({ mediaTime: 0, captureTime: 0, presentedFrames: 13 });
    assert.equal(
        harness.calls.some(call => call.channel === 'review:show-answer'),
        false
    );
    pendingFrames.shift()({ mediaTime: 0, captureTime: 0, presentedFrames: 14 });
    assert.equal(await capture, true);
    assert.equal(harness.calls.filter(call => call.channel === 'review:show-answer').length, 1);
    harness.api.stopCapture();
});

test('duplicate presented-frame counters cannot approve a fresh screenshot merely because playback time advances', async () => {
    const pendingFrames = [];
    const environment = makeScreenshotEnvironment({ frame: callback => pendingFrames.push(callback) });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    pendingFrames.shift()({ presentedFrames: 17 });
    pendingFrames.shift()({ presentedFrames: 17 });
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content'),
        false
    );
    pendingFrames.shift()({ presentedFrames: 18 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    pendingFrames.shift()({ presentedFrames: 19 });
    pendingFrames.shift()({ presentedFrames: 20 });
    assert.equal(await capture, true);
    harness.api.stopCapture();
});

test('foreign live capture clocks do not reject genuinely advancing compositor frames', async () => {
    const pendingFrames = [];
    const environment = makeScreenshotEnvironment({ frame: callback => pendingFrames.push(callback) });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    pendingFrames.shift()({ captureTime: 1700000000000, presentedFrames: 1, mediaTime: 0, presentationTime: 200 });
    pendingFrames.shift()({ captureTime: 1700000000200, presentedFrames: 2, mediaTime: 0, presentationTime: 400 });
    await new Promise(resolve => setImmediate(resolve));
    pendingFrames.shift()({ captureTime: 1700000000400, presentedFrames: 3, mediaTime: 0, presentationTime: 600 });
    pendingFrames.shift()({ captureTime: 1700000000600, presentedFrames: 4, mediaTime: 0, presentationTime: 800 });
    assert.equal(await capture, true);
    harness.api.stopCapture();
});

test('a known pre-barrier capture timestamp is rejected despite presented-frame progress and decoded counters', async () => {
    const pendingFrames = [];
    let decodedFrames = 0;
    const environment = makeScreenshotEnvironment({
        frame: callback => pendingFrames.push(callback),
        playbackQuality: () => ({ totalVideoFrames: decodedFrames }),
    });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    pendingFrames.shift()({ presentedFrames: 1 });
    pendingFrames.shift()({ presentedFrames: 2 });
    await new Promise(resolve => setImmediate(resolve));
    decodedFrames = 100;
    pendingFrames.shift()({ captureTime: 200, presentationTime: 600, presentedFrames: 3 });
    environment.videos[0].emit('timeupdate');
    assert.equal(
        harness.calls.some(call => call.channel === 'review:show-answer'),
        false
    );
    pendingFrames.shift()({ captureTime: 900, presentationTime: 1000, presentedFrames: 4 });
    assert.equal(
        harness.calls.some(call => call.channel === 'review:show-answer'),
        false
    );
    pendingFrames.shift()({ captureTime: 1100, presentationTime: 1200, presentedFrames: 5 });
    assert.equal(await capture, true);
    harness.api.stopCapture();
});

test('a hidden compositor can use two decoded video frames without waiting for a never-delivered callback', async () => {
    const pendingFrames = [];
    let decodedFrames = 0;
    const environment = makeScreenshotEnvironment({
        frame: callback => pendingFrames.push(callback),
        playbackQuality: () => ({ totalVideoFrames: decodedFrames }),
    });
    const advance = () =>
        setImmediate(() => {
            const video = environment.videos[0];
            decodedFrames++;
            video.currentTime++;
            video.emit('timeupdate');
            setImmediate(() => {
                decodedFrames++;
                video.currentTime++;
                video.emit('timeupdate');
            });
        });
    const harness = reviewHarness(environment, channel => {
        if (channel === 'review:prepare-capture' || channel === 'send-image-content') advance();
    });
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    assert.equal(harness.calls.filter(call => call.channel === 'review:show-answer').length, 1);
    assert.equal(environment.videos[0].canceledFrames, 2);
    pendingFrames.forEach(callback => callback());
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    assert.equal(
        [...environment.videos[0].listeners.values()].every(listeners => listeners.size === 0),
        true
    );
    harness.api.stopCapture();
});

test('a loaded but stalled shared screen cannot be approved by advancing playback time alone', async () => {
    const pendingFrames = [];
    const environment = makeScreenshotEnvironment({
        frame: callback => pendingFrames.push(callback),
        playbackQuality: () => ({ totalVideoFrames: 0 }),
    });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    await new Promise(resolve => setImmediate(resolve));
    environment.videos[0].currentTime++;
    environment.videos[0].emit('timeupdate');
    environment.videos[0].currentTime++;
    environment.videos[0].emit('timeupdate');
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content'),
        false
    );
    harness.api.stopCapture();
    assert.equal(await capture, false);
    assert.equal(
        harness.calls.some(call => call.channel === 'review:show-answer'),
        false
    );
    assert.equal(environment.videos[0].canceledFrames, 1);
});

function makeBitmap(id, width = 1920, height = 1080) {
    return {
        id,
        width,
        height,
        closed: 0,
        close() {
            this.closed++;
        },
    };
}

test('raw shared-track frames capture a static review without creating or waiting on a detached video compositor', async () => {
    const bitmaps = [];
    const environment = makeScreenshotEnvironment({
        frame() {
            throw new Error('A detached compositor callback must not be requested');
        },
        imageCapture: index => {
            const bitmap = makeBitmap(index);
            bitmaps.push(bitmap);
            return Promise.resolve(bitmap);
        },
        frameData: bitmap => Uint8ClampedArray.from([bitmap.id % 2 ? 1 : 2, 0, 0, 255]),
    });
    const harness = reviewHarness(environment, undefined, (snapshot, current) => snapshot.data[0] === current.data[0]);
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    assert.equal(environment.videos.length, 0);
    assert.equal(environment.bitmapReads.length, 4, 'Both acquisition barriers discard one possibly queued frame');
    assert.equal(environment.imageCaptures.length, 2);
    assert.equal(environment.drawnFrames[0].id, 2);
    assert.equal(environment.drawnFrames[1].id, 4);
    assert.equal(
        bitmaps.every(bitmap => bitmap.closed === 1),
        true
    );
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    assert.equal(harness.calls.filter(call => call.channel === 'review:show-answer').length, 1);
    harness.api.stopCapture();
});

test('a different raw question after AI processing hides the answer instead of accepting the previously captured screen', async () => {
    const bitmaps = [];
    const environment = makeScreenshotEnvironment({
        imageCapture: index => {
            const bitmap = makeBitmap(index);
            bitmaps.push(bitmap);
            return Promise.resolve(bitmap);
        },
        frameData: bitmap => Uint8ClampedArray.from([bitmap.id <= 2 ? 1 : 9, 0, 0, 255]),
    });
    const harness = reviewHarness(environment, undefined, (snapshot, current) => snapshot.data[0] === current.data[0]);
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    assert.equal(
        harness.calls.some(call => call.channel === 'review:show-answer'),
        false
    );
    assert.equal(harness.calls.filter(call => call.channel === 'review:hide-answer').length, 1);
    assert.equal(
        bitmaps.every(bitmap => bitmap.closed === 1),
        true
    );
    harness.api.stopCapture();
});

test('canceling a raw frame read closes its late bitmap and never uploads or draws it', async () => {
    let release;
    const environment = makeScreenshotEnvironment({
        imageCapture: () =>
            new Promise(resolve => {
                release = resolve;
            }),
    });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    const bitmap = makeBitmap(1);
    release(bitmap);
    assert.equal(await capture, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bitmap.closed, 1);
    assert.equal(environment.bitmapReads.length, 1);
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content' || call.channel === 'review:show-answer'),
        false
    );
});

test('canceling the raw frame hide-settle delay clears the timer without asking for another frame', async () => {
    const bitmap = makeBitmap(1);
    const environment = makeScreenshotEnvironment({ imageCapture: () => Promise.resolve(bitmap) });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    while (bitmap.closed === 0) await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    assert.equal(await capture, false);
    assert.equal(bitmap.closed, 1);
    assert.equal(environment.bitmapReads.length, 1);
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content'),
        false
    );
});

test('canceling raw post-AI validation closes its late frame and cannot publish a cached result', async () => {
    let release;
    const bitmaps = [];
    const environment = makeScreenshotEnvironment({
        imageCapture: index => {
            if (index === 3)
                return new Promise(resolve => {
                    release = resolve;
                });
            const bitmap = makeBitmap(index);
            bitmaps.push(bitmap);
            return Promise.resolve(bitmap);
        },
    });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    harness.api.stopCapture();
    const late = makeBitmap(3);
    release(late);
    assert.equal(await capture, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(late.closed, 1);
    assert.equal(
        bitmaps.every(bitmap => bitmap.closed === 1),
        true
    );
    assert.equal(
        harness.calls.some(call => call.channel === 'review:show-answer'),
        false
    );
    assert.equal(environment.bitmapReads.length, 3);
});

test('raw watchdog reads are single-flight, follow scroll-back locally, and discard a frame canceled by a new capture', async () => {
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
    let question = 1;
    let release;
    let defer = false;
    const bitmaps = [];
    const environment = makeScreenshotEnvironment({
        imageCapture: index => {
            if (defer)
                return new Promise(resolve => {
                    release = resolve;
                });
            const bitmap = makeBitmap(question);
            bitmaps.push(bitmap);
            return Promise.resolve(bitmap);
        },
        frameData: bitmap => Uint8ClampedArray.from([bitmap.id, 0, 0, 255]),
    });
    const harness = reviewHarness(environment, undefined, (snapshot, current) => snapshot.data[0] === current.data[0], intervalTimers);
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    defer = true;
    timers[0].callback();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    timers[0].callback();
    assert.equal(environment.bitmapReads.length, 5);
    assert.equal(
        harness.calls.filter(call => call.channel === 'review:hide-answer').length,
        1,
        'A still-pending read hides old marks on the next tick'
    );
    const changed = makeBitmap(9);
    release(changed);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(changed.closed, 1);
    assert.equal(harness.calls.filter(call => call.channel === 'review:hide-answer').length, 1);
    defer = false;
    question = 1;
    timers[0].callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.calls.filter(call => call.channel === 'review:move-answer').length, 1);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    defer = true;
    release = null;
    timers[0].callback();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    harness.api.stopCapture();
    const late = makeBitmap(1);
    release(late);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(late.closed, 1);
    assert.equal(harness.calls.filter(call => call.channel === 'review:move-answer').length, 1);
    assert.equal(
        bitmaps.every(bitmap => bitmap.closed === 1),
        true
    );
    assert.equal(timers[0].cleared, true);
});

test('a rejected raw-track read stays a hidden capture error and cannot fall back to a loaded video buffer', async () => {
    const environment = makeScreenshotEnvironment({
        imageCapture: async () => {
            throw new Error('Screen track is muted');
        },
    });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), false);
    assert.equal(environment.videos.length, 0);
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content' || call.channel === 'review:show-answer'),
        false
    );
    assert.match(harness.app.status, /Screen track is muted/);
    assert.equal(harness.calls.filter(call => call.channel === 'review:clear').length, 1);
    harness.api.stopCapture();
});

for (const failure of [undefined, null, 'raw frame rejected']) {
    test(`native raw rejection ${String(failure)} completes without hanging or causing an unhandled rejection`, async () => {
        const environment = makeScreenshotEnvironment({ imageCapture: () => Promise.reject(failure) });
        const harness = reviewHarness(environment);
        await harness.api.startCapture(5, 'medium', true, true);
        assert.equal(await harness.screenshot(), false);
        assert.match(harness.app.status, failure ? /raw frame rejected/ : /capture failed/);
        assert.equal(
            harness.calls.some(call => call.channel === 'send-image-content'),
            false
        );
        harness.api.stopCapture();
    });
}

test('a raw acquisition timeout releases the screenshot gate and closes a later native bitmap', async () => {
    const deadlines = [];
    const timeoutTimers = {
        setTimeout(callback, delay) {
            if (delay < 1000) return setTimeout(callback, delay);
            const timer = { callback, delay, cleared: false };
            deadlines.push(timer);
            return timer;
        },
        clearTimeout(timer) {
            if (typeof timer?.callback === 'function') timer.cleared = true;
            else clearTimeout(timer);
        },
    };
    let release;
    const bitmaps = [];
    const environment = makeScreenshotEnvironment({
        timeoutTimers,
        imageCapture: index => {
            if (index === 1)
                return new Promise(resolve => {
                    release = resolve;
                });
            const bitmap = makeBitmap(index);
            bitmaps.push(bitmap);
            return Promise.resolve(bitmap);
        },
    });
    const harness = reviewHarness(environment);
    await harness.api.startCapture(5, 'medium', true, true);
    const capture = harness.screenshot();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.ok(deadlines[0].delay <= 5000 && deadlines[0].delay >= 4900);
    deadlines[0].callback();
    assert.equal(await capture, false);
    assert.match(harness.app.status, /did not return a fresh frame/);
    assert.equal(
        harness.calls.some(call => call.channel === 'send-image-content'),
        false
    );
    const late = makeBitmap(1);
    release(late);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(late.closed, 1);
    assert.equal(await harness.screenshot(), true);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    assert.equal(
        bitmaps.every(bitmap => bitmap.closed === 1),
        true
    );
    assert.equal(
        deadlines.every(timer => timer.cleared),
        true
    );
    harness.api.stopCapture();
});

test('a stalled raw watchdog hides marks on the next tick, times out, and ignores its late frame after a fresh retry', async () => {
    const intervals = [];
    const deadlines = [];
    const intervalTimers = {
        setInterval(callback) {
            const timer = { callback, cleared: false };
            intervals.push(timer);
            return timer;
        },
        clearInterval(timer) {
            timer.cleared = true;
        },
    };
    const timeoutTimers = {
        setTimeout(callback, delay) {
            if (delay < 900) return setTimeout(callback, delay);
            const timer = { callback, delay, cleared: false };
            deadlines.push(timer);
            return timer;
        },
        clearTimeout(timer) {
            if (typeof timer?.callback === 'function') timer.cleared = true;
            else clearTimeout(timer);
        },
    };
    let release;
    const environment = makeScreenshotEnvironment({
        timeoutTimers,
        imageCapture: index => {
            if (index === 5)
                return new Promise(resolve => {
                    release = resolve;
                });
            return Promise.resolve(makeBitmap(1));
        },
        frameData: bitmap => Uint8ClampedArray.from([bitmap.id, 0, 0, 255]),
    });
    const harness = reviewHarness(environment, undefined, (snapshot, current) => snapshot.data[0] === current.data[0], intervalTimers);
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    intervals[0].callback();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const deadline = deadlines.find(timer => !timer.cleared);
    assert.ok(deadline.delay <= 1000 && deadline.delay >= 900, 'A watchdog has a shorter deadline than a manual capture');
    intervals[0].callback();
    assert.equal(harness.calls.filter(call => call.channel === 'review:hide-answer').length, 1);
    assert.equal(environment.bitmapReads.length, 5, 'A pending read cannot start overlapping native grabs');
    deadline.callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.calls.filter(call => call.channel === 'review:move-answer').length, 0);
    intervals[0].callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
        harness.calls.filter(call => call.channel === 'review:move-answer').length,
        1,
        'A fresh matching read can restore the retained answer'
    );
    const late = makeBitmap(9);
    release(late);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(late.closed, 1);
    assert.equal(
        harness.calls.filter(call => call.channel === 'review:hide-answer').length,
        1,
        'The expired read cannot hide a newer validated answer'
    );
    assert.equal(harness.calls.filter(call => call.channel === 'review:move-answer').length, 1);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 1);
    harness.api.stopCapture();
    assert.equal(intervals[0].cleared, true);
    assert.equal(
        deadlines.every(timer => timer.cleared),
        true
    );
});

test('a new manual capture cancels an old watchdog read and its late frame cannot hide or move the new answer', async () => {
    const timers = [];
    const intervalTimers = {
        setInterval(callback) {
            const timer = { callback };
            timers.push(timer);
            return timer;
        },
        clearInterval() {},
    };
    let question = 1;
    let release;
    let sequence = 0;
    const environment = makeScreenshotEnvironment({
        imageCapture: index =>
            index === 5
                ? new Promise(resolve => {
                      release = resolve;
                  })
                : Promise.resolve(makeBitmap(question)),
        frameData: bitmap => Uint8ClampedArray.from([bitmap.id, 0, 0, 255]),
    });
    const harness = reviewHarness(
        environment,
        channel => {
            if (channel === 'review:prepare-capture') return { ...REVIEW_CAPTURE_TOKEN, requestId: `request-${++sequence}` };
        },
        (snapshot, current) => snapshot.data[0] === current.data[0],
        intervalTimers
    );
    await harness.api.startCapture(5, 'medium', true, true);
    assert.equal(await harness.screenshot(), true);
    timers[0].callback();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    question = 9;
    assert.equal(await harness.screenshot(), true);
    assert.equal(harness.calls.filter(call => call.channel === 'send-image-content').length, 2);
    assert.equal(harness.calls.filter(call => call.channel === 'review:show-answer').length, 2);
    const late = makeBitmap(1);
    release(late);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(late.closed, 1);
    assert.equal(
        harness.calls.some(call => call.channel === 'review:hide-answer' || call.channel === 'review:move-answer'),
        false
    );
    harness.api.stopCapture();
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
    assert.equal(harness.calls.find(call => call.channel === 'review:end').args[0].silent, true);
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
    assert.equal(harness.calls.find(call => call.channel === 'review:end').args[0].silent, true);
    assert.match(harness.app.ended, /overlay closed/);
});
