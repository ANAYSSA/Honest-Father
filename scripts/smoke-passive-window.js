const assert = require('node:assert/strict');
const { globalShortcut, screen } = require('electron');

// Record callbacks while still registering every shortcut with the real OS.
// Calling the recorded callback exercises the same production action without
// synthesizing keyboard events into another application.
function captureShortcuts() {
    const callbacks = new Map();
    const register = globalShortcut.register;
    globalShortcut.register = function (accelerator, callback) {
        const registered = register.call(this, accelerator, callback);
        if (registered) callbacks.set(accelerator, callback);
        return registered;
    };
    return {
        trigger(accelerator) {
            const callback = callbacks.get(accelerator);
            assert.equal(typeof callback, 'function', `Native shortcut is registered: ${accelerator}`);
            callback();
        },
        restore() {
            globalShortcut.register = register;
        },
    };
}

async function checkPassiveWindow(window, shortcuts) {
    const storage = require('../src/storage');
    const originalPlacement = storage.getPreferences().answerPlacement;
    const originalBounds = window.getBounds();
    const setIgnoreMouseEvents = window.setIgnoreMouseEvents;
    let ignoresMouse = null;
    window.setIgnoreMouseEvents = function (ignore, ...args) {
        ignoresMouse = ignore;
        return setIgnoreMouseEvents.call(this, ignore, ...args);
    };
    const primary = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
    const waitForNative = async expectedView => {
        for (let attempt = 0; attempt < 100; attempt++) {
            const view = await window.webContents.executeJavaScript(`(async () => {
                const app = document.querySelector('cheating-daddy-app');
                await app.updateComplete;
                await window.require('electron').ipcRenderer.invoke('get-answer-displays');
                return app.currentView;
            })()`);
            if (view === expectedView && window.isFocusable() === (expectedView !== 'assistant')) return;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail(`Native window did not enter ${expectedView}`);
    };
    await window.webContents.executeJavaScript(`(() => {
        const app = document.querySelector('cheating-daddy-app');
        window.__passiveWindowSmoke = {
            currentView: app.currentView, sessionActive: app.sessionActive, testReview: app.testReview,
            responses: app.responses, currentResponseIndex: app.currentResponseIndex,
            visibilityPreferences: app.visibilityPreferences,
        };
    })()`);
    try {
        shortcuts.trigger(`${primary}+Shift+,`);
        await waitForNative('test-visibility');
        assert.equal(window.isFocusable(), true, 'Visibility settings accept focus');
        assert.equal(ignoresMouse, false, 'Visibility settings accept mouse input');
        const settingsBounds = window.getBounds();
        const display = screen.getPrimaryDisplay();
        const area = display.workArea;
        const placement = {
            displayId: String(display.id),
            x: 25,
            y: 20,
            width: Math.max(320, Math.min(640, area.width)),
            height: Math.max(120, Math.min(240, area.height)),
        };
        assert.notEqual(storage.updatePreference('answerPlacement', placement), false);
        await window.webContents.executeJavaScript(`(async () => {
            const app = document.querySelector('cheating-daddy-app');
            app.testReview = false;
            app.sessionActive = true;
            app.responses = [];
            app.currentResponseIndex = -1;
            app.visibilityPreferences = { ...app.visibilityPreferences, blindMode: true, answerTextOpacity: 0, answerFrameOpacity: 0 };
            app.currentView = 'assistant';
            await app.updateComplete;
        })()`);
        await waitForNative('assistant');
        const width = Math.min(placement.width, area.width);
        const height = Math.min(placement.height, area.height);
        const initialBounds = {
            x: Math.round(area.x + ((area.width - width) * placement.x) / 100),
            y: Math.round(area.y + ((area.height - height) * placement.y) / 100),
            width,
            height,
        };
        assert.deepEqual(window.getBounds(), initialBounds, 'Saved placement applies before the first answer exists');
        assert.equal(window.isFocusable(), false, 'An active answer cannot take keyboard focus');
        assert.equal(window.isFocused(), false, 'Starting an answer releases the existing native key-window focus');
        assert.equal(window.isResizable(), false, 'An active answer has no interactive resizing surface');
        assert.equal(ignoresMouse, true, 'The actual native answer window passes mouse input through');
        shortcuts.trigger(`${primary}+M`);
        assert.equal(ignoresMouse, true, 'Legacy click-through toggle cannot make active answers intercept clicks');
        shortcuts.trigger('Alt+Down');
        const downBounds = window.getBounds();
        if (area.height > height) assert.ok(downBounds.y > initialBounds.y, 'Option/Alt+Down moves the passive answer');
        const savedAfterDown = storage.getPreferences().answerPlacement;
        assert.equal(savedAfterDown.displayId, String(display.id));
        assert.ok(
            Math.abs(area.y + ((area.height - height) * savedAfterDown.y) / 100 - downBounds.y) < 1,
            'Keyboard movement persists its actual position'
        );
        shortcuts.trigger(`${primary}+\\`);
        assert.equal(window.isVisible(), false, 'A passive answer can be hidden');
        shortcuts.trigger('Alt+Up');
        const hiddenBounds = window.getBounds();
        if (area.height > height) assert.ok(hiddenBounds.y < downBounds.y, 'An invisible answer can still be positioned with Option/Alt+Up');
        assert.equal(window.isVisible(), false, 'Moving a hidden answer does not reveal it');
        assert.equal(window.isFocusable(), false);
        assert.equal(ignoresMouse, true);
        shortcuts.trigger(`${primary}+Shift+,`);
        await waitForNative('test-visibility');
        assert.equal(window.isVisible(), true, 'Recovery reveals readable settings from an invisible answer');
        assert.equal(window.isFocusable(), true, 'Recovery restores native focusability');
        assert.equal(ignoresMouse, false, 'Recovery restores native mouse interaction');
        assert.equal(window.isResizable(), true, 'Settings can be resized again');
        assert.deepEqual(window.getBounds(), settingsBounds, 'Settings restore their independent window bounds');
        await window.webContents.executeJavaScript(`(async () => {
            const app = document.querySelector('cheating-daddy-app');
            await app.updateComplete;
            if (!app.sessionActive || app.responses.length) throw new Error('Recovery altered the empty active session');
            const button = app.shadowRoot.querySelector('.session-return button');
            if (!button) throw new Error('Return to session is missing');
            button.click();
            await app.updateComplete;
        })()`);
        await waitForNative('assistant');
        assert.deepEqual(window.getBounds(), hiddenBounds, 'Returning to the session restores its keyboard-adjusted position');
        assert.equal(window.isFocused(), false, 'Returning from settings releases focus again');
        assert.equal(ignoresMouse, true);
        console.log('Native passive window smoke passed: saved placement, Option/Alt+Arrow, click-through, focus recovery and return.');
    } finally {
        await window.webContents.executeJavaScript(`(async () => {
            const app = document.querySelector('cheating-daddy-app');
            Object.assign(app, window.__passiveWindowSmoke);
            delete window.__passiveWindowSmoke;
            await app.updateComplete;
            await window.require('electron').ipcRenderer.invoke('get-answer-displays');
        })()`);
        storage.updatePreference('answerPlacement', originalPlacement);
        window.setBounds(originalBounds, false);
        window.setIgnoreMouseEvents = setIgnoreMouseEvents;
    }
}

module.exports = { captureShortcuts, checkPassiveWindow };
