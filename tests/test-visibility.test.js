const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const visibility = require('../src/utils/testVisibility');

test('answer opacity accepts both endpoints independently and normalizes only invalid saved fields', () => {
    assert.deepEqual(visibility.normalizeTestVisibility(), visibility.DEFAULT_TEST_VISIBILITY);
    assert.deepEqual(
        visibility.normalizeTestVisibility({ blindMode: true, answerTextOpacity: 0, answerFrameOpacity: 100, emphasizeAnswerLabels: false }),
        {
            ...visibility.DEFAULT_TEST_VISIBILITY,
            blindMode: true,
            answerTextOpacity: 0,
            answerFrameOpacity: 100,
            emphasizeAnswerLabels: false,
        }
    );
    for (const value of [NaN, Infinity, -Infinity, -1, 101, null, '0', '', false, '0;display:none']) {
        assert.equal(visibility.isOpacityPercent(value), false);
        assert.equal(visibility.normalizeTestVisibility({ answerTextOpacity: value }).answerTextOpacity, 100);
        assert.throws(() => visibility.validateTestVisibilityUpdate({ answerFrameOpacity: value }), /0% and 100%/);
    }
    for (const value of [0, 0.5, 30, 100]) {
        assert.equal(visibility.isOpacityPercent(value), true);
        visibility.validateTestVisibilityUpdate({ answerTextOpacity: value });
    }
    for (const value of [null, 'false', 0, 1]) {
        assert.throws(() => visibility.validateTestVisibilityUpdate({ blindMode: value }), /enabled or disabled/);
        assert.throws(() => visibility.validateTestVisibilityUpdate({ emphasizeAnswerLabels: value }), /enabled or disabled/);
    }
    for (const input of [null, [], 'bad']) assert.throws(() => visibility.validateTestVisibilityUpdate(input), /must be an object/);
});

function storageHarness(preferences) {
    let saved = JSON.stringify(preferences);
    let writes = 0;
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/storage.js'), 'utf8'), {
        module,
        console,
        require(name) {
            if (name === 'fs')
                return {
                    existsSync: () => true,
                    readFileSync(file) {
                        assert.equal(path.basename(file), 'preferences.json');
                        return saved;
                    },
                    writeFileSync(file, content) {
                        assert.equal(path.basename(file), 'preferences.json');
                        saved = content;
                        writes++;
                    },
                };
            if (name === 'path') return path;
            if (name === 'os') return { platform: () => 'darwin', homedir: () => '/isolated-test' };
            if (name === './utils/testVisibility') return visibility;
            if (name === './utils/reviewAppearance') return require('../src/utils/reviewAppearance');
            throw new Error(`Unexpected storage dependency: ${name}`);
        },
    });
    return { storage: module.exports, saved: () => JSON.parse(saved), writes: () => writes };
}

test('visibility storage preserves zero across reloads, keeps existing settings and rejects malformed batches atomically', () => {
    const h = storageHarness({ customPrompt: 'Keep me', reviewMarkerOpacity: 0.5 });
    assert.equal(h.storage.getPreferences().answerTextOpacity, 100);
    assert.equal(h.storage.setPreferences({ blindMode: true, answerTextOpacity: 0, answerFrameOpacity: 0, emphasizeAnswerLabels: false }), true);
    const reloaded = storageHarness(h.saved());
    assert.deepEqual(visibility.normalizeTestVisibility(reloaded.storage.getPreferences()), {
        ...visibility.DEFAULT_TEST_VISIBILITY,
        blindMode: true,
        answerTextOpacity: 0,
        answerFrameOpacity: 0,
        emphasizeAnswerLabels: false,
    });
    assert.equal(reloaded.storage.getPreferences().customPrompt, 'Keep me');
    assert.equal(reloaded.storage.getPreferences().reviewMarkerOpacity, 0.5);
    const before = reloaded.saved();
    assert.throws(() => reloaded.storage.setPreferences({ answerTextOpacity: 101, customPrompt: 'Lost' }), /0% and 100%/);
    assert.deepEqual(reloaded.saved(), before);
    assert.equal(reloaded.writes(), 0);
});

