const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { registerAutomaticScreenCapture, selectScreenSource } = require('../src/utils/screenCapture');

function makeHarness({ platform = 'darwin', sources, getSources, onSourceSelected, onCallback } = {}) {
    const frame = {};
    let displayId = 22;
    let destroyed = false;
    const calls = [];
    const warnings = [];
    const available = sources || [
        { id: 'screen:22:0', display_id: '11', name: 'Primary' },
        { id: 'screen:11:0', display_id: '22', name: 'App monitor' },
    ];
    const mainWindow = {
        webContents: { mainFrame: frame },
        isDestroyed: () => destroyed,
        getBounds: () => ({ x: 1920, y: 0, width: 1100, height: 800 }),
    };
    const screen = {
        getDisplayMatching: bounds => {
            assert.equal(bounds.x, 1920);
            return { id: displayId };
        },
        getPrimaryDisplay: () => ({ id: 11 }),
    };
    let handler;
    let handlerOptions;
    const controller = registerAutomaticScreenCapture(
        {
            setDisplayMediaRequestHandler(value, options) {
                handler = value;
                handlerOptions = options;
            },
        },
        {
            desktopCapturer: {
                async getSources(options) {
                    calls.push(options);
                    return getSources ? getSources() : available;
                },
            },
            screen,
            mainWindow,
            platform,
            onSourceSelected,
            logger: { warn: (...args) => warnings.push(args) },
        }
    );
    return {
        calls,
        warnings,
        available,
        handlerOptions,
        getLastFailure: controller.getLastFailure,
        select: () => selectScreenSource(available, screen, mainWindow),
        moveToDisplay: id => (displayId = id),
        destroy: () => (destroyed = true),
        async request(overrides = {}) {
            const results = [];
            await handler({ frame, videoRequested: true, audioRequested: false, ...overrides }, result => {
                results.push(result);
                onCallback?.(result);
            });
            assert.equal(results.length, 1);
            return results[0];
        },
    };
}

test('automatic capture disables the native picker and captures the app monitor by display ID', async () => {
    const harness = makeHarness();
    assert.deepEqual(harness.handlerOptions, { useSystemPicker: false });
    const result = await harness.request();
    // Source IDs deliberately contain the other display's number.
    assert.equal(result.video, harness.available[1]);
    assert.equal(Object.hasOwn(result, 'audio'), false);
    assert.deepEqual(harness.calls, [{ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }]);
});

test('a new session follows the app to its current monitor without a chooser', async () => {
    const harness = makeHarness();
    assert.equal((await harness.request()).video.name, 'App monitor');
    harness.moveToDisplay(11);
    assert.equal((await harness.request()).video.name, 'Primary');
});

test('missing app monitor falls back to primary, and missing display IDs use an available source', async () => {
    const harness = makeHarness();
    harness.moveToDisplay(999);
    assert.equal((await harness.request()).video.name, 'Primary');
    const missingIds = makeHarness({ sources: [{ id: 'screen:0:0', display_id: '', name: 'Screen' }] });
    assert.equal((await missingIds.request()).video.name, 'Screen');
});

test('Windows system audio uses loopback only when requested; screen-only never grants audio', async () => {
    const harness = makeHarness({ platform: 'win32' });
    assert.equal((await harness.request({ audioRequested: true })).audio, 'loopback');
    assert.equal(Object.hasOwn(await harness.request({ audioRequested: false }), 'audio'), false);
});

test('macOS display capture never asks Chromium for Windows loopback audio', async () => {
    const harness = makeHarness();
    assert.equal(Object.hasOwn(await harness.request({ audioRequested: true }), 'audio'), false);
});

