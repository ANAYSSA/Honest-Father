const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadView({ invoke = async () => ({}), updateConfig = async () => {} } = {}) {
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
        cheatingDaddy: { storage: { updateConfig } },
    });
    return Object.assign(Object.create(View.prototype), {
        _mode: 'byok',
        _normalResponseProvider: 'chatgpt',
        _geminiKey: '',
        _chatgptStatus: { connected: true, planEnabled: true, connecting: false },
        _chatgptModels: [{ id: 'gpt-6-sol', name: 'Account model', supportsPro: true }],
        _chatgptModel: 'gpt-6-sol',
        _chatgptReasoningMode: 'standard',
        _chatgptModelsGeneration: 0,
        _chatgptIpc: { invoke },
        _chatgptError: '',
        _storageLoaded: true,
        _chatgptPlanNoticeDismissed: true,
        downloadProgress: { active: false },
        requestUpdate() {},
        onStart() {},
        onStartReview() {},
    });
}

function textContent(template) {
    if (Array.isArray(template)) return template.map(textContent).join('');
    if (template && template.strings) return template.strings.map((string, i) => string + textContent(template.values[i])).join('');
    return typeof template === 'string' ? template : '';
}

test('ChatGPT normal start works without a Gemini API key, while Review retains its callback', () => {
    const view = loadView();
    const calls = [];
    view.onStart = () => calls.push('normal');
    view.onStartReview = () => calls.push('review');
    view._handleStart();
    view._handleStartReview();
    assert.deepEqual(calls, ['normal', 'review']);
    view._normalResponseProvider = 'gemini';
    view._handleStart();
    assert.deepEqual(calls, ['normal', 'review']);
    assert.equal(view._keyError, true);
});

test('ChatGPT requires plan scope and a catalog model before normal start, without blocking Review', () => {
    const view = loadView();
    view.onStart = () => assert.fail('Unavailable ChatGPT must not start');
    let reviewed = 0;
    view.onStartReview = () => reviewed++;
    view._chatgptStatus.planEnabled = false;
    view._handleStart();
    assert.match(view._chatgptError, /allow plan usage/);
    view._handleStartReview();
    view._chatgptStatus.planEnabled = true;
    view._chatgptModels = [];
    view._handleStart();
    assert.match(view._chatgptError, /Refresh models/);
    assert.equal(reviewed, 1);
});

test('ChatGPT sign-in coalesces clicks and reports cancellation without unhandled rejection', async () => {
    let finish;
    const calls = [];
    const view = loadView({
        invoke: channel => {
            calls.push(channel);
            return new Promise(resolve => {
                finish = resolve;
            });
        },
    });
    const first = view._signInChatGPT();
    await view._signInChatGPT();
    assert.deepEqual(calls, ['chatgpt-sign-in']);
    finish({ success: false, error: 'Sign-in cancelled.' });
    await first;
    assert.equal(view._chatgptBusy, false);
    assert.equal(view._chatgptError, 'Sign-in cancelled.');
});

test('in-flight model result cannot restore the previous account after sign-out', async () => {
    let finish;
    const view = loadView({
        invoke: () =>
            new Promise(resolve => {
                finish = resolve;
            }),
    });
    const pending = view._loadChatGPTModels();
    view._applyChatGPTStatus({ connected: false });
    finish({ success: true, models: [{ id: 'old-account-model', name: 'Old account model' }], selectedModel: 'old-account-model' });
    await pending;
    assert.equal(view._chatgptModels.length, 0);
    assert.equal(view._chatgptStatus.connected, false);
    assert.equal(view._chatgptModelsLoading, false);
});

test('model refresh coalesces requests and uses the actual service-selected model name', async () => {
    let finish;
    let requests = 0;
    const view = loadView({
        invoke: () => {
            requests++;
            return new Promise(resolve => {
                finish = resolve;
            });
        },
    });
    const first = view._loadChatGPTModels();
    const second = view._loadChatGPTModels();
    assert.equal(requests, 1);
    finish({ success: true, models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', supportsPro: false }], selectedModel: 'gpt-5.6-luna' });
    await Promise.all([first, second]);
    assert.equal(view._chatgptModel, 'gpt-5.6-luna');
    assert.equal(view._chatgptModelsLoading, false);
    const output = textContent(view._renderChatGPTAccount());
    assert.match(output, /GPT-5.6 Luna/);
    assert.doesNotMatch(output, /<option[^>]*>GPT-5\.6 Instant/);
});

test('switching from a Pro-capable model resets unsupported Pro before persisting the new model', async () => {
    const writes = [];
    const view = loadView({ updateConfig: async (key, value) => writes.push([key, value]) });
    view._chatgptReasoningMode = 'pro';
    view._chatgptModels.push({ id: 'other-model', name: 'Other', supportsPro: false });
    await view._saveChatGPTModel('other-model');
    assert.deepEqual(writes, [
        ['chatgptReasoningMode', 'standard'],
        ['chatgptModel', 'other-model'],
    ]);
    await view._saveChatGPTReasoningMode('pro');
    assert.equal(writes.length, 2);
    assert.equal(view._chatgptReasoningMode, 'standard');
});

test('provider persistence failure leaves previous provider selected and exposes retryable error', async () => {
    const view = loadView({
        updateConfig: async () => {
            throw new Error('disk failed');
        },
    });
    await view._saveNormalResponseProvider('gemini');
    assert.equal(view._normalResponseProvider, 'chatgpt');
    assert.equal(view._providerSaving, false);
    assert.match(view._chatgptError, /Could not save/);
});

test('first plan-enabled sign-in shows the notice once after dismissal', async () => {
    const writes = [];
    const view = loadView({ updateConfig: async (key, value) => writes.push([key, value]) });
    view._chatgptPlanNoticeDismissed = false;
    view._applyChatGPTStatus({ connected: true, planEnabled: true });
    assert.equal(view._showChatGPTPlanNotice, true);
    await view._dismissChatGPTPlanNotice();
    view._applyChatGPTStatus({ connected: true, planEnabled: true });
    assert.equal(view._showChatGPTPlanNotice, false);
    assert.deepEqual(writes, [['chatgptPlanNoticeDismissed', true]]);
});

test('Home has no Groq setup and keeps the normal provider choice before its unchanged start actions', () => {
    const view = loadView();
    const output = textContent(view._renderByokMode());
    assert.doesNotMatch(output, /Groq/);
    assert.match(output, /ChatGPT account/);
    assert.match(output, /Gemini API/);
    assert.ok(output.indexOf('AI for Start Session') < output.indexOf('Start Session</'));
    assert.match(output, /Start Test Review/);
    assert.match(output, /Test Review keeps its existing provider settings/);
});

test('ChatGPT voice transcription requires a Gemini key only after explicit opt-in', async () => {
    const writes = [];
    const view = loadView({ updateConfig: async (key, value) => writes.push([key, value]) });
    let started = 0;
    view.onStart = () => started++;
    view._handleStart();
    assert.equal(started, 1);
    await view._saveChatGPTUseTranscription(true);
    view._handleStart();
    assert.equal(started, 1);
    assert.match(view._chatgptError, /Gemini API key for voice/);
    view._geminiKey = 'fake-smoke-key';
    view._handleStart();
    assert.equal(started, 2);
    assert.deepEqual(writes, [['chatgptUseTranscription', true]]);
});
