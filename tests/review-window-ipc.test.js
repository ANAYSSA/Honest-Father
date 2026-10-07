const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function harness({ platform = 'win32', permissionStatus = 'unknown', permissionThrows = false, preferences = {} } = {}) {
    const handlers = new Map();
    const calls = [];
    const rendererMessages = [];
    const mouseEventStates = [];
    const focusableStates = [];
    const endRequests = [];
    const ipcMain = new EventEmitter();
    ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
    ipcMain.removeHandler = channel => handlers.delete(channel);
    const screen = new EventEmitter();
    screen.displays = [
        { id: 1, label: 'Built-in', workArea: { x: 0, y: 25, width: 1920, height: 1055 }, workAreaSize: { width: 1920, height: 1055 } },
    ];
    screen.getAllDisplays = () => screen.displays;
    screen.getPrimaryDisplay = () => screen.displays[0];
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
            this.bounds = { x: 100, y: 100, width: 1100, height: 800 };
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
        blur() {
            this.focused = false;
        }
        getBounds() {
            return { ...this.bounds };
        }
        setBounds(bounds) {
            this.bounds = { ...bounds };
        }
        setMinimumSize(width, height) {
            this.minimumSize = [width, height];
        }
        setResizable(value) {
            this.resizable = value;
        }
        setFocusable(value) {
            this.focusable = value;
            focusableStates.push(value);
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
                    screen,
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
            if (name === '../storage')
                return {
                    getKeybinds: () => null,
                    getPreferences: () => preferences,
                    updatePreference: (key, value) => {
                        preferences[key] = value;
                        return true;
                    },
                };
            if (name === './answerPlacement') return require('../src/utils/answerPlacement');
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
    return {
        window,
        handlers,
        calls,
        endRequests,
        overlay,
        trusted,
        actions,
        ipcMain,
        rendererMessages,
        mouseEventStates,
        focusableStates,
        preferences,
        screen,
    };
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

test('only the main frame can restore interaction and returning to a session enforces pass-through', () => {
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
    test(`assistant is mouse-transparent, unfocusable, and keyboard-movable while empty or hidden on ${platform}`, () => {
        const h = harness({ platform });
        h.window.focused = true;
        h.ipcMain.emit('view-changed', h.trusted, 'assistant');
        assert.equal(h.window.focusable, false);
        assert.equal(h.window.focused, false, 'Starting a session releases existing keyboard focus, including on macOS');
        assert.equal(h.window.resizable, false);
        assert.deepEqual(h.mouseEventStates, [true]);
        h.actions.toggleClickThrough();
        assert.deepEqual(h.mouseEventStates, [true], 'The legacy toggle cannot make an answer intercept clicks');
        const previous = h.window.getBounds();
        h.window.visible = false;
        h.actions.moveDown();
        assert.equal(h.window.visible, false, 'Positioning does not reveal or focus an invisible answer');
        assert.ok(h.window.bounds.y > previous.y);
        assert.equal(h.preferences.answerPlacement.displayId, '1');
        const moved = h.window.getBounds();
        h.actions.openVisibilitySettings();
        assert.equal(h.window.focusable, true);
        assert.equal(h.window.focused, true);
        assert.equal(h.mouseEventStates.at(-1), false);
        assert.equal(h.window.bounds.y, 100, 'Settings retain their ordinary full-size window bounds');
        h.ipcMain.emit('view-changed', h.trusted, 'test-visibility');
        h.ipcMain.emit('view-changed', h.trusted, 'assistant');
        assert.deepEqual(h.window.getBounds(), moved, 'Returning restores the answer position');
        assert.equal(h.window.focused, false);
        assert.equal(h.window.focusable, false);
        assert.equal(h.mouseEventStates.at(-1), true);
    });
}

test('answer placement IPC is main-frame only and disconnected monitors recover onto a connected screen', () => {
    const h = harness({ preferences: { answerPlacement: { displayId: '2', x: 100, y: 100, width: 640, height: 240 } } });
    h.screen.displays.push({ id: 2, label: 'External', workArea: { x: -1600, y: 0, width: 1600, height: 900 } });
    const handler = h.handlers.get('get-answer-displays');
    assert.equal(handler({ sender: h.window.webContents, senderFrame: {} }).success, false);
    const layout = handler(h.trusted);
    assert.equal(layout.success, true);
    assert.equal(layout.displays.length, 2);
    assert.equal(layout.placement.displayId, '2');
    h.ipcMain.emit('view-changed', h.trusted, 'assistant');
    assert.deepEqual(h.window.getBounds(), { x: -640, y: 660, width: 640, height: 240 });
    h.screen.displays.pop();
    h.screen.emit('display-removed');
    assert.deepEqual(h.window.getBounds(), { x: 1280, y: 840, width: 640, height: 240 });
    assert.equal(h.preferences.answerPlacement.displayId, '1');
    for (let i = 0; i < 30; i++) h.actions.moveRight();
    assert.equal(h.window.bounds.x, 1280, 'Repeated shortcuts cannot move the answer off-screen');
    h.window.emit('closed');
    assert.equal(h.screen.listenerCount('display-removed'), 0);
    assert.equal(h.screen.listenerCount('display-metrics-changed'), 0);
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
