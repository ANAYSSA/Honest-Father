const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createReviewOverlay } = require('../src/utils/reviewOverlay');
const { parseReviewAnswer } = require('../src/utils/testReview');

function makeAnswer() {
    return parseReviewAnswer(
        JSON.stringify({ question_box: [100, 100, 900, 900], answers: [{ label: 'B', box: [300, 300, 320, 320] }], confidence: 0.95 })
    );
}

function makeHarness(platform = 'darwin', { clampConstructor = false } = {}) {
    const windows = [];
    class FakeWindow extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
            if (clampConstructor && typeof this.bounds.height === 'number') this.bounds.height -= 48;
            this.initialBounds = { ...this.bounds };
            this.visible = false;
            this.destroyed = false;
            this.calls = [];
            this.webContents = new EventEmitter();
            this.webContents.messages = [];
            this.webContents.send = (channel, payload) => this.webContents.messages.push({ channel, payload });
            this.webContents.setWindowOpenHandler = handler => (this.openHandler = handler);
            windows.push(this);
        }
        isDestroyed() {
            return this.destroyed;
        }
        isVisible() {
            return this.visible;
        }
        getBounds() {
            return { ...this.bounds };
        }
        setBounds(bounds, animate) {
            this.calls.push(['setBounds', { ...bounds }, animate]);
            if (!this.refuseBounds) this.bounds = { ...bounds };
        }
        hide() {
            this.visible = false;
            this.calls.push(['hide']);
        }
        showInactive() {
            this.visible = true;
            this.calls.push(['showInactive']);
        }
        destroy() {
            this.destroyed = true;
            this.visible = false;
            this.emit('closed');
        }
        setIgnoreMouseEvents(...args) {
            this.calls.push(['setIgnoreMouseEvents', ...args]);
        }
        setContentProtection(...args) {
            this.calls.push(['setContentProtection', ...args]);
        }
        setSkipTaskbar(...args) {
            this.calls.push(['setSkipTaskbar', ...args]);
        }
        setAlwaysOnTop(...args) {
            this.calls.push(['setAlwaysOnTop', ...args]);
        }
        setVisibleOnAllWorkspaces(...args) {
            this.calls.push(['setVisibleOnAllWorkspaces', ...args]);
        }
        setHiddenInMissionControl(...args) {
            this.calls.push(['setHiddenInMissionControl', ...args]);
        }
        loadFile(file) {
            this.loadedFile = file;
            return new Promise((resolve, reject) => {
                this.resolveLoad = resolve;
                this.rejectLoad = reject;
            });
        }
        ready() {
            this.webContents.emit('did-finish-load');
            this.resolveLoad();
        }
    }
    const mainWindow = new FakeWindow({});
    windows.length = 0;
    mainWindow.visible = true;
    const screen = new EventEmitter();
    const displays = [
        { id: 11, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, rotation: 0 },
        { id: 22, bounds: { x: -1440, y: -200, width: 1440, height: 900 }, scaleFactor: 2, rotation: 0 },
    ];
    screen.getAllDisplays = () => displays;
    const endings = [];
    const createdCallbacks = [];
    let id = 0;
    const manager = createReviewOverlay({
        BrowserWindow: FakeWindow,
        screen,
        mainWindow,
        platform,
        onEnd: reason => endings.push(reason),
        onWindowCreated: window => createdCallbacks.push(window),
        createId: () => `id-${++id}`,
    });
    return {
        manager,
        mainWindow,
        screen,
        displays,
        windows,
        endings,
        createdCallbacks,
        dimensions: { imageWidth: 2880, imageHeight: 1800 },
        start() {
            assert.equal(manager.recordSource({ id: 'screen:11:0', display_id: '22' }).success, true);
            assert.equal(manager.begin().success, true);
            return windows.at(-1);
        },
        answer() {
            const token = manager.prepareCapture();
            assert.equal(manager.cacheAnswer(token, makeAnswer(), this.dimensions).success, true);
            return token;
        },
    };
}

