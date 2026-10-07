const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appearance = require('../src/utils/reviewAppearance');

test('saved marker appearance normalizes safe hex and numeric opacity without changing the original defaults', () => {
    assert.deepEqual(appearance.reviewAppearanceFromPreferences({}), { color: '#16a34a', opacity: 1 });
    assert.deepEqual(appearance.reviewAppearanceFromPreferences({ reviewMarkerColor: '#AABBCC', reviewMarkerOpacity: 0.1 }), {
        color: '#aabbcc',
        opacity: 0.1,
    });
    const result = appearance.normalizeReviewAppearance({ color: '#ff5500', opacity: 0.35, unexpected: 'ignored' });
    assert.deepEqual(result, { color: '#ff5500', opacity: 0.35 });
    result.color = '#000000';
    assert.equal(appearance.DEFAULT_REVIEW_APPEARANCE.color, '#16a34a');
});

test('invalid stored appearance cannot inject CSS or make markers invisible', () => {
    for (const color of [null, 5, '#fff', '#11223344', 'red', 'transparent', 'url(https://example.test)', '#123456;display:none']) {
        assert.equal(appearance.isReviewMarkerColor(color), false);
        assert.deepEqual(appearance.normalizeReviewAppearance({ color, opacity: 0.6 }), { color: '#16a34a', opacity: 0.6 });
    }
    for (const opacity of [null, true, '0.5', NaN, Infinity, -Infinity, -1, 0, 0.099, 1.001]) {
        assert.equal(appearance.isReviewMarkerOpacity(opacity), false);
        assert.deepEqual(appearance.normalizeReviewAppearance({ color: '#112233', opacity }), { color: '#112233', opacity: 1 });
    }
});

function preferenceStorage(savedPreferences = {}, { failWrites = false } = {}) {
    let bytes = JSON.stringify(savedPreferences);
    let writes = 0;
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/storage.js'), 'utf8'), {
        module,
        require(name) {
            if (name === 'fs') {
                return {
                    existsSync: () => true,
                    readFileSync(file) {
                        assert.equal(path.basename(file), 'preferences.json', 'Appearance preferences must not read credentials');
                        return bytes;
                    },
                    writeFileSync(file, value) {
                        assert.equal(path.basename(file), 'preferences.json');
                        if (failWrites) throw new Error('Disk write refused');
                        bytes = value;
                        writes++;
                    },
                };
            }
            if (name === 'path') return path;
            if (name === 'os') return { platform: () => 'darwin', homedir: () => '/mock-home' };
            if (name === './utils/reviewAppearance') return appearance;
            if (name === './utils/testVisibility') return require('../src/utils/testVisibility');
            throw new Error(`Unexpected storage dependency: ${name}`);
        },
        console: { warn() {}, error() {}, log() {} },
    });
    return { storage: module.exports, saved: () => JSON.parse(bytes), writes: () => writes };
}

test('real preference storage persists marker appearance across reloads and keeps unrelated settings', () => {
    const h = preferenceStorage({ selectedImageQuality: 'high', customPrompt: 'Saved instructions' });
    assert.equal(h.storage.getPreferences().reviewMarkerColor, '#16a34a');
    assert.equal(h.storage.getPreferences().reviewMarkerOpacity, 1);
    assert.equal(h.storage.updatePreference('reviewMarkerColor', '#AABBCC'), true);
    assert.equal(h.storage.updatePreference('reviewMarkerOpacity', 0.1), true);
    const reloaded = preferenceStorage(h.saved());
    assert.equal(reloaded.storage.getPreferences().reviewMarkerColor, '#aabbcc');
    assert.equal(reloaded.storage.getPreferences().reviewMarkerOpacity, 0.1);
    assert.equal(reloaded.storage.getPreferences().selectedImageQuality, 'high');
    assert.equal(reloaded.storage.getPreferences().customPrompt, 'Saved instructions');
    assert.equal(reloaded.storage.setPreferences({ reviewMarkerColor: '#FF5500', reviewMarkerOpacity: 0.65 }), true);
    assert.equal(reloaded.saved().reviewMarkerColor, '#ff5500');
    assert.equal(reloaded.saved().reviewMarkerOpacity, 0.65);
});

