const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function harness({ platform = 'win32', permissionStatus = 'unknown', permissionThrows = false } = {}) {
    const handlers = new Map();
    const calls = [];
    const rendererMessages = [];
    const mouseEventStates = [];
    const endRequests = [];
    const ipcMain = new EventEmitter();
    ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
    ipcMain.removeHandler = channel => handlers.delete(channel);
    const sessionRef = { current: null };
    const failure = { code: 'source_enumeration_failed', error: 'Failed to get sources.', stage: 'sources', at: Date.now() };
    let active = false;
    const overlay = {
        isActive: () => active,
        begin: () => {
            active = true;
            calls.push('begin');
            return { success: true };
        },
        end: (reason, restoreMain = true) => {
            active = false;
            calls.push('end');
            endRequests.push({ reason, restoreMain });
            return { success: true };
        },
        toggle: () => {
            calls.push('toggle');
            return { success: true };
        },
        recordSource() {},
    };
    class Window extends EventEmitter {
        constructor() {
            super();
            this.destroyed = false;
            this.visible = true;
            this.minimized = false;
            this.focused = false;
            this.webContents = new EventEmitter();
            this.webContents.mainFrame = {};
            this.webContents.send = (...args) => rendererMessages.push(args);
        }
        isDestroyed() {
            return this.destroyed;
        }
        isVisible() {
            return this.visible;
        }
        hide() {
            this.visible = false;
            calls.push('hide-main');
        }
        showInactive() {
            this.visible = true;
            calls.push('show-main');
        }
        show() {
            this.visible = true;
            calls.push('show-main-focused');
        }
        isMinimized() {
            return this.minimized;
        }
        restore() {
            this.minimized = false;
            calls.push('restore-main');
        }
        focus() {
            this.focused = true;
            calls.push('focus-main');
        }
        setIgnoreMouseEvents(ignored) {
            mouseEventStates.push(ignored);
        }
        setContentProtection() {}
        setVisibleOnAllWorkspaces() {}
        setAlwaysOnTop() {}
        setSkipTaskbar() {}
        setHiddenInMissionControl() {}
        loadFile() {}
    }
    let actions;
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/utils/window.js'), 'utf8'), {
        module,
        __dirname: path.resolve(__dirname, '../src/utils'),
        process: { platform },
        console,
        require(name) {
            if (name === 'node:path') return path;
            if (name === 'electron')
                return {
                    app: {},
                    BrowserWindow: Window,
                    globalShortcut: {},
                    ipcMain,
                    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
                    session: { defaultSession: {} },
                    desktopCapturer: {},
                    systemPreferences: {
                        getMediaAccessStatus(type) {
                            assert.equal(type, 'screen');
                            if (permissionThrows) throw new Error('Unavailable');
                            return permissionStatus;
                        },
                    },
                };
            if (name === '../storage') return { getKeybinds: () => null, getPreferences: () => ({}) };
            if (name === './reviewAppearance') return require('../src/utils/reviewAppearance');
            if (name === './screenCapture') return { registerAutomaticScreenCapture: () => ({ getLastFailure: () => ({ ...failure }) }) };
            if (name === './reviewOverlay') return { createReviewOverlay: () => overlay };
            if (name === './keybinds')
                return {
                    getDefaultKeybinds() {},
                    createShortcutRegistrar: () => ({
                        update(_, registered) {
                            actions = registered;
                            return { success: true, failures: [] };
                        },
                        setPaused() {},
                    }),
                };
            if (name === './gemini')
                return {
                    closeActiveSession(ref) {
                        assert.equal(ref, sessionRef);
                        calls.push('abort-provider');
                        overlay.end();
                    },
                };
            throw new Error(`Unexpected module: ${name}`);
        },
    });
    const window = module.exports.createWindow((...args) => rendererMessages.push(args), sessionRef);
    const trusted = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    return { window, handlers, calls, endRequests, overlay, trusted, actions, ipcMain, rendererMessages, mouseEventStates };
}