test('review cannot begin before an actual capture source matches an existing display', () => {
    const harness = makeHarness();
    assert.equal(harness.manager.begin().success, false);
    assert.equal(harness.manager.recordSource({ display_id: 'missing' }).success, false);
    assert.equal(harness.manager.begin().success, false);
    assert.equal(harness.windows.length, 0);
    assert.equal(harness.mainWindow.isVisible(), true);
});

test('overlay occupies the actual capture display including negative origin and uses secure click-through options', () => {
    const harness = makeHarness();
    const window = harness.start();
    assert.equal(harness.mainWindow.isVisible(), false);
    assert.equal(harness.manager.isActive(), true);
    assert.deepEqual([window.options.x, window.options.y, window.options.width, window.options.height], [-1440, -200, 1440, 900]);
    assert.equal(window.options.show, false);
    assert.equal(window.options.focusable, false);
    assert.equal(window.options.transparent, true);
    assert.equal(window.options.skipTaskbar, true);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.contextIsolation, true);
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.match(window.options.webPreferences.preload, /review-overlay-preload\.js$/);
    assert.deepEqual(window.openHandler(), { action: 'deny' });
    assert.deepEqual(
        window.calls.find(call => call[0] === 'setIgnoreMouseEvents'),
        ['setIgnoreMouseEvents', true, { forward: true }]
    );
    assert.deepEqual(
        window.calls.find(call => call[0] === 'setContentProtection'),
        ['setContentProtection', true]
    );
    assert.deepEqual(
        window.calls.find(call => call[0] === 'setHiddenInMissionControl'),
        ['setHiddenInMissionControl', true]
    );
    assert.equal(window.calls.find(call => call[0] === 'setVisibleOnAllWorkspaces')[2].skipTransformProcessType, true);
    let prevented = false;
    window.webContents.emit('will-navigate', { preventDefault: () => (prevented = true) });
    assert.equal(prevented, true);
});

test('Windows constructor work-area clamping is corrected to the complete captured display before load and every reveal', () => {
    const harness = makeHarness('win32', { clampConstructor: true });
    const expectedBounds = { x: 0, y: 0, width: 1024, height: 768 };
    harness.displays[1].bounds = { ...expectedBounds };
    harness.displays[1].scaleFactor = 1;
    harness.dimensions = { imageWidth: 1024, imageHeight: 768 };
    const window = harness.start();
    assert.equal(window.initialBounds.height, 720);
    assert.deepEqual(window.getBounds(), expectedBounds);
    assert.deepEqual(
        window.calls.find(call => call[0] === 'setBounds'),
        ['setBounds', expectedBounds, false]
    );
    window.bounds.height = 720;
    window.ready();
    assert.deepEqual(window.getBounds(), expectedBounds);
    const token = harness.answer();
    window.bounds.height = 720;
    assert.equal(harness.manager.showAnswer(token, { x: 0, y: 0 }).success, true);
    assert.equal(window.isVisible(), true);
    assert.deepEqual(window.getBounds(), expectedBounds);
    assert.equal(window.calls.filter(call => call[0] === 'setBounds').length, 3);
    const control = window.webContents.messages.at(-1).payload.answers[0].box;
    assert.equal(control.x, 307.2);
    assert.ok(Math.abs(control.y - 230.4) < 1e-9);
    assert.equal(control.width, 20.48);
    assert.equal(control.height, 15.36);
    harness.manager.toggle();
    assert.equal(window.isVisible(), false);
    harness.manager.moveAnswer(token, { x: 0, y: 0 });
    assert.equal(window.isVisible(), false);
});

test('working macOS full-display bounds do not receive an unnecessary native reposition', () => {
    const harness = makeHarness('darwin');
    const window = harness.start();
    window.ready();
    const token = harness.answer();
    harness.manager.showAnswer(token, { x: 0, y: 0 });
    assert.deepEqual(window.getBounds(), harness.displays[1].bounds);
    assert.equal(
        window.calls.some(call => call[0] === 'setBounds'),
        false
    );
});