test('invalid marker preferences are rejected atomically before any persisted settings change', () => {
    const original = { reviewMarkerColor: '#112233', reviewMarkerOpacity: 0.4, selectedImageQuality: 'high' };
    const h = preferenceStorage(original);
    for (const color of [null, '#fff', 'transparent', '#11223344', 'url(example)', '#123456;opacity:0']) {
        assert.throws(() => h.storage.updatePreference('reviewMarkerColor', color), /valid marker color/);
        assert.throws(() => h.storage.setPreferences({ reviewMarkerColor: color, selectedImageQuality: 'low' }), /valid marker color/);
    }
    for (const opacity of [null, '0.5', NaN, Infinity, 0, 0.099, 1.001]) {
        assert.throws(() => h.storage.updatePreference('reviewMarkerOpacity', opacity), /10% and 100%/);
        assert.throws(() => h.storage.setPreferences({ reviewMarkerColor: '#ffffff', reviewMarkerOpacity: opacity }), /10% and 100%/);
    }
    assert.equal(h.writes(), 0);
    assert.deepEqual(h.saved(), original);
});

test('invalid legacy marker settings normalize on read and failed writes preserve saved preferences', () => {
    const h = preferenceStorage({ reviewMarkerColor: 'red', reviewMarkerOpacity: '0.5', selectedProfile: 'interview' });
    assert.equal(h.storage.getPreferences().reviewMarkerColor, '#16a34a');
    assert.equal(h.storage.getPreferences().reviewMarkerOpacity, 1);
    assert.equal(h.writes(), 0, 'Reading old data cannot overwrite user preferences');
    const failing = preferenceStorage({ reviewMarkerColor: '#112233', reviewMarkerOpacity: 0.7 }, { failWrites: true });
    assert.equal(failing.storage.setPreferences({ reviewMarkerColor: '#ffffff', reviewMarkerOpacity: 0.1 }), false);
    assert.deepEqual(failing.saved(), { reviewMarkerColor: '#112233', reviewMarkerOpacity: 0.7 });
});

function overlayRenderer() {
    const annotations = {
        children: [],
        clearCount: 0,
        replaceChildren() {
            this.clearCount++;
            this.children = [];
        },
        append(marker) {
            this.children.push(marker);
        },
    };
    const notice = { hidden: true, textContent: '' };
    let update;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/review-overlay.js'), 'utf8'), {
        document: {
            getElementById: id => (id === 'annotations' ? annotations : notice),
            createElementNS: () => ({
                attributes: {},
                setAttribute(key, value) {
                    this.attributes[key] = value;
                },
            }),
        },
        window: {
            reviewOverlay: { onUpdate: callback => ((update = callback), () => {}) },
            addEventListener() {},
        },
    });
    const show = () => update({ kind: 'answer', answers: [{ label: 'B', box: { x: 40, y: 60, width: 24, height: 16 } }] });
    return { annotations, notice, update: value => update(value), show };
}

test('live appearance changes preserve marker geometry and update existing SVG without clearing or recreating it', () => {
    const h = overlayRenderer();
    h.show();
    const marker = h.annotations.children[0];
    assert.deepEqual(marker.attributes, {
        cx: '52',
        cy: '68',
        rx: '17',
        ry: '13',
        class: 'answer-ring',
        stroke: '#16a34a',
        fill: '#22c55e',
        'fill-opacity': '0.16',
        opacity: '1',
    });
    const before = h.annotations.clearCount;
    h.update({ kind: 'appearance', appearance: { color: '#AABBCC', opacity: 0.35 } });
    assert.equal(h.annotations.clearCount, before);
    assert.equal(h.annotations.children[0], marker);
    assert.equal(marker.attributes.stroke, '#aabbcc');
    assert.equal(marker.attributes.fill, '#aabbcc');
    assert.equal(marker.attributes.opacity, '0.35');
    assert.equal(marker.attributes.cx, '52');
    assert.equal(marker.attributes.cy, '68');
    h.show();
    assert.equal(h.annotations.children[0].attributes.stroke, '#aabbcc');
    assert.equal(h.annotations.children[0].attributes.opacity, '0.35');
});

test('appearance changes neither resurrect cleared marks nor remove or restyle a status notice', () => {
    const h = overlayRenderer();
    h.show();
    h.update({ kind: 'status', text: 'Capture a complete question.' });
    h.update({ kind: 'appearance', appearance: { color: '#ffffff', opacity: 0.1 } });
    assert.equal(h.annotations.children.length, 0);
    assert.equal(h.notice.hidden, false);
    assert.equal(h.notice.textContent, 'Capture a complete question.');
    h.update({ kind: 'clear' });
    h.update({ kind: 'appearance', appearance: { color: '#ff0000', opacity: 0.5 } });
    assert.equal(h.annotations.children.length, 0);
    assert.equal(h.notice.hidden, true);
});

