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
        blindMode: false,
        answerTextOpacity: 100,
        answerFrameOpacity: 25,
        emphasizeAnswerLabels: true,
    });
    assert.equal(h.writes(), 0);
});

async function viewHarness({ preferences = {}, save } = {}) {
    let View;
    const events = [];
    const saved = { ...preferences };
    const calls = [];
    const template = (strings, ...values) => strings.reduce((result, part, index) => result + part + (values[index] ?? ''), '');
    const source = fs
        .readFileSync(path.join(__dirname, '../src/components/views/TestVisibilityView.js'), 'utf8')
        .replace(/^import[^\n]+\n/gm, '')
        .replace('export class TestVisibilityView', 'class TestVisibilityView');
    vm.runInNewContext(source, {
        LitElement: class {
            connectedCallback() {}
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
    return { view, events, calls, saved };
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
    assert.deepEqual({ ...h.events[1].detail }, { blindMode: true, answerTextOpacity: 0, answerFrameOpacity: 40, emphasizeAnswerLabels: true });
    assert.equal(h.events[1].bubbles, true);
    assert.equal(h.events[1].composed, true);
    assert.doesNotMatch(h.view.render(), /Screen ready · Practice session/);
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
