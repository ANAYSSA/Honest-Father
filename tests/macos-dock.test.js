const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createShutdownHandler, createQuitController } = require('../src/utils/shutdown');

function loadStartup(platform) {
    const calls = [];
    const handlers = new Map();
    const app = new EventEmitter();
    const processEvents = new EventEmitter();
    let ready;
    const readyPromise = new Promise(resolve => {
        ready = resolve;
    });
    let dockVisible = true;
    let windowCount = 0;
    let createdWindow;
    app.setName = () => {};
    app.setAppUserModelId = () => {};
    app.whenReady = () => readyPromise;
    app.setActivationPolicy = policy => {
        assert.equal(platform, 'darwin');
        assert.equal(policy, 'accessory');
        calls.push('accessory-policy');
        dockVisible = false;
    };
    Object.defineProperty(app, 'dock', {
        get() {
            assert.equal(platform, 'darwin', 'Only macOS accesses the Dock API');
            return {
                hide() {
                    calls.push('hide-dock');
                    // Electron can ignore an early hide after its launcher shows the Dock.
                },
            };
        },
    });
    app.quit = () => {
        calls.push('quit');
        app.emit('before-quit');
        app.emit('will-quit');
        processEvents.emit('exit');
    };
    app.exit = () => processEvents.emit('exit');
    processEvents.platform = platform;
    const mocks = {
        'electron-squirrel-startup': false,
        electron: {
            app,
            BrowserWindow: { getAllWindows: () => (windowCount ? [{}] : []) },
            ipcMain: { handle: (name, callback) => handlers.set(name, callback), on() {} },
            globalShortcut: { unregisterAll() {} },
        },
        './utils/window': {
            createWindow() {
                calls.push('create-window');
                windowCount++;
                createdWindow = { isDestroyed: () => windowCount === 0, show: () => calls.push('show-window'), webContents: new EventEmitter() };
                return createdWindow;
            },
            getReviewOverlay: () => null,
            disposeGlobalShortcuts: () => calls.push('dispose-shortcuts'),
        },
        './utils/gemini': {
            setupGeminiIpcHandlers() {},
            setMainWindow() {},
            closeActiveSession: () => calls.push('close-session'),
            stopMacOSAudioCapture: () => calls.push('stop-audio'),
        },
        './utils/localai': { closeLocalSession: () => calls.push('close-local') },
        './utils/keybinds': {},
        './utils/shutdown': { createShutdownHandler, createQuitController },
        './storage': { initializeStorage: () => calls.push('initialize-storage') },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8'), {
        require(name) {
            assert.ok(name in mocks, `Unexpected startup dependency: ${name}`);
            return mocks[name];
        },
        process: processEvents,
        console,
    });
    return {
        ready,
        app,
        calls,
        handlers,
        dockVisible: () => dockVisible,
        closeWindows: () => (windowCount = 0),
        completeLoad() {
            dockVisible = true;
            createdWindow.webContents.emit('did-finish-load');
        },
    };
}

test('macOS startup hides the Dock after creating its usable window and retains normal quit cleanup', async () => {
    const startup = loadStartup('darwin');
    assert.deepEqual(startup.calls, []);
    startup.ready();
    await Promise.resolve();
    assert.deepEqual(startup.calls, ['initialize-storage', 'accessory-policy', 'create-window', 'hide-dock']);
    startup.completeLoad();
    assert.equal(startup.dockVisible(), false);
    const result = await startup.handlers.get('quit-application')({});
    assert.equal(result.success, true);
    assert.deepEqual(startup.calls.slice(5), ['quit', 'close-session', 'stop-audio', 'close-local', 'dispose-shortcuts']);
});

test('reopening the macOS window keeps agent activation even when a quick Dock hide is ignored', async () => {
    const startup = loadStartup('darwin');
    startup.ready();
    await Promise.resolve();
    startup.closeWindows();
    startup.app.emit('activate');
    assert.deepEqual(startup.calls.slice(4), ['accessory-policy', 'create-window', 'hide-dock']);
    startup.completeLoad();
    assert.equal(startup.dockVisible(), false);
});

test('a window finishing load after quit cannot change macOS activation or restart the app', async () => {
    const startup = loadStartup('darwin');
    startup.ready();
    await Promise.resolve();
    await startup.handlers.get('quit-application')({});
    const callsAfterQuit = [...startup.calls];
    startup.completeLoad();
    assert.deepEqual(startup.calls, callsAfterQuit);
});

test('opening a running app reveals its existing main window without creating another Electron window', async () => {
    const startup = loadStartup('darwin');
    startup.ready();
    await Promise.resolve();
    startup.app.emit('activate');
    assert.deepEqual(startup.calls.slice(4), ['show-window']);
});

test('Windows startup creates the window without using the macOS Dock API', async () => {
    const startup = loadStartup('win32');
    startup.ready();
    await Promise.resolve();
    assert.deepEqual(startup.calls, ['initialize-storage', 'create-window']);
});

test('packaged macOS app starts as an interactive agent without a startup Dock icon', () => {
    const configuration = { exports: {} };
    const mocks = {
        path,
        '@electron-forge/plugin-fuses': { FusesPlugin: class {} },
        '@electron/fuses': { FuseV1Options: {}, FuseVersion: {} },
        './scripts/build-audio-helper': {},
        './scripts/verify-macos-app': {},
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../forge.config.js'), 'utf8'), {
        require(name) {
            assert.ok(name in mocks, `Unexpected packaging dependency: ${name}`);
            return mocks[name];
        },
        module: configuration,
        process: { platform: 'darwin' },
    });
    const info = configuration.exports.packagerConfig.extendInfo;
    assert.equal(info.LSUIElement, true);
    assert.equal(info.LSBackgroundOnly, undefined, 'The app must still be able to present its interactive window');
});