test('native bounds that remain clamped prevent drawing and end review after a single restoration attempt', () => {
    const harness = makeHarness('win32');
    const window = harness.start();
    window.ready();
    const token = harness.answer();
    window.bounds.height -= 48;
    window.refuseBounds = true;
    const before = window.calls.filter(call => call[0] === 'setBounds').length;
    const result = harness.manager.showAnswer(token, { x: 0, y: 0 });
    assert.equal(result.success, false);
    assert.match(result.error, /could not cover the captured display/);
    assert.equal(window.calls.filter(call => call[0] === 'setBounds').length, before + 1);
    assert.equal(
        window.webContents.messages.some(message => message.payload.kind === 'answer'),
        false
    );
    assert.equal(window.isVisible(), false);
    assert.equal(window.isDestroyed(), true);
    assert.equal(harness.manager.isActive(), false);
    assert.equal(harness.mainWindow.isVisible(), true);
    assert.equal(harness.endings.length, 1);
    assert.match(harness.endings[0].reason, /could not cover the captured display/);
});

test('cached backend answer survives preload readiness and maps exactly once to local Retina DIP', () => {
    const harness = makeHarness();
    const window = harness.start();
    const token = harness.answer();
    assert.equal(harness.manager.showAnswer(token, { x: 0, y: 0 }).success, true);
    assert.equal(window.isVisible(), false);
    assert.equal(window.webContents.messages.length, 0);
    window.ready();
    assert.equal(window.isVisible(), true);
    const message = window.webContents.messages.at(-1);
    assert.equal(message.channel, 'review-overlay:update');
    assert.deepEqual(message.payload.answers, [{ label: 'B', box: { x: 432, y: 270, width: 28.8, height: 18 } }]);
    assert.deepEqual(message.payload.questionBox, { x: 144, y: 90, width: 1152, height: 720 });
    assert.equal(harness.mainWindow.isVisible(), false);
});

test('host can restore its activation policy both after overlay creation and before the loaded overlay becomes visible', () => {
    const harness = makeHarness();
    const window = harness.start();
    assert.deepEqual(harness.createdCallbacks, [window]);
    const token = harness.answer();
    harness.manager.showAnswer(token, { x: 0, y: 0 });
    assert.equal(window.isVisible(), false);
    window.ready();
    assert.deepEqual(harness.createdCallbacks, [window, window]);
    assert.equal(window.isVisible(), true);
});

test('new captures hide notices and main UI, invalidate old responses, and copy immutable token metadata', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    const oldToken = harness.answer();
    harness.manager.showAnswer(oldToken, { x: 0, y: 0 });
    harness.manager.status('Try capturing a complete question.');
    assert.equal(window.isVisible(), true);
    assert.equal(window.webContents.messages.at(-1).payload.kind, 'status');
    harness.mainWindow.showInactive();
    const token = harness.manager.prepareCapture();
    assert.notEqual(token.captureId, oldToken.captureId);
    assert.notEqual(token.requestId, oldToken.requestId);
    assert.equal(window.isVisible(), false);
    assert.equal(harness.mainWindow.isVisible(), false);
    assert.equal(window.webContents.messages.at(-1).payload.kind, 'clear');
    assert.equal(harness.manager.cacheAnswer(oldToken, makeAnswer(), harness.dimensions).success, false);
    assert.equal(harness.manager.showAnswer(oldToken, { x: 0, y: 0 }).success, false);
    token.display.bounds.x = 500;
    assert.equal(harness.manager.validateCapture(token, harness.dimensions).success, false);
});

test('cached answer must match the current display signature, token, image aspect, and validated answer format', () => {
    const harness = makeHarness();
    harness.start();
    const token = harness.manager.prepareCapture();
    assert.equal(harness.manager.cacheAnswer(token, makeAnswer(), { imageWidth: 1280, imageHeight: 800 }).success, true);
    assert.equal(harness.manager.cacheAnswer(token, makeAnswer(), { imageWidth: 1920, imageHeight: 1080 }).success, false);
    for (const dimensions of [
        { imageWidth: 0, imageHeight: 800 },
        { imageWidth: Infinity, imageHeight: 800 },
        { imageWidth: 1280.5, imageHeight: 800 },
    ]) {
        assert.equal(harness.manager.validateCapture(token, dimensions).success, false);
    }
    assert.equal(harness.manager.cacheAnswer(token, { ...makeAnswer(), confidence: 0.4 }, harness.dimensions).success, false);
    const forged = { ...token, display: { ...token.display, rotation: 90 } };
    assert.equal(harness.manager.validateCapture(forged, harness.dimensions).success, false);
    assert.equal(harness.manager.showAnswer({ ...token, requestId: 'other' }).success, false);
});

