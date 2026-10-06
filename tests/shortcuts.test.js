const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { getDefaultKeybinds, normalizeAccelerator, normalizeKeybinds, createShortcutRegistrar } = require('../src/utils/keybinds');
const { createShutdownHandler } = require('../src/utils/shutdown');

function makeGlobalShortcut() {
    const callbacks = new Map();
    const blocked = new Set();
    let unregisterCount = 0;
    return {
        callbacks,
        blocked,
        get unregisterCount() {
            return unregisterCount;
        },
        register(accelerator, callback) {
            assert.equal(typeof callback, 'function');
            if (blocked.has(accelerator)) return false;
            callbacks.set(accelerator, callback);
            return true;
        },
        unregisterAll() {
            unregisterCount++;
            callbacks.clear();
        },
    };
}

function loadCommonJs(relativePath, mocks, platform = process.platform) {
    const filename = path.resolve(__dirname, '..', relativePath);
    const module = { exports: {} };
    const requireMock = id => (Object.hasOwn(mocks, id) ? mocks[id] : require(path.resolve(path.dirname(filename), id)));
    vm.runInNewContext(
        fs.readFileSync(filename, 'utf8'),
        {
            require: requireMock,
            module,
            exports: module.exports,
            __dirname: path.dirname(filename),
            process: { platform, once() {} },
            console: { log() {}, warn() {}, error() {} },
        },
        { filename }
    );
    return module.exports;
}

test('quit defaults use Command on macOS and Control on Windows; old saved settings gain the new shortcut', () => {
    assert.equal(getDefaultKeybinds('darwin').quitApplication, 'Cmd+Shift+Q');
    assert.equal(getDefaultKeybinds('win32').quitApplication, 'Ctrl+Shift+Q');
    const migrated = normalizeKeybinds({ moveUp: 'Ctrl+Alt+Up' }, 'win32');
    assert.equal(migrated.moveUp, 'Ctrl+Alt+Up');
    assert.equal(migrated.quitApplication, 'Ctrl+Shift+Q');
});

for (const [platform, primary] of [
    ['darwin', 'Cmd'],
    ['win32', 'Ctrl'],
]) {
    test(`app visibility and Review marks have separate defaults and preserve older custom bindings on ${platform}`, () => {
        const defaults = getDefaultKeybinds(platform);
        assert.equal(defaults.toggleVisibility, `${primary}+\\`);
        assert.equal(defaults.toggleReviewMarks, `${primary}+Shift+\\`);
        const migrated = normalizeKeybinds({ nextStep: `${primary}+Alt+Enter` }, platform);
        assert.equal(migrated.nextStep, `${primary}+Alt+Enter`);
        assert.equal(migrated.toggleVisibility, defaults.toggleVisibility);
        assert.equal(migrated.toggleReviewMarks, defaults.toggleReviewMarks);
        assert.equal(migrated.quitApplication, defaults.quitApplication);

        const legacy = {
            toggleVisibility: `Shift+${primary}+\\`,
            nextStep: `${primary}+Shift+Alt+\\`,
            toggleClickThrough: `Alt+${primary}+\\`,
        };
        const collisionMigration = normalizeKeybinds(legacy, platform);
        assert.equal(collisionMigration.toggleVisibility, `${primary}+Shift+\\`);
        assert.equal(collisionMigration.nextStep, `${primary}+Alt+Shift+\\`);
        assert.equal(collisionMigration.toggleClickThrough, `${primary}+Alt+\\`);
        assert.equal(collisionMigration.toggleReviewMarks, `${primary}+Shift+F12`);
        assert.deepEqual(normalizeKeybinds(collisionMigration, platform), collisionMigration, 'Saving and restarting retains the migrated shortcut');
    });
}

test('equivalent aliases and modifier order cannot duplicate another action', () => {
    assert.equal(normalizeAccelerator('shift+commandorcontrol+q', 'darwin'), 'Cmd+Shift+Q');
    assert.equal(normalizeAccelerator('Option+Meta+q', 'darwin'), 'Cmd+Alt+Q');
    assert.throws(() => normalizeKeybinds({ quitApplication: 'Shift+Control+Up' }, 'win32'), /conflicts with Scroll Response Up/);
    assert.throws(() => normalizeKeybinds({ quitApplication: 'Meta+Shift+Up' }, 'darwin'), /conflicts with Scroll Response Up/);
    assert.throws(() => normalizeKeybinds({ quitApplication: 'Control+Option+Up', moveUp: 'Alt+Ctrl+Up' }, 'win32'), /conflicts/);
    assert.throws(
        () => normalizeKeybinds({ toggleReviewMarks: 'commandorcontrol+\\' }, 'darwin'),
        /Toggle Review Marks conflicts with Toggle App Window/
    );
    assert.throws(
        () => normalizeKeybinds({ toggleVisibility: 'Ctrl+Shift+\\', toggleReviewMarks: 'Shift+Control+\\' }, 'win32'),
        /Toggle Review Marks conflicts with Toggle App Window/
    );
});