test('legacy malformed visibility values normalize in memory without writing user data', () => {
    const h = storageHarness({ blindMode: 'yes', answerTextOpacity: '0', answerFrameOpacity: 25, emphasizeAnswerLabels: 0 });
    assert.deepEqual(visibility.normalizeTestVisibility(h.storage.getPreferences()), {
        ...visibility.DEFAULT_TEST_VISIBILITY,
        blindMode: false,
        answerTextOpacity: 100,
        answerFrameOpacity: 25,
        emphasizeAnswerLabels: true,
    });
    assert.equal(h.writes(), 0);
});

async function viewHarness({ preferences = {}, save, displays } = {}) {
    let View;
    const events = [];
    const saved = { ...preferences };
    const calls = [];
    const ipcListeners = new Map();
    const template = (strings, ...values) => strings.reduce((result, part, index) => result + part + (values[index] ?? ''), '');
    const source = fs
        .readFileSync(path.join(__dirname, '../src/components/views/TestVisibilityView.js'), 'utf8')
        .replace(/^import[^\n]+\n/gm, '')
        .replace('export class TestVisibilityView', 'class TestVisibilityView');
    vm.runInNewContext(source, {
        LitElement: class {
            connectedCallback() {}
            disconnectedCallback() {}
            dispatchEvent(event) {
                events.push(event);
            }
        },
        unifiedPageStyles: '',
        css: template,
        html: template,
        CustomEvent: class {
            constructor(type, options) {
                this.type = type;
                Object.assign(this, options);
            }
        },
        navigator: { platform: 'MacIntel' },
        window: {
            require(name) {
                if (name === 'electron')
                    return {
                        ipcRenderer: {
                            on: (channel, listener) => ipcListeners.set(channel, listener),
                            removeListener: (channel, listener) => {
                                if (ipcListeners.get(channel) === listener) ipcListeners.delete(channel);
                            },
                            invoke: async channel => {
                                assert.equal(channel, 'get-answer-displays');
                                return (
                                    displays || {
                                        success: true,
                                        displays: [{ id: '1', label: 'Main display', workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
                                        primaryDisplayId: '1',
                                        placement: { displayId: '1', x: 50, y: 50, width: 700, height: 320 },
                                    }
                                );
                            },
                        },
                    };
                assert.equal(name, './utils/testVisibility');
                return visibility;
            },
        },
        cheatingDaddy: {
            isMacOS: true,
            storage: {
                getPreferences: async () => ({ ...saved }),
                setPreferences: async update => {
                    calls.push({ ...update });
                    const result = save ? await save(update) : { success: true };
                    if (result.success) Object.assign(saved, update);
                    return result;
                },
            },
        },
        customElements: {
            define(name, Class) {
                assert.equal(name, 'test-visibility-view');
                View = Class;
            },
        },
    });
    const view = new View();
    await view._loadPreferences();
    await view._loadDisplays();
    return { view, events, calls, saved, ipcListeners };
}

test('visibility settings preview performs no writes and saved zero emits the actual normalized preferences', async () => {
    const h = await viewHarness({ preferences: { answerFrameOpacity: 40 } });
    h.view.previewOpacity('answerTextOpacity', 0);
    assert.equal(h.view.preferences.answerTextOpacity, 0);
    assert.equal(h.calls.length, 0);
    assert.match(h.view.render(), /--preview-text-opacity: 0;/);
    assert.match(h.view.render(), /min="0"\s+max="100"/);
    assert.match(h.view.render(), /⌘ \+ Shift \+ ,/);
    await h.view.savePreference('answerTextOpacity', 0);
    await h.view.savePreference('blindMode', true);
    assert.equal(h.saved.answerTextOpacity, 0);
    assert.equal(h.events.length, 2);
    assert.equal(h.events[1].type, 'test-visibility-changed');
    assert.deepEqual(
        { ...h.events[1].detail },
        { ...visibility.DEFAULT_TEST_VISIBILITY, blindMode: true, answerTextOpacity: 0, answerFrameOpacity: 40, emphasizeAnswerLabels: true }
    );
    assert.equal(h.events[1].bubbles, true);
    assert.equal(h.events[1].composed, true);
    assert.doesNotMatch(h.view.render(), /Screen ready · Practice session/);
});

test('answer colors and placement validate exact safe values and preserve zero position', () => {
    const placement = { displayId: '-42', x: 0, y: 100, width: 320, height: 120 };
    assert.equal(visibility.isAnswerPlacement(null), true);
    assert.equal(visibility.isAnswerPlacement(placement), true);
    visibility.validateTestVisibilityUpdate({ answerTextColor: '#AABBCC', answerPlacement: placement });
    const prefs = visibility.normalizeTestVisibility({ answerTextColor: '#AABBCC', answerPlacement: placement });
    assert.equal(prefs.answerTextColor, '#aabbcc');
    assert.deepEqual(prefs.answerPlacement, placement);
    assert.notEqual(prefs.answerPlacement, placement);
    for (const color of ['white', '#fff', '#123456;display:none', null, 123]) {
        assert.equal(visibility.isAnswerTextColor(color), false);
        assert.throws(() => visibility.validateTestVisibilityUpdate({ answerTextColor: color }), /valid answer text color/);
        assert.equal(visibility.normalizeTestVisibility({ answerTextColor: color }).answerTextColor, '');
    }
    for (const invalid of [
        [],
        {},
        { ...placement, x: -1 },
        { ...placement, y: 101 },
        { ...placement, y: NaN },
        { ...placement, width: 319 },
        { ...placement, width: 7681 },
        { ...placement, height: 119 },
        { ...placement, height: 4321 },
        { ...placement, width: 800.5 },
        { ...placement, displayId: '' },
        { ...placement, displayId: 42 },
        { ...placement, displayId: '<img>' },
        { ...placement, unsupported: true },
    ]) {
        assert.equal(visibility.isAnswerPlacement(invalid), false);
        assert.throws(() => visibility.validateTestVisibilityUpdate({ answerPlacement: invalid }), /valid answer position/);
        assert.equal(visibility.normalizeTestVisibility({ answerPlacement: invalid }).answerPlacement, null);
    }
});

test('color and placement persist together, normalize casing and reject invalid batches without changing data', () => {
    const h = storageHarness({ customPrompt: 'Keep' });
    const placement = { displayId: '1', x: 0, y: 0, width: 700, height: 320 };
    assert.equal(h.storage.setPreferences({ answerPlacement: placement, answerTextColor: '#FFAABB' }), true);
    const reloaded = storageHarness(h.saved());
    assert.equal(reloaded.storage.getPreferences().answerTextColor, '#ffaabb');
    assert.deepEqual({ ...reloaded.storage.getPreferences().answerPlacement }, placement);
    const before = reloaded.saved();
    assert.throws(() => reloaded.storage.setPreferences({ answerPlacement: { ...placement, x: 200 }, answerTextColor: '#000000' }));
    assert.deepEqual(reloaded.saved(), before);
    assert.equal(reloaded.writes(), 0);
});

test('display preview saves configured positions without moving a native window or contacting AI', async () => {
    const h = await viewHarness();
    assert.deepEqual({ ...h.view.getPlacement() }, { displayId: '1', x: 50, y: 50, width: 700, height: 320 });
    assert.equal(h.calls.length, 0);
    await h.view.savePlacement({ x: 0, y: 100 });
    assert.deepEqual({ ...h.saved.answerPlacement }, { displayId: '1', x: 0, y: 100, width: 700, height: 320 });
    let prevented = false;
    await h.view.movePreview({
        key: 'ArrowRight',
        preventDefault() {
            prevented = true;
        },
    });
    assert.equal(prevented, true);
    assert.equal(h.saved.answerPlacement.x, 5);
    await h.view.selectPosition({
        currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 144, height: 90 }) },
        clientX: 72,
        clientY: 45,
    });
    assert.equal(h.saved.answerPlacement.x, 50);
    assert.equal(h.saved.answerPlacement.y, 50);
    await h.view.savePreference('answerTextColor', '#12aabb');
    assert.match(h.view.render(), /--preview-answer-color: #12aabb/);
    await h.view.savePreference('answerTextColor', '');
    assert.match(h.view.render(), /Theme default/);
});