test('malformed appearance falls back to default SVG attributes and CSS does not override validated presentation attributes', () => {
    const h = overlayRenderer();
    h.update({
        kind: 'answer',
        appearance: { color: 'url(https://example.test)', opacity: 0 },
        answers: [{ box: { x: 1, y: 2, width: 3, height: 4 } }],
    });
    assert.equal(h.annotations.children[0].attributes.stroke, '#16a34a');
    assert.equal(h.annotations.children[0].attributes.fill, '#22c55e');
    assert.equal(h.annotations.children[0].attributes.opacity, '1');
    const css = fs.readFileSync(path.join(__dirname, '../src/review-overlay.css'), 'utf8');
    const ringRule = /\.answer-ring\s*\{([^}]+)\}/.exec(css)[1];
    assert.doesNotMatch(ringRule, /(?:^|[;\s])(?:stroke|fill|opacity)\s*:/);
    assert.match(ringRule, /stroke-width: 3px/);
});

test('receive-only sandbox bridge drops untrusted appearance fields and normalizes the same safe range', () => {
    let bridge;
    let listener;
    let removed = false;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/review-overlay-preload.js'), 'utf8'), {
        require: () => ({
            contextBridge: { exposeInMainWorld: (name, value) => ((bridge = value), assert.equal(name, 'reviewOverlay')) },
            ipcRenderer: {
                on: (channel, callback) => ((listener = callback), assert.equal(channel, 'review-overlay:update')),
                removeListener: (channel, callback) => {
                    assert.equal(channel, 'review-overlay:update');
                    assert.equal(callback, listener);
                    removed = true;
                },
            },
        }),
    });
    assert.deepEqual(Object.keys(bridge), ['onUpdate']);
    const received = [];
    const unsubscribe = bridge.onUpdate(value => received.push(value));
    listener({}, { kind: 'appearance', appearance: { color: '#FF00AA', opacity: 0.1, css: 'malicious' } });
    listener({}, { kind: 'appearance', appearance: { color: '#fff', opacity: Infinity } });
    assert.deepEqual(JSON.parse(JSON.stringify(received)), [
        { kind: 'appearance', appearance: { color: '#ff00aa', opacity: 0.1 } },
        { kind: 'appearance', appearance: { color: '#16a34a', opacity: 1 } },
    ]);
    unsubscribe();
    assert.equal(removed, true);
});

async function customizeView(preferences = {}, failure = null) {
    let View;
    const saved = { ...preferences };
    const calls = [];
    const events = [];
    const source = fs
        .readFileSync(path.join(__dirname, '../src/components/views/CustomizeView.js'), 'utf8')
        .replace(/^import[^\n]+\n/gm, '')
        .replace('export class CustomizeView', 'class CustomizeView');
    vm.runInNewContext(source, {
        LitElement: class {
            requestUpdate() {}
            dispatchEvent(event) {
                events.push(event);
            }
        },
        CustomEvent: class {
            constructor(type, options) {
                this.type = type;
                Object.assign(this, options);
            }
        },
        unifiedPageStyles: '',
        css: () => '',
        html: (strings, ...values) => ({ strings: Array.from(strings), values }),
        customElements: { define: (_, constructor) => (View = constructor) },
        navigator: { platform: 'MacIntel' },
        document: { documentElement: { style: { setProperty() {} } } },
        window: {
            require(name) {
                if (name === './utils/reviewAppearance') return appearance;
                if (name === './utils/testVisibility') return require('../src/utils/testVisibility');
                if (name === './utils/keybinds') return { getDefaultKeybinds: () => ({ toggleReviewMarks: 'Cmd+Shift+\\' }) };
                if (name === 'electron') return { ipcRenderer: { invoke: async () => ({ success: false }) } };
                throw new Error(`Unexpected module: ${name}`);
            },
        },
        cheatingDaddy: {
            isMacOS: true,
            storage: {
                getPreferences: async () => ({ ...saved }),
                getKeybinds: async () => null,
                updatePreference: async (key, value) => {
                    calls.push({ key, value });
                    if (failure) return { success: false, error: failure };
                    saved[key] = value;
                    return { success: true };
                },
            },
            theme: { get: () => ({ background: '#111111' }), getAll: () => [], applyBackgrounds() {}, save: async () => {} },
        },
        console: { ...console, error() {} },
    });
    const view = new View();
    await new Promise(resolve => setImmediate(resolve));
    return { view, calls, saved, events, reload: () => customizeView(saved) };
}