test('IPC shortcut input rejects malformed values and shortcuts that intercept ordinary typing', () => {
    for (const invalid of [false, [], 'Cmd+Q', 123]) assert.throws(() => normalizeKeybinds(invalid, 'darwin'), /Invalid keyboard/);
    for (const invalid of ['', 'Q', 'Shift+Q', 'Cmd+Cmd+Q', 'Cmd+Unknown', 'Ctrl+<script>', null, false]) {
        assert.throws(() => normalizeKeybinds({ quitApplication: invalid }, 'win32'));
    }
    const normalized = normalizeKeybinds({ quitApplication: 'Control+Alt+f12', injectedAction: 'Ctrl+X' }, 'win32');
    assert.equal(normalized.quitApplication, 'Ctrl+Alt+F12');
    assert.equal(Object.hasOwn(normalized, 'injectedAction'), false);
});

test('a shortcut owned by another app fails visibly and restores the previous working shortcuts', () => {
    const globalShortcut = makeGlobalShortcut();
    const registrar = createShortcutRegistrar(globalShortcut, 'win32');
    const defaults = getDefaultKeybinds('win32');
    const actions = Object.fromEntries(Object.keys(defaults).map(action => [action, () => {}]));
    assert.equal(registrar.update(null, actions, { allowPartial: true }).success, true);
    const previousQuit = globalShortcut.callbacks.get(defaults.quitApplication);
    globalShortcut.blocked.add('Ctrl+Shift+X');
    const failed = registrar.update({ quitApplication: 'Ctrl+Shift+X' }, actions);
    assert.equal(failed.success, false);
    assert.match(failed.error, /Quit Application.*unavailable/);
    assert.equal(registrar.getStatus().keybinds.quitApplication, defaults.quitApplication);
    assert.equal(globalShortcut.callbacks.get(defaults.quitApplication), previousQuit);
    assert.equal(globalShortcut.callbacks.has('Ctrl+Shift+X'), false);
});

test('invalid edits preserve active shortcuts without unregistering them', () => {
    const globalShortcut = makeGlobalShortcut();
    const registrar = createShortcutRegistrar(globalShortcut, 'win32');
    const actions = Object.fromEntries(Object.keys(getDefaultKeybinds('win32')).map(action => [action, () => {}]));
    registrar.update(null, actions, { allowPartial: true });
    const count = globalShortcut.unregisterCount;
    assert.equal(registrar.update({ quitApplication: 'Ctrl+\\' }, actions).success, false);
    assert.equal(globalShortcut.unregisterCount, count);
    assert.ok(globalShortcut.callbacks.has('Ctrl+Shift+Q'));
});

test('custom app and Review shortcuts register independently, resume after editing, and rollback an unavailable marks edit', () => {
    const globalShortcut = makeGlobalShortcut();
    const registrar = createShortcutRegistrar(globalShortcut, 'darwin');
    const defaults = getDefaultKeybinds('darwin');
    const calls = [];
    const actions = Object.fromEntries(Object.keys(defaults).map(action => [action, () => calls.push(action)]));
    const custom = { ...defaults, toggleVisibility: 'Cmd+Alt+V', toggleReviewMarks: 'Cmd+Alt+R' };
    assert.equal(registrar.update(custom, actions).success, true);
    globalShortcut.callbacks.get(custom.toggleVisibility)();
    globalShortcut.callbacks.get(custom.toggleReviewMarks)();
    assert.deepEqual(calls, ['toggleVisibility', 'toggleReviewMarks']);
    registrar.setPaused(true);
    assert.equal(globalShortcut.callbacks.size, 0);
    registrar.setPaused(false);
    globalShortcut.callbacks.get(custom.toggleReviewMarks)();
    globalShortcut.callbacks.get(defaults.quitApplication)();
    assert.deepEqual(calls, ['toggleVisibility', 'toggleReviewMarks', 'toggleReviewMarks', 'quitApplication']);

    globalShortcut.blocked.add('Cmd+Alt+X');
    const failed = registrar.update({ ...custom, toggleReviewMarks: 'Cmd+Alt+X' }, actions);
    assert.equal(failed.success, false);
    assert.match(failed.error, /Toggle Review Marks.*unavailable/);
    assert.equal(registrar.getStatus().keybinds.toggleReviewMarks, custom.toggleReviewMarks);
    assert.ok(globalShortcut.callbacks.has(custom.toggleVisibility));
    assert.ok(globalShortcut.callbacks.has(custom.toggleReviewMarks));
    assert.ok(globalShortcut.callbacks.has(defaults.quitApplication));
    assert.equal(globalShortcut.callbacks.has('Cmd+Alt+X'), false);
});