test('review IPC rejects another window and a child frame before changing main visibility', async () => {
    const h = harness();
    for (const event of [{ sender: {} }, { sender: h.window.webContents, senderFrame: {} }]) {
        assert.equal(h.handlers.get('review:begin')(event).success, false);
        assert.equal((await h.handlers.get('toggle-window-visibility')(event)).success, false);
    }
    assert.deepEqual(h.calls, []);
});

for (const platform of ['darwin', 'win32']) {
    test(`visibility recovery restores a hidden click-through window without ending its session on ${platform}`, () => {
        const h = harness({ platform });
        h.actions.toggleClickThrough();
        h.window.visible = false;
        h.window.minimized = true;
        h.actions.openVisibilitySettings();
        assert.equal(h.window.visible, true);
        assert.equal(h.window.minimized, false);
        assert.equal(h.window.focused, true);
        assert.deepEqual(h.mouseEventStates, [true, false]);
        assert.deepEqual(h.rendererMessages, [['click-through-toggled', true], ['click-through-toggled', false], ['open-test-visibility']]);
        assert.deepEqual(h.calls, ['restore-main', 'show-main-focused', 'focus-main']);
        h.actions.toggleClickThrough();
        assert.equal(h.mouseEventStates.at(-1), true, 'Recovery resets the stored click-through state as well as the native window');
        h.window.destroyed = true;
        const previousMessages = h.rendererMessages.length;
        h.actions.openVisibilitySettings();
        assert.equal(h.rendererMessages.length, previousMessages, 'Recovery does not send to a destroyed renderer');
    });
}

test('only the main frame can restore click-through via view changes and returning to a session preserves the reset state', () => {
    const h = harness();
    h.actions.toggleClickThrough();
    for (const event of [{ sender: {} }, { sender: h.window.webContents, senderFrame: {} }, { sender: h.window.webContents }]) {
        h.ipcMain.emit('view-changed', event, 'test-visibility');
    }
    h.ipcMain.emit('view-changed', h.trusted, {});
    assert.deepEqual(h.mouseEventStates, [true]);
    h.ipcMain.emit('view-changed', h.trusted, 'test-visibility');
    assert.deepEqual(h.mouseEventStates, [true, false]);
    h.ipcMain.emit('view-changed', h.trusted, 'assistant');
    h.actions.toggleClickThrough();
    assert.deepEqual(h.mouseEventStates, [true, false, true]);
    assert.deepEqual(h.rendererMessages, [
        ['click-through-toggled', true],
        ['click-through-toggled', false],
        ['click-through-toggled', true],
    ]);
    assert.deepEqual(h.calls, [], 'Opening settings does not end capture or change Review marks');
});

for (const platform of ['darwin', 'win32']) {
    test(`app shortcut and IPC always toggle the main window independently of Review marks on ${platform}`, async () => {
        const h = harness({ platform });
        h.actions.toggleReviewMarks();
        assert.deepEqual(h.calls, [], 'The Review shortcut is inactive in ordinary screen mode');
        h.actions.toggleVisibility();
        assert.equal(h.window.visible, false);
        await h.handlers.get('toggle-window-visibility')(h.trusted);
        assert.equal(h.window.visible, true);
        h.handlers.get('review:begin')(h.trusted);

        h.actions.toggleVisibility();
        assert.equal(h.window.visible, false);
        h.actions.toggleReviewMarks();
        assert.equal(h.window.visible, false, 'Review marks may toggle while the app stays hidden');
        await h.handlers.get('toggle-window-visibility')(h.trusted);
        assert.equal(h.window.visible, true);
        h.actions.toggleReviewMarks();
        assert.equal(h.window.visible, true, 'Review marks do not hide a visible app');
        assert.deepEqual(h.calls, ['hide-main', 'show-main', 'begin', 'hide-main', 'toggle', 'show-main', 'toggle']);

        h.overlay.end();
        const count = h.calls.length;
        h.actions.toggleReviewMarks();
        assert.equal(h.calls.length, count);
        h.actions.toggleVisibility();
        assert.equal(h.window.visible, false, 'App visibility retains ordinary behavior after Review ends');

        h.handlers.get('review:begin')(h.trusted);
        h.window.destroyed = true;
        const destroyedCount = h.calls.length;
        h.actions.toggleVisibility();
        h.actions.toggleReviewMarks();
        assert.equal((await h.handlers.get('toggle-window-visibility')(h.trusted)).success, false);
        assert.equal(h.calls.length, destroyedCount, 'Destroyed windows cannot invoke either visibility action');
    });
}