test('clear accepts only its own current request and prevents any later response from recreating rings', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    const stale = harness.answer();
    const current = harness.answer();
    harness.manager.showAnswer(current, { x: 0, y: 0 });
    assert.equal(harness.manager.clear(stale).success, false);
    assert.equal(window.isVisible(), true);
    assert.equal(harness.manager.clear(current).success, true);
    assert.equal(window.isVisible(), false);
    assert.equal(harness.manager.cacheAnswer(current, makeAnswer(), harness.dimensions).success, false);
    assert.equal(harness.manager.showAnswer(current, { x: 0, y: 0 }).success, false);
});

test('show/hide toggles cached circles while keeping the main application hidden', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    const token = harness.answer();
    harness.manager.showAnswer(token, { x: 0, y: 0 });
    assert.deepEqual(harness.manager.toggle(), { success: true, visible: false });
    assert.equal(window.isVisible(), false);
    assert.equal(harness.mainWindow.isVisible(), false);
    assert.deepEqual(harness.manager.toggle(), { success: true, visible: true });
    assert.equal(window.isVisible(), true);
    assert.equal(harness.mainWindow.isVisible(), false);
});

test('without an answer the visibility shortcut opens main controls and can return to a capture-first notice', () => {
    const harness = makeHarness('win32');
    const window = harness.start();
    window.ready();
    assert.deepEqual(harness.manager.toggle(), { success: true, visible: true });
    assert.equal(harness.mainWindow.isVisible(), true);
    assert.equal(window.isVisible(), false);
    assert.deepEqual(harness.manager.toggle(), { success: true, visible: false });
    assert.equal(harness.mainWindow.isVisible(), false);
    assert.equal(window.isVisible(), true);
    assert.match(window.webContents.messages.at(-1).payload.text, /Ctrl \+ Enter/);
    assert.equal(
        window.calls.some(call => call[0] === 'setHiddenInMissionControl'),
        false
    );
});

test('local tracking moves from the original normalized answer and preserves manual visibility across scrollback', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    const token = harness.answer();
    harness.manager.showAnswer(token, { x: 0, y: 0 });
    assert.equal(harness.manager.moveAnswer(token, { x: 10, y: -50 }).success, true);
    assert.deepEqual(window.webContents.messages.at(-1).payload.answers[0].box, { x: 446.4, y: 225, width: 28.8, height: 18 });
    assert.equal(harness.manager.moveAnswer(token, { x: 0, y: 0 }).success, true);
    assert.deepEqual(window.webContents.messages.at(-1).payload.answers[0].box, { x: 432, y: 270, width: 28.8, height: 18 });
    harness.manager.hideAnswer(token);
    assert.equal(window.isVisible(), false);
    assert.equal(harness.manager.moveAnswer(token, { x: 0, y: -10 }).visible, true);
    assert.equal(window.isVisible(), true);
    harness.manager.toggle();
    assert.equal(window.isVisible(), false);
    harness.manager.hideAnswer(token);
    assert.equal(harness.manager.moveAnswer(token, { x: 0, y: -20 }).visible, false);
    assert.equal(window.isVisible(), false);
    harness.manager.toggle();
    assert.equal(window.isVisible(), true);
});

