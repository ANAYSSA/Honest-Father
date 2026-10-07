const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const [platform, modifier, shortcut] of [
    ['MacIntel', 'metaKey', 'cmd+enter'],
    ['Win32', 'ctrlKey', 'ctrl+enter'],
]) {
    test(`focused Home ${shortcut} follows the screen-only shortcut path without calling Live Start`, () => {
        let View;
        const shortcuts = [];
        const source = fs
            .readFileSync(path.resolve(__dirname, '../src/components/views/MainView.js'), 'utf8')
            .replace(/^import[^\n]+\n/, '')
            .replace('export class MainView', 'class MainView');
        vm.runInNewContext(source, {
            LitElement: class {},
            html: () => '',
            css: () => '',
            customElements: {
                define: (name, constructor) => {
                    View = constructor;
                },
            },
            navigator: { platform },
            cheatingDaddy: { handleShortcut: key => shortcuts.push(key) },
        });
        const view = Object.create(View.prototype);
        view._handleStart = () => assert.fail('Screenshot hotkey must not start a Live session');
        let prevented = false;
        view._handleKeydown({
            key: 'Enter',
            [modifier]: true,
            preventDefault: () => {
                prevented = true;
            },
        });
        assert.equal(prevented, true);
        assert.deepEqual(shortcuts, [shortcut]);
        view._handleKeydown({ key: 'Enter', preventDefault: () => assert.fail('Plain Enter must not start screen sharing') });
        assert.deepEqual(shortcuts, [shortcut]);
    });
}

function loadMainView() {
    let View;
    const source = fs
        .readFileSync(path.resolve(__dirname, '../src/components/views/MainView.js'), 'utf8')
        .replace(/^import[^\n]+\n/, '')
        .replace('export class MainView', 'class MainView');
    vm.runInNewContext(source, {
        LitElement: class {},
        html: (strings, ...values) => ({ strings: Array.from(strings), values }),
        css: () => '',
        customElements: { define: (_, constructor) => (View = constructor) },
        navigator: { platform: 'MacIntel' },
    });
    return Object.assign(Object.create(View.prototype), {
        _mode: 'byok',
        _geminiKey: 'test-key',
        downloadProgress: { active: false },
        requestUpdate() {},
    });
}

test('Home offers separate ordinary and test-review start buttons using their own callbacks', () => {
    const view = loadMainView();
    const started = [];
    view.onStart = () => started.push('ordinary');
    view.onStartReview = () => started.push('review');
    view._handleStart();
    view._handleStartReview();
    assert.deepEqual(started, ['ordinary', 'review']);
    const output = view._renderStartButton();
    assert.match(output.strings.join(''), /Start Test Review/);
    assert.equal(output.values.includes('Start Session'), true);
    assert.equal((output.strings.join('').match(/<button/g) || []).length, 2);
});

test('both Home start actions remain blocked while initialization or a model download is active', () => {
    const view = loadMainView();
    view.onStart = view.onStartReview = () => assert.fail('A second start must not interrupt initialization');
    view.isInitializing = true;
    view._handleStart();
    view._handleStartReview();
    view.isInitializing = false;
    view.downloadProgress.active = true;
    view._handleStart();
    view._handleStartReview();
});

function loadApp({ local = false } = {}) {
    let App;
    const calls = [];
    const api = {
        storage: { getPreferences: async () => ({ providerMode: local ? 'local' : 'byok' }) },
        initializeScreenSession: async (...args) => (calls.push(['initialize-screen', ...args]), true),
        initializeLocal: async (...args) => (calls.push(['initialize-local', ...args]), true),
        startCapture: async (...args) => (calls.push(['capture', ...args]), true),
        captureManualScreenshot: async () => (calls.push(['screenshot']), true),
        stopCapture: () => calls.push(['stop']),
    };
    const source = fs
        .readFileSync(path.resolve(__dirname, '../src/components/app/CheatingDaddyApp.js'), 'utf8')
        .replace(/^import[^\n]+\n/gm, '')
        .replace('export class CheatingDaddyApp', 'class CheatingDaddyApp');
    vm.runInNewContext(source, {
        LitElement: class {},
        html: (strings, ...values) => ({ strings: Array.from(strings), values }),
        css: () => '',
        customElements: { define: (_, constructor) => (App = constructor) },
        cheatingDaddy: api,
        window: {
            require: name =>
                name === './utils/testVisibility'
                    ? require('../src/utils/testVisibility')
                    : { ipcRenderer: { invoke: async (...args) => calls.push(['ipc', ...args]) } },
        },
        console: { error() {} },
    });
    const app = Object.assign(Object.create(App.prototype), {
        selectedProfile: 'exam',
        selectedScreenshotInterval: '5',
        selectedImageQuality: 'medium',
        currentView: 'main',
        sessionActive: false,
        testReview: false,
        responses: [],
        requestUpdate() {},
        updateComplete: Promise.resolve(),
        _startTimer() {},
        _stopTimer() {},
    });
    return { app, calls };
}

test('Test Review start uses the screen provider and capture flag then takes the first screenshot', async () => {
    const { app, calls } = loadApp();
    await app.handleScreenStart(true);
    assert.deepEqual(calls, [['initialize-screen', 'exam', true], ['capture', '5', 'medium', true, true], ['screenshot']]);
    assert.equal(app.sessionActive, true);
    assert.equal(app.testReview, true);
    assert.equal(app.currentView, 'assistant');
    await app.handleClose();
    assert.equal(app.testReview, false);
    assert.equal(app.sessionActive, false);
    assert.equal(app.currentView, 'main');
});

test('ordinary Home screenshot start still uses text mode and clears the review flag', async () => {
    const { app, calls } = loadApp();
    app.testReview = true;
    await app.handleScreenStart();
    assert.deepEqual(calls[0], ['initialize-screen', 'exam', false]);
    assert.deepEqual(calls[1], ['capture', '5', 'medium', true, false]);
    assert.equal(app.testReview, false);
});

test('local models report unsupported Test Review before starting any provider or capture', async () => {
    const { app, calls } = loadApp({ local: true });
    await app.handleScreenStart(true);
    assert.deepEqual(calls, []);
    assert.equal(app.sessionActive, false);
    assert.equal(app.currentView, 'main');
    assert.match(app.statusText, /Test Review needs a vision provider/);
});

test('a provider session ending resets the Test Review flag', () => {
    const { app } = loadApp();
    app.sessionActive = true;
    app.testReview = true;
    app.currentView = 'assistant';
    app.handleSessionEnded('Screen capture stopped');
    assert.equal(app.sessionActive, false);
    assert.equal(app.testReview, false);
    assert.equal(app.currentView, 'main');
});

test('ordinary Live session ending keeps its existing assistant view behavior', () => {
    const { app } = loadApp();
    app.sessionActive = true;
    app.currentView = 'assistant';
    app.handleSessionEnded('Live session ended');
    assert.equal(app.sessionActive, false);
    assert.equal(app.currentView, 'assistant');
});
