const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadHistory({ writeText = () => {}, deleteAllSessions = async () => ({ success: true }) } = {}) {
    let HistoryView;
    const renderingCalls = [];
    const context = {
        LitElement: class {},
        html: (strings, ...values) => ({ strings: [...strings], values }),
        css: () => '',
        unifiedPageStyles: '',
        renderResponseHtml: content => {
            renderingCalls.push(content);
            return '<p>safe rendered response</p>';
        },
        renderResponseClipboardHtml: () => '<p>safe clipboard response</p>',
        installResponseStyles() {},
        customElements: {
            define: (_name, ctor) => {
                HistoryView = ctor;
            },
        },
        window: {
            require: () => ({
                ipcRenderer: {
                    invoke: async (channel, payload) => {
                        assert.equal(channel, 'clipboard:write-response');
                        writeText(payload.text);
                        return { success: true };
                    },
                },
            }),
        },
        navigator: {},
        cheatingDaddy: { storage: { deleteAllSessions, getAllSessions: async () => [] } },
        setTimeout: callback => callback,
        clearTimeout() {},
    };
    const source = fs
        .readFileSync(path.resolve(__dirname, '../src/components/views/HistoryView.js'), 'utf8')
        .replace(/\r\n?/g, '\n')
        .replace(/^import .+;\n/gm, '')
        .replace('export class HistoryView', 'class HistoryView');
    vm.runInNewContext(source, context);
    const view = Object.assign(Object.create(HistoryView.prototype), {
        sessions: [{ sessionId: 'saved-session', createdAt: 123, modelInfo: null }],
        selectedSession: { sessionId: 'saved-session', createdAt: 123 },
        selectedSessionId: 'saved-session',
        searchQuery: '',
        activeTab: 'screen',
        _copyAttempt: 0,
        _copyKey: '',
        _copyState: '',
        _clearConfirmation: false,
        _clearing: false,
        _historyError: '',
        requestUpdate() {},
    });
    return { view, context, renderingCalls };
}

function templateText(template) {
    if (Array.isArray(template)) return template.map(templateText).join('');
    if (template?.strings) return template.strings.map((string, i) => string + templateText(template.values[i])).join('');
    return typeof template === 'string' || typeof template === 'number' ? String(template) : '';
}

test('Copy answer sends the exact saved Markdown and TeX with visible success state', async () => {
    const clipboard = [];
    const { view } = loadHistory({ writeText: text => clipboard.push(text) });
    const answer = String.raw`**Question 4: E** — \(\Theta(n^2)\)`;
    await view.copyResponse(answer, 'screen-0');
    assert.deepEqual(clipboard, [answer]);
    assert.equal(view._copyKey, 'screen-0');
    assert.equal(view._copyState, 'copied');
    assert.match(templateText(view._renderCopyButton(answer, 'screen-0')), /Copied/);
    assert.equal(view.sessions.length, 1);
});

test('copy failure is visible and does not change stored content', async () => {
    const { view } = loadHistory({
        writeText: () => {
            throw new Error('unavailable');
        },
    });
    await view.copyResponse('answer', 'screen-1');
    assert.equal(view._copyState, 'failed');
    assert.match(templateText(view._renderCopyButton('answer', 'screen-1')), /Copy failed/);
    assert.equal(view.sessions.length, 1);
});

test('clear history requires confirmation and prevents duplicate deletes while pending', async () => {
    let calls = 0;
    let resolve;
    const { view } = loadHistory({
        deleteAllSessions: () => {
            calls++;
            return new Promise(done => {
                resolve = done;
            });
        },
    });
    await view.clearHistory();
    assert.equal(calls, 0);
    view._clearConfirmation = true;
    const clearing = view.clearHistory();
    assert.equal(view._clearing, true);
    await view.clearHistory();
    assert.equal(calls, 1);
    resolve({ success: true });
    await clearing;
    assert.equal(view._clearing, false);
    assert.equal(view._clearConfirmation, false);
    assert.equal(view.sessions.length, 0);
    assert.equal(view.selectedSession, null);
    assert.equal(view.selectedSessionId, null);
});

test('failed deletion keeps existing session selection and shows retryable error', async () => {
    const { view } = loadHistory({ deleteAllSessions: async () => ({ success: false }) });
    view._clearConfirmation = true;
    await view.clearHistory();
    assert.equal(view.sessions.length, 1);
    assert.equal(view.selectedSessionId, 'saved-session');
    assert.equal(view._clearing, false);
    assert.match(view._historyError, /Could not clear history/);
});

test('model labels use recorded model details and never infer models for old sessions', () => {
    const { view } = loadHistory();
    const model = { provider: 'chatgpt', modelId: 'gpt-6-astra', displayName: 'GPT-6 Astra', reasoningMode: 'standard', reasoningEffort: 'low' };
    assert.equal(view._modelLabel(model), 'GPT-6 Astra · Fast');
    assert.equal(view._modelLabel({ ...model, reasoningMode: 'pro', reasoningEffort: 'high' }), 'GPT-6 Astra · Pro · High');
    assert.equal(view._sessionModelLabel({}), 'Model not recorded');
    assert.equal(view._sessionModelLabel({ modelsUsed: [model, model] }), 'GPT-6 Astra · Fast');
    view.sessions = [
        { sessionId: '1', createdAt: 123, modelInfo: model },
        { sessionId: '2', createdAt: 123 },
    ];
    view.searchQuery = 'astra';
    assert.equal(view.getFilteredSessions().length, 1);
});

test('old saved AI responses pass through the shared math renderer without a new model request', () => {
    const { view, renderingCalls } = loadHistory();
    const oldAnswer = String.raw`**d)** \(O(1)\)`;
    view.selectedSession.screenAnalysisHistory = [{ response: oldAnswer, timestamp: 123, model: 'gemini-2.5-flash' }];
    const rendered = templateText(view.renderTabContent());
    assert.deepEqual(renderingCalls, [oldAnswer]);
    assert.match(rendered, /safe rendered response/);
    assert.match(rendered, /gemini-2.5-flash/);
    assert.match(rendered, /Copy answer/);
    view.activeTab = 'conversation';
    view.selectedSession.conversationHistory = [{ transcription: '<user text>', ai_response: oldAnswer, timestamp: 123 }];
    view.renderTabContent();
    assert.deepEqual(renderingCalls, [oldAnswer, oldAnswer]);
});