test('tracking rejects invalid, clipped, or stale offsets but retains its snapshot for a safe scrollback', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    const token = harness.answer();
    harness.manager.showAnswer(token, { x: 0, y: 0 });
    for (const offset of [null, { x: NaN, y: 0 }, { x: 0, y: -101 }, { x: 1001, y: 0 }]) {
        assert.equal(harness.manager.moveAnswer(token, offset).success, false);
        assert.equal(window.isVisible(), false);
    }
    assert.equal(harness.manager.moveAnswer(token, { x: 0, y: 0 }).success, true);
    assert.equal(window.isVisible(), true);
    const current = harness.manager.prepareCapture();
    assert.equal(harness.manager.hideAnswer(token).success, false);
    assert.equal(harness.manager.moveAnswer(token, { x: 0, y: 0 }).success, false);
    assert.equal(harness.manager.validateCapture(current, harness.dimensions).success, true);
});

test('a fresh or reused backend answer cannot be drawn without a current verified location', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    const token = harness.answer();
    assert.equal(harness.manager.showAnswer(token).success, false);
    harness.manager.toggle();
    harness.manager.toggle();
    assert.equal(window.isVisible(), false);
    assert.equal(
        window.webContents.messages.some(message => message.payload.kind === 'answer'),
        false
    );
    assert.equal(harness.manager.showAnswer(token, { x: 0, y: 0 }).success, true);
    assert.equal(window.isVisible(), true);
    const current = harness.manager.prepareCapture();
    assert.equal(harness.manager.reuseAnswer(current, token, { x: 0, y: 0 }).success, true);
    assert.equal(harness.manager.showAnswer(current).success, false);
    assert.equal(window.isVisible(), false);
});

test('visibility toggles cannot resurrect stale rings while tracking is lost and a later match respects their preference', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    const token = harness.answer();
    harness.manager.showAnswer(token, { x: 0, y: 0 });
    harness.manager.hideAnswer(token);
    const messages = window.webContents.messages.length;
    assert.equal(harness.manager.toggle().visible, false);
    assert.equal(harness.manager.toggle().visible, false);
    assert.equal(window.isVisible(), false);
    assert.equal(harness.manager.showAnswer(token).success, false);
    assert.equal(
        window.webContents.messages.slice(messages).some(message => message.payload.kind === 'answer' || message.payload.kind === 'status'),
        false
    );
    assert.equal(harness.manager.moveAnswer(token, { x: 0, y: -20 }).visible, true);
    harness.manager.hideAnswer(token);
    harness.manager.toggle();
    assert.equal(harness.manager.moveAnswer(token, { x: 0, y: -10 }).visible, false);
    assert.equal(window.isVisible(), false);
    assert.equal(harness.manager.toggle().visible, true);
    assert.equal(window.isVisible(), true);
});

test('an invalid local move revokes the location so toggles cannot redraw its previous position', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    const token = harness.answer();
    harness.manager.showAnswer(token, { x: 0, y: 0 });
    assert.equal(harness.manager.moveAnswer(token, { x: 0, y: -101 }).success, false);
    harness.manager.toggle();
    harness.manager.toggle();
    assert.equal(window.isVisible(), false);
    assert.equal(harness.manager.showAnswer(token).success, false);
    assert.equal(harness.manager.moveAnswer(token, { x: 0, y: 0 }).success, true);
    assert.equal(window.isVisible(), true);
});

test('an initially offscreen answer becomes visible on a safe local match without another show call', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    const token = harness.answer();
    harness.manager.hideAnswer(token);
    assert.equal(window.isVisible(), false);
    assert.equal(harness.manager.moveAnswer(token, { x: 0, y: 0 }).visible, true);
    assert.equal(window.isVisible(), true);
});

test('show with an explicit offset shifts only the original backend answer, and toggling preserves that position', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    const token = harness.answer();
    assert.equal(harness.manager.showAnswer(token, { x: 10, y: -50 }).success, true);
    const expectedBox = { x: 446.4, y: 225, width: 28.8, height: 18 };
    assert.deepEqual(window.webContents.messages.at(-1).payload.answers[0].box, expectedBox);
    harness.manager.toggle();
    harness.manager.toggle();
    assert.deepEqual(window.webContents.messages.at(-1).payload.answers[0].box, expectedBox);
});

