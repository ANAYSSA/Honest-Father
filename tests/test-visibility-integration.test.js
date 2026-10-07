const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const katex = require('katex');
const { normalizeTestVisibility } = require('../src/utils/testVisibility');

function loadComponent(file, name, additions = {}) {
    let Class;
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const ipc = {
        handlers: new Map(),
        calls: [],
        on(channel, handler) {
            this.handlers.set(channel, handler);
        },
        send(...args) {
            this.calls.push(args);
        },
        async invoke(...args) {
            this.calls.push(args);
        },
    };
    const calls = [];
    const api = { stopCapture: () => calls.push('stop-capture'), theme: { current: 'dark', get: () => ({ background: '#101010' }) } };
    const template = (strings, ...values) => ({ strings: Array.from(strings), values });
    const source = fs
        .readFileSync(path.join(__dirname, '../src/components/', file), 'utf8')
        .replace(/^import[^\n]+\n/gm, '')
        .replace(`export class ${name}`, `class ${name}`);
    vm.runInNewContext(source, {
        LitElement: class {
            updated() {}
            connectedCallback() {}
        },
        html: template,
        css: template,
        window: { require: module => (module === './utils/testVisibility' ? { normalizeTestVisibility } : { ipcRenderer: ipc }) },
        document: dom.window.document,
        DOMParser: dom.window.DOMParser,
        Node: dom.window.Node,
        customElements: {
            define: (_, value) => {
                Class = value;
            },
        },
        cheatingDaddy: api,
        console,
        ...additions,
    });
    const element = dom.window.document.createElement('div');
    const instance = Object.assign(Object.create(Class.prototype), {
        style: element.style,
        toggleAttribute: (...args) => element.toggleAttribute(...args),
        requestUpdate() {},
        currentView: 'assistant',
        sessionActive: true,
        testReview: false,
        visibilityPreferences: normalizeTestVisibility({ blindMode: true, answerTextOpacity: 0, answerFrameOpacity: 0 }),
        responses: ['Existing answer'],
        currentResponseIndex: 0,
        _stopTimer: () => calls.push('stop-timer'),
    });
    return { instance, element, ipc, calls, api, document: dom.window.document, dom };
}

test('recovery opens settings and returns to the same active session without restarting capture', () => {
    const h = loadComponent('app/CheatingDaddyApp.js', 'CheatingDaddyApp');
    const answer = h.instance.responses;
    h.instance.connectedCallback();
    h.ipc.handlers.get('open-test-visibility')();
    assert.equal(h.instance.currentView, 'test-visibility');
    assert.equal(h.instance.sessionActive, true);
    assert.equal(h.instance.responses, answer);
    h.instance.updated(new Set(['currentView']));
    assert.equal(h.element.hasAttribute('blind-mode'), false);
    assert.equal(h.element.hasAttribute('visibility-settings-open'), true);
    assert.notEqual(h.document.body.style.background, 'transparent', 'Recovery settings remain visible at zero answer opacity');
    h.instance.navigate('assistant');
    h.instance.updated(new Set(['currentView']));
    assert.equal(h.instance.responses, answer);
    assert.equal(h.instance.sessionActive, true);
    assert.equal(h.element.hasAttribute('blind-mode'), true);
    assert.equal(h.element.style.getPropertyValue('--answer-text-opacity'), '0');
    assert.equal(h.element.style.getPropertyValue('--answer-frame-opacity'), '0');
    assert.equal(h.document.body.style.background, 'transparent');
    assert.deepEqual(h.calls, [], 'Visibility navigation cannot close or restart capture');
});

test('End session works from recovery settings and does not invoke application quit', async () => {
    const h = loadComponent('app/CheatingDaddyApp.js', 'CheatingDaddyApp');
    h.instance.currentView = 'test-visibility';
    await h.instance.handleClose();
    assert.equal(h.instance.sessionActive, false);
    assert.equal(h.instance.currentView, 'main');
    assert.deepEqual(h.calls, ['stop-capture', 'stop-timer']);
    assert.deepEqual(h.ipc.calls, [['close-session']]);
});

test('Test Review ignores normal answer opacity and Blind mode and keeps its ordinary status bar', () => {
    const h = loadComponent('app/CheatingDaddyApp.js', 'CheatingDaddyApp');
    h.instance.testReview = true;
    h.instance.updated(new Set(['currentView']));
    assert.equal(h.element.hasAttribute('answer-visibility'), false);
    assert.equal(h.element.hasAttribute('blind-mode'), false);
    assert.equal(h.document.body.style.background, '');
    const template = h.instance.renderCurrentView();
    assert.deepEqual(template.values[0], normalizeTestVisibility());
    assert.equal(template.values[1], false);
    h.instance.getElapsedTime = () => '0:00';
    assert.match(h.instance.renderLiveBar().strings.join(''), /live-bar/);
    h.instance.testReview = false;
    assert.equal(h.instance.renderLiveBar(), '');
});

test('Assistant word wrapping keeps KaTeX and literal code intact while Blind mode clears the waiting message', () => {
    const h = loadComponent('views/AssistantView.js', 'AssistantView', { renderResponseHtml: value => value });
    const math = katex.renderToString('\\Theta(n^2)', { output: 'htmlAndMathml' });
    const container = h.document.createElement('div');
    container.innerHTML = h.instance.wrapWordsInSpans(`<p><strong>Question 7 · B</strong> ${math}</p><pre><code>\\Theta(n^2)</code></pre>`);
    assert.equal(container.querySelectorAll('.katex').length, 1);
    assert.equal(container.querySelectorAll('.katex [data-word]').length, 0, 'Word decorations cannot break typeset positions');
    assert.equal(container.querySelector('.katex').outerHTML, math);
    assert.equal(container.querySelector('code').innerHTML, '\\Theta(n^2)');
    assert.ok(container.querySelector('strong [data-word]'));
    assert.equal(container.querySelector('strong').textContent, 'Question 7 · B');
    h.instance.responses = [];
    h.instance.currentResponseIndex = -1;
    h.instance.selectedProfile = 'exam';
    assert.equal(h.instance.getCurrentResponse(), '');
    h.instance.visibilityPreferences = normalizeTestVisibility();
    assert.match(h.instance.getCurrentResponse(), /Listening to your Exam Assistant/);
});