test('editing temporarily pauses shortcuts and resumes the new binding, preserving the ability to quit', () => {
    const globalShortcut = makeGlobalShortcut();
    const registrar = createShortcutRegistrar(globalShortcut, 'win32');
    let quitCount = 0;
    const actions = Object.fromEntries(Object.keys(getDefaultKeybinds('win32')).map(action => [action, () => {}]));
    actions.quitApplication = () => quitCount++;
    registrar.update(null, actions, { allowPartial: true });
    registrar.setPaused(true);
    assert.equal(globalShortcut.callbacks.size, 0);
    assert.equal(registrar.update({ quitApplication: 'Ctrl+Alt+Q' }, actions).success, true);
    assert.equal(globalShortcut.callbacks.size, 0);
    registrar.setPaused(false);
    assert.equal(globalShortcut.callbacks.has('Ctrl+Shift+Q'), false);
    globalShortcut.callbacks.get('Ctrl+Alt+Q')();
    assert.equal(quitCount, 1);
});

test('unavailable unchanged defaults do not prevent a user fixing another shortcut', () => {
    const globalShortcut = makeGlobalShortcut();
    const registrar = createShortcutRegistrar(globalShortcut, 'win32');
    const actions = Object.fromEntries(Object.keys(getDefaultKeybinds('win32')).map(action => [action, () => {}]));
    globalShortcut.blocked.add('Ctrl+M');
    const startup = registrar.update(null, actions, { allowPartial: true });
    assert.equal(startup.failures.length, 1);
    const edited = registrar.update({ quitApplication: 'Ctrl+Alt+Q' }, actions);
    assert.equal(edited.success, true);
    assert.equal(edited.failures.length, 1);
    assert.ok(globalShortcut.callbacks.has('Ctrl+Alt+Q'));
    registrar.setPaused(true);
    assert.equal(registrar.setPaused(false).failures.length, 1);
    globalShortcut.blocked.delete('Ctrl+M');
    registrar.setPaused(true);
    assert.equal(registrar.setPaused(false).failures.length, 0);
    assert.ok(globalShortcut.callbacks.has('Ctrl+M'));
});

for (const platform of ['darwin', 'win32']) {
    test(`quit works with a hidden or destroyed window on ${platform} and preserves local data`, () => {
        const globalShortcut = makeGlobalShortcut();
        let quitCount = 0;
        let erased = false;
        const windowModule = loadCommonJs(
            'src/utils/window.js',
            {
                electron: {
                    app: { quit: () => quitCount++ },
                    globalShortcut,
                    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
                },
                'node:path': path,
                '../storage': {
                    clearAllData: () => {
                        erased = true;
                    },
                },
            },
            platform
        );
        const window = { isVisible: () => false, isDestroyed: () => true };
        const session = {
            current: {
                close: () => {
                    throw new Error('broken session');
                },
            },
        };
        const result = windowModule.updateGlobalShortcuts(null, window, () => {}, session, { allowPartial: true });
        assert.equal(result.success, true);
        globalShortcut.callbacks.get(getDefaultKeybinds(platform).quitApplication)();
        assert.equal(quitCount, 1);
        assert.equal(erased, false);
    });
}

test('all shutdown cleanup runs once, even if a transport throws or an async cleanup rejects', async () => {
    const calls = [];
    const errors = [];
    const shutdown = createShutdownHandler({
        closeActiveSession: () => {
            calls.push('session');
            throw new Error('transport failed');
        },
        stopAudioCapture: () => {
            calls.push('audio');
            return Promise.reject(new Error('audio failed'));
        },
        closeLocalSession: () => calls.push('local'),
        unregisterShortcuts: () => calls.push('shortcuts'),
        logger: { error: (...args) => errors.push(args) },
    });
    shutdown();
    shutdown();
    await Promise.resolve();
    assert.deepEqual(calls, ['session', 'audio', 'local', 'shortcuts']);
    assert.equal(errors.length, 2);
});