test('three saved backend answers survive clear/new captures and reuse rebases one without evicting another question', () => {
    const harness = makeHarness();
    harness.start();
    const tokens = [];
    for (const label of ['A', 'B', 'C', 'D']) {
        const token = harness.manager.prepareCapture();
        const answer = makeAnswer();
        answer.answers[0].label = label;
        assert.equal(harness.manager.cacheAnswer(token, answer, harness.dimensions).success, true);
        tokens.push(token);
        assert.equal(harness.manager.clear(token).success, true);
    }
    const current = harness.manager.prepareCapture();
    assert.equal(harness.manager.reuseAnswer(current, tokens[0], { x: 0, y: 0 }).success, false);
    const reused = harness.manager.reuseAnswer(current, tokens[1], { x: 10, y: -50 });
    assert.equal(reused.success, true);
    assert.equal(reused.reviewAnswer.answers[0].label, 'B');
    assert.deepEqual(reused.reviewAnswer.questionBox, [50, 110, 850, 910]);
    assert.deepEqual(reused.reviewAnswer.answers[0].box, [250, 310, 270, 330]);
    reused.reviewAnswer.answers[0].box[0] = -999;
    assert.equal(harness.manager.showAnswer(current, { x: 0, y: 0 }).success, true);
    const next = harness.manager.prepareCapture();
    assert.equal(harness.manager.reuseAnswer(next, tokens[2], { x: 0, y: 0 }).success, true);
    const another = harness.manager.prepareCapture();
    assert.equal(harness.manager.reuseAnswer(another, tokens[3], { x: 0, y: 0 }).success, true);
    harness.manager.end();
    harness.start();
    const fresh = harness.manager.prepareCapture();
    assert.equal(harness.manager.reuseAnswer(fresh, tokens[3], { x: 0, y: 0 }).success, false);
});

test('history reuse refuses forged display tokens and clipped offsets, leaving the current cached result untouched', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    const source = harness.answer();
    const current = harness.answer();
    harness.manager.showAnswer(current, { x: 0, y: 0 });
    const forged = { ...source, display: { ...source.display, scaleFactor: 1 } };
    assert.equal(harness.manager.reuseAnswer(current, forged, { x: 0, y: 0 }).success, false);
    assert.equal(harness.manager.reuseAnswer(current, source, { x: 0, y: -101 }).success, false);
    assert.equal(harness.manager.showAnswer(current, { x: 0, y: 0 }).success, true);
    assert.equal(window.isVisible(), true);
});

test('clearing an empty status preserves the current answer and user visibility preference', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    const token = harness.answer();
    harness.manager.showAnswer(token, { x: 0, y: 0 });
    assert.equal(harness.manager.status('').success, true);
    assert.equal(window.isVisible(), true);
    harness.manager.toggle();
    assert.equal(harness.manager.status('').success, true);
    assert.equal(harness.manager.moveAnswer(token, { x: 0, y: -20 }).visible, false);
    harness.manager.toggle();
    assert.equal(window.isVisible(), true);
});

test('a busy notice arriving after backend completion cannot delete the cached answer or reset manual visibility', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    const token = harness.answer();
    assert.equal(harness.manager.status('A screenshot is already being processed. Wait for the response.').success, true);
    assert.equal(window.webContents.messages.at(-1).payload.kind, 'status');
    assert.equal(harness.manager.status('').success, true);
    assert.equal(harness.manager.showAnswer(token, { x: 0, y: 0 }).success, true);
    harness.manager.toggle();
    assert.equal(window.isVisible(), false);
    assert.equal(harness.manager.status('Busy.').success, true);
    assert.equal(harness.manager.status('').success, true);
    assert.equal(harness.manager.moveAnswer(token, { x: 0, y: -20 }).visible, false);
    assert.equal(window.isVisible(), false);
    harness.manager.toggle();
    assert.equal(window.isVisible(), true);
});