test('preview falls back when a saved monitor is disconnected and reports inventory failure honestly', async () => {
    const h = await viewHarness({ preferences: { answerPlacement: { displayId: 'gone', x: 0, y: 100, width: 700, height: 320 } } });
    assert.equal(h.view.getPlacement().displayId, '1');
    assert.equal(h.view.getPlacement().x, 0);
    assert.equal(h.calls.length, 0);
    const unavailable = await viewHarness({ displays: { success: false } });
    assert.match(unavailable.view.render(), /Display preview is unavailable/);
    assert.equal(unavailable.calls.length, 0);
});

test('disconnected monitor preview uses the native resolved display even when it is not primary', async () => {
    const h = await viewHarness({
        preferences: { answerPlacement: { displayId: 'gone', x: 0, y: 100, width: 700, height: 320 } },
        displays: {
            success: true,
            displays: [
                { id: '1', label: 'Primary', workArea: { x: 0, y: 0, width: 1440, height: 900 } },
                { id: '2', label: 'External', workArea: { x: 1440, y: 0, width: 1920, height: 1080 } },
            ],
            primaryDisplayId: '1',
            placement: { displayId: '2', x: 0, y: 100, width: 700, height: 320 },
        },
    });
    assert.equal(h.view.getPlacement().displayId, '2');
    assert.equal(h.view.getPlacement().x, 0);
    assert.equal(h.view.getPlacement().y, 100);
    assert.equal(h.calls.length, 0);
    await h.view.savePlacement({ x: 100 });
    assert.equal(h.saved.answerPlacement.displayId, '2');
});

