const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeModelInfo, mergeModelsUsed, chatGPTModelInfo } = require('../src/utils/historyModels');
const { clearSavedHistory, copyHistoryResponse } = require('../src/utils/historyActions');

function storageHarness(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-history-test-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/storage.js'), 'utf8'), {
        module,
        console,
        require(name) {
            if (name === 'fs') return fs;
            if (name === 'path') return path;
            if (name === 'os') return { platform: () => 'darwin', homedir: () => home };
            if (name.startsWith('./utils/')) return require(path.join(__dirname, '../src', name));
            throw new Error(`Unexpected storage dependency: ${name}`);
        },
    });
    return { storage: module.exports, configDir: path.join(home, 'Library', 'Application Support', 'honest-father-config') };
}

test('model records retain exact IDs and only actual reasoning configuration, never credentials or auto', () => {
    const model = chatGPTModelInfo({ id: 'gpt-6-astra', name: 'GPT 6 Astra', fastReasoningEffort: 'low' });
    assert.deepEqual(model, {
        provider: 'chatgpt',
        modelId: 'gpt-6-astra',
        displayName: 'GPT 6 Astra',
        reasoningMode: 'standard',
        reasoningEffort: 'low',
    });
    const pro = chatGPTModelInfo({ id: 'gpt-6-astra', name: 'GPT 6 Astra', fastReasoningEffort: 'low' }, 'pro');
    assert.equal(pro.reasoningMode, 'pro');
    assert.equal(pro.reasoningEffort, undefined);
    assert.equal(normalizeModelInfo({ provider: 'gemini', modelId: 'auto' }), null);
    assert.deepEqual(normalizeModelInfo({ provider: 'local', modelId: 'qwen-file.gguf', access_token: 'secret' }), {
        provider: 'local',
        modelId: 'qwen-file.gguf',
        displayName: 'qwen-file.gguf',
    });
    assert.equal(mergeModelsUsed([model, model], pro).length, 2);
});

test('session metadata survives alternating conversation and screen saves and exposes all actual models in list', t => {
    const { storage } = storageHarness(t);
    const fast = chatGPTModelInfo({ id: 'gpt-6-astra', name: 'GPT 6 Astra', fastReasoningEffort: 'low' });
    const fallback = normalizeModelInfo({ provider: 'gemini', modelId: 'gemini-resolved-flash' });
    assert.equal(storage.saveSession('1234', { profile: 'exam', modelInfo: fast }), true);
    assert.equal(storage.saveSession('1234', { conversationHistory: [{ ai_response: 'Answer', modelInfo: fast }], modelsUsed: [fast] }), true);
    assert.equal(
        storage.saveSession('1234', {
            screenAnalysisHistory: [{ response: 'Second answer', modelInfo: fallback }],
            modelInfo: fallback,
            modelsUsed: [fast, fallback],
        }),
        true
    );
    const saved = storage.getSession('1234');
    assert.equal(saved.profile, 'exam');
    assert.equal(saved.conversationHistory[0].modelInfo.modelId, 'gpt-6-astra');
    assert.equal(saved.screenAnalysisHistory[0].modelInfo.modelId, 'gemini-resolved-flash');
    assert.equal(saved.modelsUsed.length, 2);
    assert.equal(saved.modelInfo.modelId, 'gemini-resolved-flash');
    const summary = storage.getAllSessions()[0];
    assert.equal(summary.modelsUsed.length, 2);
    assert.equal(summary.modelInfo.modelId, 'gemini-resolved-flash');
    storage.saveSession('1235', { profile: 'exam', conversationHistory: [{ ai_response: 'Legacy answer' }] });
    assert.equal(storage.getAllSessions()[0].modelInfo, null, 'Legacy history cannot be labeled from current settings');
});

test('clearing sessions preserves settings and credentials, rejects queued old saves and accepts later answers', t => {
    const { storage, configDir } = storageHarness(t);
    const oldEpoch = storage.getHistoryEpoch();
    storage.saveSession('1234', { conversationHistory: [{ ai_response: 'Old answer' }], historyEpoch: oldEpoch });
    const protectedFiles = ['config.json', 'preferences.json', 'credentials.json', 'oauth.enc'];
    for (const file of protectedFiles) fs.writeFileSync(path.join(configDir, file), `preserve:${file}`);
    fs.writeFileSync(path.join(configDir, 'history', 'notes.txt'), 'non-session file');
    assert.equal(storage.deleteAllSessions(), true);
    assert.equal(storage.getAllSessions().length, 0);
    for (const file of protectedFiles) assert.equal(fs.readFileSync(path.join(configDir, file), 'utf8'), `preserve:${file}`);
    assert.equal(fs.readFileSync(path.join(configDir, 'history', 'notes.txt'), 'utf8'), 'non-session file');
    assert.equal(storage.saveSession('1234', { conversationHistory: [{ ai_response: 'Queued old answer' }], historyEpoch: oldEpoch }), false);
    assert.equal(storage.getAllSessions().length, 0);
    assert.equal(
        storage.saveSession('1235', { conversationHistory: [{ ai_response: 'New answer' }], historyEpoch: storage.getHistoryEpoch() }),
        true
    );
    assert.equal(storage.getAllSessions()[0].messageCount, 1);
});

test('only the main frame can clear history and failed deletions preserve active saved-entry buffers', () => {
    let deleted = 0;
    let reset = 0;
    const window = { isDestroyed: () => false, webContents: { mainFrame: {} } };
    const options = {
        window,
        storage: {
            deleteAllSessions: () => {
                deleted++;
                return true;
            },
        },
        resetSavedHistory: () => reset++,
    };
    for (const event of [{ sender: {} }, { sender: window.webContents, senderFrame: {} }]) {
        assert.equal(clearSavedHistory({ ...options, event }).success, false);
    }
    assert.equal(deleted, 0);
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    assert.equal(clearSavedHistory({ ...options, event }).success, true);
    assert.equal(deleted, 1);
    assert.equal(reset, 1);
    assert.equal(clearSavedHistory({ ...options, event, storage: { deleteAllSessions: () => false } }).success, false);
    assert.equal(reset, 1);
});

test('copying response data is bounded, main-frame only, and writes plain and rich formats together', () => {
    const window = { isDestroyed: () => false, webContents: { mainFrame: {} } };
    const writes = [];
    const clipboard = { write: data => writes.push(data) };
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const payload = { text: 'Θ(n²)', html: '<p>Θ(n²)</p>' };
    assert.equal(copyHistoryResponse({ window, clipboard, event: { sender: {} }, payload }).success, false);
    for (const invalid of [
        null,
        {},
        { text: 'text' },
        { text: 42, html: '' },
        { text: 'x'.repeat(1024 * 1024 + 1), html: '' },
        { text: '', html: 'x'.repeat(4 * 1024 * 1024 + 1) },
    ]) {
        assert.equal(copyHistoryResponse({ window, clipboard, event, payload: invalid }).success, false);
    }
    assert.equal(writes.length, 0);
    assert.equal(copyHistoryResponse({ window, clipboard, event, payload }).success, true);
    assert.deepEqual(writes, [payload]);
});