test('ending review destroys overlay, restores main, removes listeners, and does not fire the unexpected-end callback', () => {
    const harness = makeHarness();
    const window = harness.start();
    assert.equal(harness.manager.begin().success, true);
    assert.equal(harness.screen.listenerCount('display-removed'), 1);
    assert.equal(harness.manager.end('Stopped by the learner.').success, true);
    assert.equal(harness.manager.isActive(), false);
    assert.equal(window.isDestroyed(), true);
    assert.equal(harness.mainWindow.isVisible(), true);
    assert.equal(harness.screen.listenerCount('display-removed'), 0);
    assert.equal(harness.screen.listenerCount('display-metrics-changed'), 0);
    assert.equal(harness.mainWindow.listenerCount('closed'), 0);
    assert.equal(harness.mainWindow.webContents.listenerCount('render-process-gone'), 0);
    assert.equal(window.webContents.listenerCount('did-finish-load'), 0);
    assert.equal(harness.endings.length, 0);
    assert.equal(harness.manager.begin().success, false);
    harness.start();
    assert.equal(harness.windows.length, 2);
    assert.equal(harness.screen.listenerCount('display-removed'), 1);
});

test('display removal, changed origin/scale/rotation, and silent display changes end review and report the reason', () => {
    for (const change of [
        harness => harness.screen.emit('display-removed', {}, harness.displays[1]),
        harness => {
            harness.displays[1].bounds.x -= 100;
            harness.screen.emit('display-metrics-changed', {}, harness.displays[1], ['bounds']);
        },
        harness => {
            harness.displays[1].scaleFactor = 1;
            harness.screen.emit('display-metrics-changed', {}, harness.displays[1], ['scaleFactor']);
        },
        harness => {
            harness.displays[1].rotation = 90;
            harness.screen.emit('display-metrics-changed', {}, harness.displays[1], ['rotation']);
        },
        harness => {
            const token = harness.answer();
            harness.displays[1].bounds.width = 1500;
            assert.equal(harness.manager.validateCapture(token, harness.dimensions).success, false);
        },
    ]) {
        const harness = makeHarness();
        const window = harness.start();
        change(harness);
        assert.equal(harness.manager.isActive(), false);
        assert.equal(window.isDestroyed(), true);
        assert.equal(harness.mainWindow.isVisible(), true);
        assert.equal(harness.endings.length, 1);
        assert.match(harness.endings[0].reason, /display/i);
    }
});

test('unrelated display or work-area-only events do not invalidate capture', () => {
    const harness = makeHarness();
    harness.start();
    const token = harness.answer();
    harness.screen.emit('display-removed', {}, harness.displays[0]);
    harness.screen.emit('display-metrics-changed', {}, harness.displays[0], ['bounds']);
    harness.screen.emit('display-metrics-changed', {}, harness.displays[1], ['workArea']);
    assert.equal(harness.manager.isActive(), true);
    assert.equal(harness.manager.validateCapture(token, harness.dimensions).success, true);
    assert.equal(harness.endings.length, 0);
});

test('main and overlay renderer lifecycle failures clean up listeners and cannot leave orphan windows', () => {
    for (const fail of [
        harness => harness.mainWindow.destroy(),
        harness => harness.mainWindow.webContents.emit('render-process-gone'),
        (_, window) => window.webContents.emit('render-process-gone'),
        (_, window) => window.webContents.emit('did-fail-load'),
        (_, window) => window.destroy(),
    ]) {
        const harness = makeHarness();
        const window = harness.start();
        fail(harness, window);
        assert.equal(harness.manager.isActive(), false);
        assert.equal(window.isDestroyed(), true);
        assert.equal(harness.screen.listenerCount('display-removed'), 0);
        assert.equal(harness.endings.length, 1);
    }
});

test('a late load rejection from a destroyed overlay cannot end a newly started session', async () => {
    const harness = makeHarness();
    const oldWindow = harness.start();
    harness.manager.end();
    const newWindow = harness.start();
    oldWindow.rejectLoad(new Error('old load cancelled'));
    await Promise.resolve();
    assert.equal(harness.manager.isActive(), true);
    assert.equal(newWindow.isDestroyed(), false);
    assert.equal(harness.endings.length, 0);
});