test('open placement settings refresh after monitor changes and remove the listener on exit', async () => {
    const displays = {
        success: true,
        displays: [
            { id: '1', label: 'Primary', workArea: { x: 0, y: 0, width: 1440, height: 900 } },
            { id: '2', label: 'External', workArea: { x: 1440, y: 0, width: 1920, height: 1080 } },
        ],
        primaryDisplayId: '1',
        placement: { displayId: '2', x: 0, y: 100, width: 700, height: 320 },
    };
    const h = await viewHarness({ preferences: { answerPlacement: displays.placement }, displays });
    h.view.connectedCallback();
    await Promise.resolve();
    assert.equal(h.view.getPlacement().displayId, '2');
    displays.displays = [displays.displays[0]];
    displays.placement = { ...displays.placement, displayId: '1' };
    await h.ipcListeners.get('answer-displays-changed')();
    assert.equal(h.view._displays.length, 1);
    assert.equal(h.view.getPlacement().displayId, '1');
    assert.equal(h.calls.length, 0);
    h.view.disconnectedCallback();
    assert.equal(h.ipcListeners.size, 0);
});

test('visibility settings serialize writes and avoid announcing or retaining a failed update', async () => {
    let release;
    let count = 0;
    const h = await viewHarness({
        save: async () => {
            count++;
            if (count === 1)
                await new Promise(resolve => {
                    release = resolve;
                });
            return { success: count !== 3, error: 'Disk full' };
        },
    });
    const first = h.view.savePreference('answerTextOpacity', 30);
    const second = h.view.savePreference('answerTextOpacity', 0);
    await Promise.resolve();
    assert.equal(h.calls.length, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(h.saved.answerTextOpacity, 0);
    assert.deepEqual(h.calls, [{ answerTextOpacity: 30 }, { answerTextOpacity: 0 }]);
    assert.equal(await h.view.savePreference('answerFrameOpacity', 0), false);
    assert.equal(h.view.preferences.answerFrameOpacity, 100);
    assert.equal(h.events.length, 2);
    assert.match(h.view.render(), /Disk full/);
    assert.equal(h.view._saving, 0);
    assert.equal(await h.view.savePreference('answerTextOpacity', NaN), false);
    assert.equal(h.calls.length, 3);
});