test('empty sources and Screen Recording permission errors deny capture cleanly', async () => {
    const empty = makeHarness({ sources: [] });
    assert.equal(await empty.request(), null);
    assert.equal(empty.getLastFailure().code, 'no_screen_sources');
    assert.equal(empty.getLastFailure().stage, 'sources');
    const denied = makeHarness({
        getSources: () => {
            throw new Error('Screen Recording permission denied');
        },
    });
    assert.equal(await denied.request(), null);
    assert.equal(denied.warnings.length, 1);
    assert.equal(denied.getLastFailure().error, 'Screen Recording permission denied');
});

test('requests from a destroyed or different frame do not enumerate any screen', async () => {
    const harness = makeHarness();
    assert.equal(await harness.request({ frame: null }), null);
    assert.equal(await harness.request({ frame: {} }), null);
    assert.equal(await harness.request({ videoRequested: false }), null);
    harness.destroy();
    assert.equal(await harness.request(), null);
    assert.equal(harness.calls.length, 0);
});

test('closing the window during source enumeration cannot grant a late capture', async () => {
    let resolveSources;
    const sources = new Promise(resolve => (resolveSources = resolve));
    const harness = makeHarness({ getSources: () => sources });
    const request = harness.request({ audioRequested: true });
    harness.destroy();
    resolveSources(harness.available);
    assert.equal(await request, null);
    assert.equal(harness.getLastFailure().code, 'capture_cancelled');
});

test('native Electron string rejections retain the original cause with a bounded timestamped copy', async () => {
    const before = Date.now();
    const harness = makeHarness({ getSources: () => Promise.reject('Failed to get sources.') });
    assert.equal(harness.getLastFailure(), null);
    assert.equal(await harness.request(), null);
    const failure = harness.getLastFailure();
    assert.equal(failure.code, 'source_enumeration_failed');
    assert.equal(failure.stage, 'sources');
    assert.equal(failure.error, 'Failed to get sources.');
    assert.ok(failure.at >= before && failure.at <= Date.now());
    assert.deepEqual(harness.warnings, [['Screen capture could not start:', 'Failed to get sources.']]);
    failure.error = 'changed externally';
    failure.code = 'changed externally';
    assert.equal(harness.getLastFailure().error, 'Failed to get sources.');
    assert.equal(harness.getLastFailure().code, 'source_enumeration_failed');
});

test('capture diagnostics clean control characters, bound long messages, and handle non-Error rejections', async () => {
    const harness = makeHarness({ getSources: () => Promise.reject(`\u0000 Permission\n\tdenied \u007f${'x'.repeat(800)}`) });
    assert.equal(await harness.request(), null);
    const failure = harness.getLastFailure();
    assert.equal(failure.error.length, 512);
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(failure.error), false);
    assert.ok(failure.error.startsWith('Permission denied '));
    const unknown = makeHarness({ getSources: () => Promise.reject(null) });
    assert.equal(await unknown.request(), null);
    assert.equal(unknown.getLastFailure().error, 'Screen capture could not start.');
});

test('starting a new request clears an old failure immediately and a successful grant keeps it cleared', async () => {
    let resolveSources;
    let attempts = 0;
    const harness = makeHarness({
        getSources: () => {
            if (++attempts === 1) return Promise.reject(new Error('Temporary enumeration failure'));
            return new Promise(resolve => (resolveSources = resolve));
        },
    });
    assert.equal(await harness.request(), null);
    assert.ok(harness.getLastFailure());
    const next = harness.request();
    assert.equal(harness.getLastFailure(), null);
    resolveSources(harness.available);
    assert.equal((await next).video, harness.available[1]);
    assert.equal(harness.getLastFailure(), null);
});

test('source-selection exceptions deny capture and preserve their own stage', async () => {
    const harness = makeHarness({
        onSourceSelected: () => {
            throw new Error('Selected monitor disappeared');
        },
    });
    assert.equal(await harness.request(), null);
    assert.equal(harness.getLastFailure().code, 'source_selection_failed');
    assert.equal(harness.getLastFailure().stage, 'source-selected');
    assert.equal(harness.getLastFailure().error, 'Selected monitor disappeared');
});