test('notice validation rejects oversized text and never renders an answer through a status payload', () => {
    const harness = makeHarness();
    const window = harness.start();
    window.ready();
    assert.equal(harness.manager.status({ answers: makeAnswer().answers }).success, false);
    assert.equal(harness.manager.status('A'.repeat(501)).success, false);
    assert.equal(harness.manager.status('Question unclear.\nCapture again.').success, true);
    assert.equal(window.webContents.messages.at(-1).payload.text, 'Question unclear. Capture again.');
    assert.equal(window.webContents.messages.at(-1).payload.kind, 'status');
});

test('isolated preload exposes only one receive-only fixed-channel subscription and cleans up its listener', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/review-overlay-preload.js'), 'utf8');
    const ipcRenderer = new EventEmitter();
    let exposedName;
    let exposed;
    vm.runInNewContext(source, {
        require(name) {
            assert.equal(name, 'electron');
            return {
                ipcRenderer,
                contextBridge: {
                    exposeInMainWorld: (name, api) => {
                        exposedName = name;
                        exposed = api;
                    },
                },
            };
        },
    });
    assert.equal(exposedName, 'reviewOverlay');
    assert.deepEqual(Object.keys(exposed), ['onUpdate']);
    const received = [];
    const unsubscribe = exposed.onUpdate(payload => received.push(payload));
    ipcRenderer.emit('other-channel', {}, { kind: 'answer' });
    ipcRenderer.emit('review-overlay:update', { sender: 'do not expose' }, { kind: 'clear' });
    assert.deepEqual(received, [{ kind: 'clear' }]);
    unsubscribe();
    assert.equal(ipcRenderer.listenerCount('review-overlay:update'), 0);
    assert.throws(() => exposed.onUpdate(null), /callback/);
});

test('overlay CSP blocks remote content and its renderer draws SVG circles without HTML or click handlers', () => {
    const html = fs.readFileSync(path.join(__dirname, '../src/review-overlay.html'), 'utf8');
    assert.match(html, /default-src 'none'/);
    assert.match(html, /script-src 'self'/);
    assert.match(html, /style-src 'self'/);
    assert.match(html, /connect-src 'none'/);
    assert.doesNotMatch(html, /unsafe-inline|(?:src|href)="https?:\/\//);
    const source = fs.readFileSync(path.join(__dirname, '../src/review-overlay.js'), 'utf8');
    assert.doesNotMatch(source, /innerHTML|\.click\(|onclick|ipcRenderer/);
    const annotations = {
        children: [],
        replaceChildren() {
            this.children = [];
        },
        append(value) {
            this.children.push(value);
        },
    };
    const notice = { hidden: true, textContent: '' };
    let update;
    const listeners = [];
    vm.runInNewContext(source, {
        document: {
            getElementById: id => (id === 'annotations' ? annotations : notice),
            createElementNS(namespace, tag) {
                assert.equal(namespace, 'http://www.w3.org/2000/svg');
                assert.equal(tag, 'ellipse');
                return {
                    attributes: {},
                    setAttribute(key, value) {
                        this.attributes[key] = value;
                    },
                };
            },
        },
        window: {
            reviewOverlay: {
                onUpdate: callback => {
                    update = callback;
                    return () => {};
                },
            },
            addEventListener: (...args) => listeners.push(args),
        },
    });
    update({ kind: 'answer', answers: [{ label: '<script>', box: { x: 432, y: 270, width: 28.8, height: 18 } }] });
    assert.equal(annotations.children.length, 1);
    assert.equal(annotations.children[0].attributes.cx, '446.4');
    assert.equal(annotations.children[0].attributes.cy, '279');
    assert.equal(notice.hidden, true);
    update({ kind: 'status', text: '<b>Capture again</b>' });
    assert.equal(annotations.children.length, 0);
    assert.equal(notice.textContent, '<b>Capture again</b>');
    assert.equal(notice.hidden, false);
    update({ kind: 'clear' });
    assert.equal(notice.hidden, true);
    assert.equal(listeners[0][0], 'unload');
});