test('only the trusted main frame may request a silent review end and malformed visibility options are rejected', () => {
    const h = harness();
    const handler = h.handlers.get('review:end');
    h.handlers.get('review:begin')(h.trusted);
    for (const event of [{ sender: {} }, { sender: h.window.webContents, senderFrame: {} }]) {
        assert.equal(handler(event, { silent: true }).success, false);
    }
    for (const options of [null, true, 'silent', [], { silent: 1 }, { silent: 'true' }, { silent: true, other: true }]) {
        assert.equal(handler(h.trusted, options).success, false);
    }
    assert.equal(h.overlay.isActive(), true);
    assert.deepEqual(h.endRequests, []);
    assert.equal(handler(h.trusted, { silent: true }).success, true);
    assert.equal(h.endRequests.at(-1).restoreMain, false);
    h.handlers.get('review:begin')(h.trusted);
    assert.equal(handler(h.trusted).success, true);
    assert.equal(h.endRequests.at(-1).restoreMain, true, 'An explicit End Session keeps the original controls behavior');
    h.handlers.get('review:begin')(h.trusted);
    assert.equal(handler(h.trusted, { silent: false }).success, true);
    assert.equal(h.endRequests.at(-1).restoreMain, true);
});

test('closing the main window aborts a pending review provider before removing overlay and IPC handlers', () => {
    const h = harness();
    h.handlers.get('review:begin')(h.trusted);
    h.window.destroyed = true;
    h.window.emit('closed');
    assert.deepEqual(h.calls, ['begin', 'abort-provider', 'end', 'end']);
    assert.equal(h.overlay.isActive(), false);
    assert.equal(h.handlers.size, 0);
    assert.equal(h.ipcMain.listenerCount('view-changed'), 0);
    h.window.emit('closed');
    assert.equal(h.calls.filter(call => call === 'abort-provider').length, 1);
});

test('closing an ordinary screen window does not invoke the review shutdown path', () => {
    const h = harness();
    h.window.destroyed = true;
    h.window.emit('closed');
    assert.deepEqual(h.calls, ['end']);
    assert.equal(h.handlers.size, 0);
});

test('capture diagnostics report the original source failure and live macOS permission status only to the main frame', () => {
    const h = harness({ platform: 'darwin', permissionStatus: 'granted' });
    const handler = h.handlers.get('screen-capture:diagnostics');
    for (const event of [{ sender: {} }, { sender: h.window.webContents, senderFrame: {} }]) {
        assert.equal(handler(event).success, false);
    }
    const result = handler(h.trusted);
    assert.equal(result.permissionStatus, 'granted');
    assert.equal(result.failure.error, 'Failed to get sources.');
    assert.equal(result.failure.code, 'source_enumeration_failed');
    assert.equal(result.failure.stage, 'sources');
});

test('unavailable permission status and Windows diagnostics do not claim a macOS denial', () => {
    for (const options of [{ platform: 'win32' }, { platform: 'darwin', permissionThrows: true }]) {
        const h = harness(options);
        assert.equal(h.handlers.get('screen-capture:diagnostics')(h.trusted).permissionStatus, 'unknown');
    }
});