test('Customize loads persisted marker appearance and saves changes that survive another view instance', async () => {
    const h = await customizeView({ reviewMarkerColor: '#AABBCC', reviewMarkerOpacity: 0.45 });
    assert.equal(h.view.reviewMarkerColor, '#aabbcc');
    assert.equal(h.view.reviewMarkerOpacity, 0.45);
    assert.equal(await h.view.handleReviewMarkerColorChange({ target: { value: '#FF00AA' } }), true);
    assert.equal(await h.view.handleReviewMarkerOpacityChange({ target: { value: '0.25' } }), true);
    assert.deepEqual(h.calls, [
        { key: 'reviewMarkerColor', value: '#ff00aa' },
        { key: 'reviewMarkerOpacity', value: 0.25 },
    ]);
    const reloaded = await h.reload();
    assert.equal(reloaded.view.reviewMarkerColor, '#ff00aa');
    assert.equal(reloaded.view.reviewMarkerOpacity, 0.25);
    const rendered = h.view.renderAppearanceSection();
    assert.match(rendered.strings.join(''), /Review Marker Color/);
    assert.match(rendered.strings.join(''), /Review Marker Opacity/);
    assert.equal(rendered.values.includes(appearance.MIN_REVIEW_MARKER_OPACITY), true);
});

test('Customize refuses invalid inputs and reports persistence failure without claiming the selection was saved', async () => {
    const h = await customizeView();
    assert.equal(await h.view.handleReviewMarkerColorChange({ target: { value: 'url(bad)' } }), false);
    assert.equal(await h.view.handleReviewMarkerOpacityChange({ target: { value: '0.5bad' } }), false);
    assert.equal(await h.view.handleReviewMarkerOpacityChange({ target: { value: '0' } }), false);
    assert.equal(h.calls.length, 0);
    const failed = await customizeView({}, 'Disk is full.');
    assert.equal(await failed.view.handleReviewMarkerColorChange({ target: { value: '#112233' } }), false);
    assert.equal(failed.view.reviewMarkerColor, '#16a34a');
    assert.match(failed.view.reviewAppearanceError, /Disk is full/);
});

test('Restore all settings resets marker appearance and distinguishes window and Review marker shortcuts', async () => {
    const h = await customizeView({
        reviewMarkerColor: '#ffffff',
        reviewMarkerOpacity: 0.1,
        blindMode: true,
        answerTextOpacity: 0,
        answerFrameOpacity: 0,
        emphasizeAnswerLabels: false,
    });
    h.view.resetKeybinds = async () => true;
    await h.view.restoreAllSettings();
    assert.equal(h.saved.reviewMarkerColor, '#16a34a');
    assert.equal(h.saved.reviewMarkerOpacity, 1);
    assert.equal(h.view.reviewMarkerColor, '#16a34a');
    assert.equal(h.view.reviewMarkerOpacity, 1);
    assert.equal(h.saved.blindMode, false);
    assert.equal(h.saved.answerTextOpacity, 100);
    assert.equal(h.saved.answerFrameOpacity, 100);
    assert.equal(h.saved.emphasizeAnswerLabels, true);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].type, 'test-visibility-changed');
    assert.deepEqual({ ...h.events[0].detail }, { blindMode: false, answerTextOpacity: 100, answerFrameOpacity: 100, emphasizeAnswerLabels: true });
    assert.equal(h.events[0].bubbles, true);
    assert.equal(h.events[0].composed, true);
    const actions = h.view.getKeybindActions();
    assert.equal(actions.find(action => action.key === 'toggleVisibility').name, 'Toggle App Window');
    assert.equal(actions.find(action => action.key === 'toggleReviewMarks').name, 'Toggle Review Marks');
});

test('failed Restore all settings cannot announce visibility defaults that were not saved', async () => {
    const h = await customizeView({ blindMode: true, answerTextOpacity: 0 }, 'Disk is full.');
    h.view.resetKeybinds = async () => assert.fail('Failed preference writes must stop before shortcut changes');
    await h.view.restoreAllSettings();
    assert.equal(h.saved.blindMode, true);
    assert.equal(h.saved.answerTextOpacity, 0);
    assert.equal(h.events.length, 0);
    assert.equal(h.view.clearStatusType, 'error');
    assert.match(h.view.clearStatusMessage, /Disk is full/);
});
