const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function harness() {
    const handlers = new Map();
    const calls = [];
    const ipcMain = new EventEmitter();
    ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
    ipcMain.removeHandler = channel => handlers.delete(channel);
    const sessionRef = { current: null };
    let active = false;
    const overlay = {
        isActive: () => active,
        begin: () => {
            active = true;
            calls.push('begin');
            return { success: true };
        },
        end: () => {
            active = false;
            calls.push('end');
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
        loadFile() {}
    }
    let actions;
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/utils/window.js'), 'utf8'), {
        module,
        __dirname: path.resolve(__dirname, '../src/utils'),
        process: { platform: 'win32' },
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
                };
            if (name === '../storage') return { getKeybinds: () => null };
            if (name === './screenCapture') return { registerAutomaticScreenCapture() {} };
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
    return { window, handlers, calls, overlay, trusted, actions, ipcMain };
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
