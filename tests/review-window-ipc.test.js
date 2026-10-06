const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function harness({ platform = 'win32', permissionStatus = 'unknown', permissionThrows = false } = {}) {
    const handlers = new Map();
    const calls = [];
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
            this.webContents = new EventEmitter();
            this.webContents.mainFrame = {};
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
            if (name === '../storage') return { getKeybinds: () => null };
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
    const window = module.exports.createWindow(() => {}, sessionRef);
    const trusted = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    return { window, handlers, calls, endRequests, overlay, trusted, actions, ipcMain };
}

test('review IPC rejects another window and a child frame, and visibility routes to the active overlay', async () => {
    const h = harness();
    for (const event of [{ sender: {} }, { sender: h.window.webContents, senderFrame: {} }]) {
        assert.equal(h.handlers.get('review:begin')(event).success, false);
        assert.equal((await h.handlers.get('toggle-window-visibility')(event)).success, false);
    }
    assert.deepEqual(h.calls, []);
    h.handlers.get('review:begin')(h.trusted);
    h.actions.toggleVisibility();
    await h.handlers.get('toggle-window-visibility')(h.trusted);
    assert.deepEqual(h.calls, ['begin', 'toggle', 'toggle']);
    h.overlay.end();
    h.actions.toggleVisibility();
    assert.equal(h.window.visible, false);
    assert.equal(h.calls.at(-1), 'hide-main');
});

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