test('callback exceptions are diagnosed without invoking the native callback twice', async () => {
    const harness = makeHarness({
        onCallback: () => {
            throw 'The capture frame ended';
        },
    });
    assert.equal((await harness.request()).video, harness.available[1]);
    assert.equal(harness.getLastFailure().code, 'capture_callback_failed');
    assert.equal(harness.getLastFailure().stage, 'callback');
    assert.equal(harness.getLastFailure().error, 'The capture frame ended');
});

test('an older async failure cannot replace diagnostics from a newer successful request', async () => {
    let rejectFirst;
    let attempts = 0;
    const harness = makeHarness({
        getSources: () => (++attempts === 1 ? new Promise((resolve, reject) => (rejectFirst = reject)) : harness.available),
    });
    const first = harness.request();
    assert.equal((await harness.request()).video, harness.available[1]);
    rejectFirst('Old request failed');
    assert.equal(await first, null);
    assert.equal(harness.getLastFailure(), null);
});

test('an older async success cannot grant capture or erase a newer failed request', async () => {
    let resolveFirst;
    let attempts = 0;
    const selected = [];
    const harness = makeHarness({
        getSources: () => (++attempts === 1 ? new Promise(resolve => (resolveFirst = resolve)) : Promise.reject('Current source failure')),
        onSourceSelected: source => selected.push(source),
    });
    const first = harness.request();
    assert.equal(await harness.request(), null);
    const failure = harness.getLastFailure();
    resolveFirst(harness.available);
    assert.equal(await first, null);
    assert.deepEqual(harness.getLastFailure(), failure);
    assert.deepEqual(selected, []);
});

test('the actual window setup installs automatic capture and supplies the matching monitor', async () => {
    let handler;
    let options;
    const sources = [
        { id: 'screen:0:0', display_id: '11', name: 'Primary' },
        { id: 'screen:1:0', display_id: '22', name: 'App monitor' },
    ];
    class BrowserWindow extends EventEmitter {
        constructor() {
            super();
            this.webContents = new EventEmitter();
            this.webContents.mainFrame = {};
        }
        isDestroyed() {
            return false;
        }
        getBounds() {
            return { x: 1920, y: 0, width: 1100, height: 800 };
        }
        setContentProtection() {}
        setHiddenInMissionControl() {}
        loadFile() {}
    }
    const ipcMain = new EventEmitter();
    ipcMain.handle = () => {};
    const electron = {
        app: { quit() {} },
        BrowserWindow,
        ipcMain,
        globalShortcut: { register: () => true, unregisterAll() {} },
        screen: {
            getPrimaryDisplay: () => ({ id: 11, workAreaSize: { width: 1920, height: 1080 } }),
            getDisplayMatching: () => ({ id: 22 }),
        },
        session: {
            defaultSession: {
                setDisplayMediaRequestHandler(value, handlerOptions) {
                    handler = value;
                    options = handlerOptions;
                },
            },
        },
        desktopCapturer: { getSources: async () => sources },
    };
    const filename = path.join(__dirname, '../src/utils/window.js');
    const module = { exports: {} };
    vm.runInNewContext(
        fs.readFileSync(filename, 'utf8'),
        {
            module,
            __dirname: path.dirname(filename),
            process: { platform: 'darwin' },
            console,
            require: id => {
                if (id === 'electron') return electron;
                if (id === 'node:path') return path;
                if (id === '../storage') return { getKeybinds: () => null, getPreferences: () => ({}) };
                return require(path.resolve(path.dirname(filename), id));
            },
        },
        { filename }
    );
    const window = module.exports.createWindow(() => {}, { current: null });
    assert.equal(options.useSystemPicker, false);
    let result;
    await handler({ frame: window.webContents.mainFrame, videoRequested: true, audioRequested: false }, streams => (result = streams));
    assert.equal(result.video, sources[1]);
    assert.equal(Object.hasOwn(result, 'audio'), false);
});