test('main IPC has one update handler, rejects other senders, and rolls back when saving fails', async () => {
    const app = new EventEmitter();
    app.whenReady = () => Promise.resolve();
    app.setName = () => {};
    app.setAppUserModelId = () => {};
    app.exit = () => {};
    const handlers = new Map();
    const ipcMain = {
        handle(channel, callback) {
            assert.equal(handlers.has(channel), false);
            handlers.set(channel, callback);
        },
        on() {},
    };
    const window = { webContents: {}, isDestroyed: () => false };
    let current = getDefaultKeybinds();
    const changes = [];
    const cleanup = [];
    loadCommonJs(
        'src/index.js',
        {
            'electron-squirrel-startup': false,
            electron: { app, BrowserWindow: {}, shell: {}, ipcMain, globalShortcut: { unregisterAll: () => cleanup.push('shortcuts') } },
            './utils/window': {
                createWindow: () => window,
                getReviewOverlay: () => null,
                getKeybindStatus: () => ({ keybinds: current }),
                setShortcutsPaused: () => ({ success: true }),
                disposeGlobalShortcuts: () => cleanup.push('shortcuts'),
                updateGlobalShortcuts(input) {
                    current = normalizeKeybinds(input);
                    changes.push(current);
                    return { success: true, keybinds: current };
                },
            },
            './utils/gemini': {
                setupGeminiIpcHandlers() {},
                setMainWindow() {},
                stopMacOSAudioCapture: () => cleanup.push('audio'),
                sendToRenderer() {},
                closeActiveSession: () => cleanup.push('session'),
            },
            './utils/localai': { closeLocalSession: () => cleanup.push('local') },
            './storage': { initializeStorage() {}, setKeybinds: () => false },
        },
        'win32'
    );
    await Promise.resolve();
    const update = handlers.get('update-keybinds');
    const rejected = await update({ sender: {} }, { quitApplication: 'Ctrl+Alt+Q' });
    assert.equal(rejected.success, false);
    assert.equal(changes.length, 0);
    const previous = current.quitApplication;
    const failed = await update({ sender: window.webContents }, { quitApplication: 'Ctrl+Alt+Q' });
    assert.equal(failed.success, false);
    assert.match(failed.error, /save keyboard/);
    assert.equal(current.quitApplication, previous);
    const storageFailure = await handlers.get('storage:set-keybinds')({}, null);
    assert.equal(storageFailure.success, false);
    app.emit('before-quit');
    app.emit('before-quit');
    assert.deepEqual(cleanup, ['session', 'audio', 'local', 'shortcuts']);
});

for (const platform of ['darwin', 'win32']) {
    test(`app activation keeps an active Test Review main window hidden on ${platform}`, async () => {
        const app = new EventEmitter();
        app.whenReady = () => Promise.resolve();
        app.setName = () => {};
        app.setAppUserModelId = () => {};
        app.setActivationPolicy = () => {};
        app.dock = { hide() {} };
        app.exit = () => {};
        let activeReview = false;
        let showCount = 0;
        let createCount = 0;
        const window = {
            webContents: new EventEmitter(),
            isDestroyed: () => false,
            show: () => showCount++,
        };
        const overlay = { isActive: () => activeReview };
        const ipcMain = { handle() {}, on() {} };
        loadCommonJs(
            'src/index.js',
            {
                'electron-squirrel-startup': false,
                electron: { app, BrowserWindow: {}, shell: {}, ipcMain, globalShortcut: { unregisterAll() {} } },
                './utils/window': {
                    createWindow: () => {
                        createCount++;
                        return window;
                    },
                    getReviewOverlay: () => overlay,
                    getKeybindStatus: () => ({ keybinds: getDefaultKeybinds(platform) }),
                    setShortcutsPaused() {},
                    disposeGlobalShortcuts() {},
                    updateGlobalShortcuts() {},
                },
                './utils/gemini': {
                    setupGeminiIpcHandlers() {},
                    setMainWindow() {},
                    stopMacOSAudioCapture() {},
                    sendToRenderer() {},
                    closeActiveSession() {},
                },
                './storage': { initializeStorage() {} },
            },
            platform
        );
        await Promise.resolve();
        assert.equal(createCount, 1);
        activeReview = true;
        app.emit('activate');
        app.emit('activate');
        assert.equal(showCount, 0, 'The operating system cannot expose the hidden Review controls');
        assert.equal(createCount, 1, 'Activation keeps the running Review session');
        activeReview = false;
        app.emit('activate');
        assert.equal(showCount, 1, 'Ordinary activation still shows the main app window');
    });
}
