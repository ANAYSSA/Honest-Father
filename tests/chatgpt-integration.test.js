const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
    const handlers = new Map();
    const frame = {};
    const window = { isDestroyed: () => false, webContents: { mainFrame: frame, isDestroyed: () => false, send() {} } };
    const state = { connected: true, planEnabled: true, email: 'test@example.com', activeAccountId: 'account-one' };
    const config = { chatgptModel: '', chatgptReasoningMode: 'standard' };
    const calls = [];
    let onChange;
    const models = [{ id: 'available-model', name: 'Account model', supportsPro: false }];
    const deps = {
        './historyModels': require('../src/utils/historyModels'),
        electron: {
            app: { getPath: () => '/isolated-user-data', once() {} },
            net: { fetch() {} },
            shell: { openExternal() {} },
            safeStorage: {},
            ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
        },
        './chatgptAuth': {
            createChatGPTAuth(options) {
                onChange = options.onChange;
                return {
                    getStatus: () => ({ ...state }),
                    signIn: async () => calls.push('sign-in'),
                    signOut: async () => {
                        calls.push('sign-out');
                        return { revoked: true };
                    },
                    getAccessToken: async () => 'main-only-secret',
                    dispose() {},
                };
            },
        },
        './chatgptResponses': {
            selectDefaultModel: models => models[0]?.id || '',
            createChatGPTResponses: () => ({
                listModels: async () => {
                    calls.push('models');
                    return models;
                },
                invalidateModels: () => calls.push('invalidate'),
                respond: async () => 'answer',
            }),
        },
        '../storage': {
            getConfig: () => config,
            updateConfig: (key, value) => {
                config[key] = value;
            },
        },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/utils/chatgpt.js'), 'utf8'), {
        module,
        require: name => {
            assert.ok(deps[name], name);
            return deps[name];
        },
    });
    const api = module.exports;
    api.setupChatGPT({ window: () => window, disconnected: () => calls.push('disconnected') });
    return {
        api,
        calls,
        config,
        state,
        handlers,
        window,
        change: next => {
            Object.assign(state, next);
            onChange({ ...state });
        },
        invoke: (name, ...args) => handlers.get(name)({ sender: window.webContents, senderFrame: frame }, ...args),
    };
}

test('only the main frame can sign in, sign out, view account status, or list models', async () => {
    const h = harness();
    for (const handler of h.handlers.values()) {
        assert.equal((await handler({ sender: {}, senderFrame: {} })).success, false);
        assert.equal((await handler({ sender: h.window.webContents, senderFrame: {} })).success, false);
    }
    assert.deepEqual(h.calls, []);
    const status = await h.invoke('chatgpt-status');
    assert.equal(status.email, 'test@example.com');
    assert.doesNotMatch(JSON.stringify(status), /secret|access_token|refresh_token|id_token/);
});

test('account-specific catalogue supplies the saved default and unavailable selections fail before inference', async () => {
    const h = harness();
    const result = await h.invoke('chatgpt-models');
    assert.equal(result.selectedModel, 'available-model');
    assert.equal(h.config.chatgptModel, 'available-model');
    assert.equal((await h.api.prepareChatGPT()).model, 'available-model');
    h.config.chatgptModel = 'model-not-in-the-account';
    await assert.rejects(h.api.prepareChatGPT(), /unavailable/);
    h.config.chatgptModel = 'available-model';
    h.config.chatgptReasoningMode = 'pro';
    await assert.rejects(h.api.prepareChatGPT(), /Pro is unavailable/);
});

test('disabled plan cannot list inference credentials and account changes cancel existing sessions', async () => {
    const h = harness();
    h.state.planEnabled = false;
    await assert.rejects(h.api.prepareChatGPT(), /Enable ChatGPT plan usage/);
    assert.equal(h.calls.includes('models'), false);
    h.change({ connected: false });
    assert.deepEqual(h.calls, ['invalidate', 'disconnected']);
    await assert.rejects(h.api.prepareChatGPT(), /Continue with ChatGPT/);
});

test('signing out stops active requests before attempting remote revocation', async () => {
    const h = harness();
    await h.invoke('chatgpt-sign-out');
    assert.deepEqual(h.calls, ['disconnected', 'invalidate', 'sign-out']);
});
