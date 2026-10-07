const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const reliability = require('../src/utils/geminiReliability');
const geminiModels = require('../src/utils/geminiModels');

async function flush() {
    for (let i = 0; i < 32; i++) await Promise.resolve();
}

function harness({
    autoSetup = true,
    sdkError = null,
    stream = null,
    deferredConnect = null,
    platform = 'darwin',
    fetch: fetchMock = null,
    groqKey = '',
    chatgptRespond = null,
    chatgptPrepare = null,
    reviewOverlay = null,
    catalogue = null,
    catalogueError = null,
    listModels = null,
    netFetch = async () => ({ ok: true }),
} = {}) {
    let now = 0;
    let nextTimer = 0;
    const pending = new Map();
    const clock = {
        now: () => now,
        setTimeout(callback, delay) {
            const id = ++nextTimer;
            pending.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout(id) {
            pending.delete(id);
        },
        async advance(ms) {
            const target = now + ms;
            while (true) {
                const due = [...pending].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                pending.delete(due[0]);
                now = due[1].at;
                await due[1].callback();
                await flush();
            }
            now = target;
        },
    };
    const events = [];
    const handlers = new Map();
    const connections = [];
    const clients = [];
    const requests = [];
    const chatgptRequests = [];
    const catalogueRequests = [];
    const children = [];
    const stored = {
        apiKey: 'unit-test-key',
        preferences: { googleSearchEnabled: false },
        groqKey,
        config: { geminiLiveModel: 'gemini-3.8-live', groqModel: 'qwen/qwen3.6-27b', groqImageModel: 'qwen/qwen3.6-27b', disableGroqThinking: true },
    };
    class GoogleGenAI {
        constructor(options) {
            if (sdkError) throw sdkError;
            clients.push(options);
            this.live = {
                connect: async params => {
                    const connection = { ...params, sends: [], closes: 0 };
                    const session = {
                        sendRealtimeInput: payload => {
                            connection.sends.push(payload);
                        },
                        sendClientContent: payload => {
                            connection.sends.push(payload);
                        },
                        close: () => {
                            connection.closes++;
                        },
                    };
                    connection.session = session;
                    connections.push(connection);
                    params.callbacks.onopen();
                    if (autoSetup) queueMicrotask(() => params.callbacks.onmessage({ setupComplete: {} }));
                    if (deferredConnect) await deferredConnect;
                    return session;
                },
            };
            this.models = {
                list: async params => {
                    catalogueRequests.push(params);
                    if (listModels) return listModels(params, catalogueRequests.length);
                    if (catalogueError) throw catalogueError;
                    return (async function* () {
                        yield* catalogue || [
                            { name: 'models/gemini-3.1-flash-lite', supportedActions: ['generateContent'] },
                            { name: 'models/gemini-3.5-flash-lite', supportedActions: ['generateContent'] },
                            { name: 'models/gemini-3.8-live', supportedActions: ['bidiGenerateContent'] },
                        ];
                    })();
                },
                generateContentStream: async params => {
                    requests.push(params);
                    return stream
                        ? stream(params)
                        : (async function* () {
                              yield { text: 'The answer is 42.' };
                          })();
                },
            };
        }
    }
    const electron = {
        net: { fetch: netFetch },
        app: { isPackaged: false },
        BrowserWindow: {
            getAllWindows: () => [
                { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, data) => events.push({ channel, data }) } },
            ],
        },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    };
    const dependencies = {
        '@google/genai': { GoogleGenAI, Modality: { AUDIO: 'AUDIO' } },
        electron,
        child_process: {
            spawn: () => {
                const child = new EventEmitter();
                child.pid = children.length + 1;
                child.stdout = new EventEmitter();
                child.stderr = new EventEmitter();
                child.kills = [];
                child.kill = signal => child.kills.push(signal);
                children.push(child);
                return child;
            },
        },
        '../audioUtils': { saveDebugAudio: () => {} },
        './chatgpt': {
            prepareChatGPT: chatgptPrepare || (async () => ({ model: 'account-model', reasoningMode: 'standard' })),
            respond: async options => {
                chatgptRequests.push(options);
                if (chatgptRespond) return chatgptRespond(options);
                options.onText('The answer is 42.');
                return 'The answer is 42.';
            },
        },
        './prompts': require('../src/utils/prompts'),
        './historyModels': require('../src/utils/historyModels'),
        './testReview': require('../src/utils/testReview'),
        '../storage': {
            getAvailableModel: () => stored.config.geminiImageModel || 'gemini-3.1-flash-lite',
            incrementLimitCount: () => {},
            getApiKey: () => stored.apiKey,
            getGroqApiKey: () => stored.groqKey,
            incrementCharUsage: () => {},
            getConfig: () => stored.config,
            getPreferences: () => stored.preferences,
            getHistoryEpoch: () => stored.historyEpoch || 0,
        },
        './cloud': {
            connectCloud: async () => {},
            sendCloudAudio: () => {},
            sendCloudText: () => {},
            sendCloudImage: () => true,
            closeCloud: () => {},
            isCloudActive: () => false,
            setOnTurnComplete: () => {},
            setRendererWindow: () => {},
        },
        './transportLogger': { startTransportLog: () => {}, logTransportEvent: () => {}, closeTransportLog: () => {} },
        './geminiReliability': {
            ...reliability,
            createReconnectController: options => reliability.createReconnectController({ ...options, timers: clock, random: () => 0 }),
            createRequestGate: () => reliability.createRequestGate({ now: clock.now }),
            createPcmActivityFilter: () => reliability.createPcmActivityFilter({ now: clock.now }),
        },
        './geminiModels': {
            ...geminiModels,
            createGeminiModelResolver: options => geminiModels.createGeminiModelResolver({ now: clock.now, ...options }),
        },
    };
    const module = { exports: {} };
    const context = {
        module,
        exports: module.exports,
        require: name => {
            if (name === 'path') return path;
            if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`);
            return dependencies[name];
        },
        global: {},
        Buffer,
        AbortController,
        TextDecoder,
        fetch: fetchMock,
        console: { log() {}, warn() {}, error() {} },
        process: { platform, env: {}, resourcesPath: '/resources', stdout: { write() {} } },
        __dirname: path.resolve(__dirname, '../src/utils'),
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
    };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/utils/gemini.js'), 'utf8'), context);
    const api = module.exports;
    const ref = { current: null };
    const window = electron.BrowserWindow.getAllWindows()[0];
    window.webContents.mainFrame = {};
    api.setMainWindow(window, reviewOverlay);
    api.setupGeminiIpcHandlers(ref);
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    return {
        api,
        ref,
        clock,
        events,
        connections,
        clients,
        requests,
        chatgptRequests,
        catalogueRequests,
        children,
        stored,
        window,
        invoke: (name, ...args) => handlers.get(name)(event, ...args),
        invokeFrom: (name, sender, ...args) => handlers.get(name)(sender, ...args),
    };
}

test('Live init waits for setup acknowledgement and uses the supported native-audio payload', async () => {
    const h = harness({ autoSetup: false });
    let resolved = false;
    const initializing = h.invoke('initialize-gemini', 'unit-test-key', '', 'interview', 'ru-RU').then(value => {
        resolved = true;
        return value;
    });
    await flush();
    assert.equal(resolved, false);
    assert.equal(h.ref.current, null);
    const connection = h.connections[0];
    assert.equal(h.clients[0].httpOptions.apiVersion, 'v1beta');
    assert.deepEqual(Array.from(connection.config.responseModalities), ['AUDIO']);
    assert.equal(connection.config.speechConfig, undefined);
    assert.equal(connection.config.proactivity, undefined);
    assert.deepEqual(Object.keys(connection.config.inputAudioTranscription), []);
    assert.deepEqual(Object.keys(connection.config.outputAudioTranscription), []);
    assert.deepEqual(Object.keys(connection.config.sessionResumption), []);
    assert.match(connection.config.systemInstruction.parts[0].text, /ru-RU/);
    connection.callbacks.onmessage({ setupComplete: {} });
    assert.equal(await initializing, true);
    assert.equal(h.ref.current, connection.session);
    h.api.closeActiveSession();
});

test('late input transcription is retained until turn completion and streamed output is saved once', async () => {
    const h = harness();
    assert.equal(await h.invoke('initialize-gemini', 'unit-test-key'), true);
    const cb = h.connections[0].callbacks;
    cb.onmessage({ serverContent: { inputTranscription: { text: 'What is ' } } });
    cb.onmessage({ serverContent: { outputTranscription: { text: '42' } } });
    cb.onmessage({ serverContent: { generationComplete: true } });
    cb.onmessage({ serverContent: { inputTranscription: { text: 'the answer?' } } });
    cb.onmessage({ serverContent: { turnComplete: true } });
    const saved = h.api.getCurrentSessionData().history;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].transcription, 'What is the answer?');
    assert.equal(saved[0].ai_response, '42');
    assert.equal(h.events.filter(event => event.channel === 'new-response').length, 1);
    h.api.closeActiveSession();
});

test('quota close clears the active session, notifies capture cleanup and cancels a prior network retry', async () => {
    const h = harness();
    await h.invoke('initialize-gemini', 'unit-test-key');
    const cb = h.connections[0].callbacks;
    cb.onerror({ message: 'WebSocket disconnected' });
    cb.onclose({ code: 1008, reason: 'RESOURCE_EXHAUSTED: quota exceeded' });
    await h.clock.advance(10000);
    assert.equal(h.ref.current, null);
    assert.equal(h.connections.length, 1);
    const ended = h.events.filter(event => event.channel === 'provider-session-ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].data.code, 'quota');
    assert.match(h.events.filter(event => event.channel === 'update-status').at(-1).data, /quota/);
});

test('close/quit during reconnect delay and pending setup cannot resurrect a Live session', async () => {
    const h = harness();
    await h.invoke('initialize-gemini', 'unit-test-key');
    h.connections[0].callbacks.onclose({ code: 1006, reason: '' });
    h.api.closeActiveSession();
    await h.clock.advance(10000);
    assert.equal(h.connections.length, 1);
    let completeConnect;
    const pending = harness({
        autoSetup: false,
        deferredConnect: new Promise(resolve => {
            completeConnect = resolve;
        }),
    });
    const initializing = pending.invoke('initialize-gemini', 'unit-test-key');
    await flush();
    pending.api.closeActiveSession();
    assert.equal(await initializing, false);
    completeConnect();
    await flush();
    assert.equal(pending.ref.current, null);
    assert.equal(pending.connections[0].closes, 1);
    assert.equal(pending.events.filter(event => event.channel === 'provider-session-ended').length, 0);
});

test('network reconnect resumes the server session without injecting duplicate history', async () => {
    const h = harness();
    await h.invoke('initialize-gemini', 'unit-test-key');
    const cb = h.connections[0].callbacks;
    cb.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'private-unit-test-handle' } });
    cb.onclose({ code: 1006 });
    await h.clock.advance(1000);
    assert.equal(h.connections.length, 2);
    assert.equal(h.connections[1].config.sessionResumption.handle, 'private-unit-test-handle');
    assert.equal(h.connections[1].sends.length, 0);
    assert.equal(h.ref.current, h.connections[1].session);
    h.api.closeActiveSession();
});

test('failed construction releases initialization state and surfaces an actionable auth error', async () => {
    const h = harness({ sdkError: { status: 403, message: 'PERMISSION_DENIED' } });
    assert.equal(await h.invoke('initialize-gemini', 'unit-test-key'), false);
    assert.equal(await h.invoke('initialize-gemini', 'unit-test-key'), false);
    assert.equal(h.events.filter(event => event.channel === 'session-initializing' && event.data === false).length, 2);
    assert.match(h.events.filter(event => event.channel === 'update-status').at(-1).data, /API key/);
});

test('screen-only session and streamed screenshots never initialize Live or native audio', async () => {
    const h = harness();
    assert.equal(await h.invoke('initialize-screen-session', 'exam', 'Explain concisely'), true);
    const result = await h.invoke('send-image-content', { data: Buffer.alloc(1600).toString('base64'), prompt: 'Answer the displayed problem.' });
    assert.equal(result.success, true);
    assert.equal(result.model, 'gemini-3.1-flash-lite');
    assert.equal(h.connections.length, 0);
    assert.equal(h.children.length, 0);
    assert.equal(h.clients[0].httpOptions.timeout, 45000);
    assert.equal(h.clients[0].httpOptions.retryOptions.attempts, 1);
    assert.match(h.requests[0].config.systemInstruction, /Explain concisely/);
    assert.match(h.requests[0].config.systemInstruction, /exam preparation/);
    assert.match(h.requests[0].config.systemInstruction, /complete runnable implementation/);
    assert.doesNotMatch(h.requests[0].config.systemInstruction, /exact words to say|sentences max|No coaching|no explanations/);
    assert.equal(h.events.filter(event => event.channel === 'new-response')[0].data, 'The answer is 42.');
    await h.invoke('close-session');
});

test('Gemini screenshots during a Live interview use a coding-capable instruction while retaining custom context', async () => {
    const custom = 'Use TypeScript for data structure exercises.';
    const h = harness();
    await h.invoke('initialize-gemini', 'unit-test-key', custom, 'interview');
    assert.match(h.connections[0].config.systemInstruction.parts[0].text, /exact words to say/);
    const image = { data: Buffer.alloc(1600).toString('base64'), prompt: 'Solve the displayed coding exercise.' };
    assert.equal((await h.invoke('send-image-content', image)).success, true);
    const system = h.requests[0].config.systemInstruction;
    assert.match(system, /mock interview practice/);
    assert.match(system, /complete runnable implementation/);
    assert.match(system, /time and space complexity/);
    assert.ok(system.includes(custom));
    assert.doesNotMatch(system, /exact words to say|sentences max|No coaching|no explanations/);
    h.api.closeActiveSession();
});

test('normal Gemini screenshots ignore a legacy Groq key and retain the study context', async () => {
    const h = harness({
        groqKey: 'old-saved-key',
        fetch: () => {
            throw new Error('Legacy Groq must not be used');
        },
    });
    const custom = 'Course: algorithms. Show the final answer first.';
    await h.invoke('initialize-screen-session', 'exam', custom);
    const result = await h.invoke('send-image-content', { data: Buffer.alloc(1600).toString('base64'), prompt: 'Answer the practice question.' });
    assert.equal(result.success, true);
    assert.equal(h.requests.length, 1);
    assert.ok(h.requests[0].config.systemInstruction.includes(custom));
});

test('ChatGPT screen-only sessions need no Gemini key or Live connection and stream their answer', async () => {
    const h = harness({ groqKey: 'old-saved-key' });
    h.stored.apiKey = '';
    h.stored.config.normalResponseProvider = 'chatgpt';
    assert.equal(await h.invoke('initialize-screen-session', 'exam', 'Use Russian.'), true);
    const result = await h.invoke('send-image-content', { data: Buffer.alloc(1600).toString('base64'), prompt: 'Solve this.' });
    assert.equal(result.success, true);
    assert.equal(h.chatgptRequests.length, 1);
    assert.equal(h.chatgptRequests[0].model, 'account-model');
    assert.match(h.chatgptRequests[0].instructions, /Use Russian/);
    assert.equal(h.connections.length, 0);
    assert.equal(h.requests.length, 0);
    assert.equal(h.events.find(event => event.channel === 'new-response').data, 'The answer is 42.');
    assert.equal((await h.invoke('send-text-message', 'Explain why.')).completed, true);
    assert.equal(h.chatgptRequests.length, 2);
    assert.equal(h.chatgptRequests[1].history.length, 2);
});

test('normal screenshot providers respect label emphasis while preserving math and context', async () => {
    for (const provider of ['gemini', 'chatgpt']) {
        for (const enabled of [true, false]) {
            const h = harness();
            h.stored.config.normalResponseProvider = provider;
            h.stored.preferences.emphasizeAnswerLabels = enabled;
            assert.equal(await h.invoke('initialize-screen-session', 'exam', 'Use **my course context**.'), true);
            const result = await h.invoke('send-image-content', { data: Buffer.alloc(1600).toString('base64'), prompt: 'Solve the question.' });
            assert.equal(result.success, true);
            const instruction = provider === 'chatgpt' ? h.chatgptRequests[0].instructions : h.requests[0].config.systemInstruction;
            assert.equal(instruction.includes('Emphasize each supplied question number'), enabled);
            assert.ok(instruction.includes(String.raw`\(\Theta(n^2)\)`));
            assert.ok(instruction.includes('Use **my course context**.'));
            if (provider === 'chatgpt') {
                assert.equal((await h.invoke('send-text-message', 'Explain why.')).success, true);
                assert.equal(h.chatgptRequests[1].instructions.includes('Emphasize each supplied question number'), enabled);
            }
            h.api.closeActiveSession();
        }
    }
});

test('Live and ChatGPT transcribed answers receive the chosen presentation setting', async () => {
    for (const enabled of [true, false]) {
        const h = harness();
        h.stored.preferences.emphasizeAnswerLabels = enabled;
        h.stored.config.normalResponseProvider = 'chatgpt';
        assert.equal(await h.invoke('initialize-gemini', 'test-key', 'Use Russian.', 'exam', 'ru-RU'), true);
        const connection = h.connections[0];
        const instruction = connection.config.systemInstruction.parts[0].text;
        assert.equal(instruction.includes('Emphasize each supplied question number'), enabled);
        assert.ok(instruction.includes(String.raw`\(\Theta(n^2)\)`));
        assert.match(instruction, /ru-RU/);
        connection.callbacks.onmessage({ serverContent: { inputTranscription: { text: 'Question 7. Choose A or B.', finished: true } } });
        await flush();
        assert.equal(h.chatgptRequests.length, 1);
        assert.equal(h.chatgptRequests[0].instructions, instruction);
        h.api.closeActiveSession();
    }
});

test('history records actual ChatGPT response metadata and clearing saved buffers does not resurrect older turns', async () => {
    const initial = {
        provider: 'chatgpt',
        modelId: 'account-model',
        displayName: 'Account model',
        reasoningMode: 'standard',
        reasoningEffort: 'low',
    };
    const resolved = { ...initial, modelId: 'resolved-model', displayName: 'Resolved model' };
    const h = harness({
        chatgptPrepare: async () => ({ model: 'account-model', reasoningMode: 'standard', modelInfo: initial }),
        chatgptRespond: async options => {
            options.onModel(resolved);
            options.onText('Answer');
            return 'Answer';
        },
    });
    h.stored.config.normalResponseProvider = 'chatgpt';
    await h.invoke('initialize-screen-session', 'exam', 'Context');
    assert.equal(h.events.find(event => event.channel === 'save-session-context').data.modelInfo.displayName, 'Account model');
    await h.invoke('send-image-content', { data: Buffer.alloc(1600).toString('base64'), prompt: 'Question' });
    const screen = h.events.find(event => event.channel === 'save-screen-analysis').data;
    assert.equal(screen.analysis.modelInfo.modelId, 'resolved-model');
    assert.equal(screen.analysis.model, 'resolved-model');
    await h.invoke('send-text-message', 'First follow-up');
    const old = h.events.filter(event => event.channel === 'save-conversation-turn').at(-1).data;
    h.stored.historyEpoch = 1;
    h.api.resetSavedHistory();
    await h.invoke('send-text-message', 'After clear');
    const next = h.events.filter(event => event.channel === 'save-conversation-turn').at(-1).data;
    assert.notEqual(next.sessionId, old.sessionId);
    assert.equal(next.fullHistory.length, 1);
    assert.equal(next.fullHistory[0].transcription, 'After clear');
    assert.equal(next.fullHistory[0].modelInfo.displayName, 'Resolved model');
    assert.equal(next.historyEpoch, 1);
    assert.equal(next.profile, 'exam');
});

test('a Gemini Live answer keeps its own model after a screenshot used another model', async () => {
    const h = harness();
    await h.invoke('initialize-gemini', 'test-key', '', 'exam');
    await h.invoke('send-image-content', { data: Buffer.alloc(1600).toString('base64'), prompt: 'Question' });
    const connection = h.connections[0];
    connection.callbacks.onmessage({
        serverContent: { inputTranscription: { text: 'Follow-up' }, outputTranscription: { text: 'Spoken answer' }, turnComplete: true },
    });
    const saved = h.events.find(event => event.channel === 'save-conversation-turn').data;
    assert.equal(saved.turn.modelInfo.modelId, 'gemini-3.8-live');
    assert.equal(saved.modelsUsed.length, 2);
    assert.equal(saved.modelInfo.modelId, 'gemini-3.8-live');
});

test('screen quota failure pauses follow-up calls without opening Live or hiding provider error', async () => {
    const h = harness({
        stream: async function* () {
            throw { status: 429, message: 'RESOURCE_EXHAUSTED' };
        },
    });
    await h.invoke('initialize-screen-session');
    const image = { data: Buffer.alloc(1600).toString('base64'), prompt: 'Solve this.' };
    const first = await h.invoke('send-image-content', image);
    const second = await h.invoke('send-image-content', image);
    assert.equal(first.code, 'quota');
    assert.equal(second.retryAfterMs, 60000);
    assert.equal(h.requests.length, 1);
    assert.equal(h.connections.length, 0);
    assert.equal(h.events.filter(event => event.channel === 'provider-session-ended').length, 0);
});

test('a slow screenshot holds a single request slot and another screenshot is skipped', async () => {
    let release;
    const wait = new Promise(resolve => {
        release = resolve;
    });
    const h = harness({
        stream: async function* () {
            await wait;
            yield { text: 'Answer' };
        },
    });
    await h.invoke('initialize-screen-session');
    const image = { data: Buffer.alloc(1600).toString('base64'), prompt: 'Solve this.' };
    const first = h.invoke('send-image-content', image);
    await flush();
    const second = await h.invoke('send-image-content', image);
    assert.equal(second.skipped, true);
    assert.equal(second.code, 'busy');
    assert.equal(h.requests.length, 1);
    release();
    assert.equal((await first).success, true);
});

test('closing a ChatGPT screenshot aborts it and suppresses late response events', async () => {
    let release;
    const wait = new Promise(resolve => {
        release = resolve;
    });
    const h = harness({
        chatgptRespond: async options => {
            await wait;
            options.onText('Old answer');
            return 'Old answer';
        },
    });
    h.stored.config.normalResponseProvider = 'chatgpt';
    await h.invoke('initialize-screen-session');
    const screenshot = h.invoke('send-image-content', { data: Buffer.alloc(1600).toString('base64'), prompt: 'Solve this.' });
    await flush();
    assert.equal((await h.invoke('send-text-message', 'Again')).code, 'busy');
    await h.invoke('close-session', { silent: true });
    assert.equal(h.chatgptRequests[0].signal.aborted, true);
    release();
    assert.equal((await screenshot).code, 'cancelled');
    assert.equal(h.events.filter(event => event.channel === 'new-response').length, 0);
    assert.equal(h.events.filter(event => event.channel === 'save-screen-analysis').length, 0);
});

test('ChatGPT preparation cancelled by session close cannot reactivate the session', async () => {
    let release;
    const wait = new Promise(resolve => {
        release = resolve;
    });
    const h = harness({
        chatgptPrepare: async () => {
            await wait;
            return { model: 'account-model' };
        },
    });
    h.stored.config.normalResponseProvider = 'chatgpt';
    const start = h.invoke('initialize-screen-session');
    await flush();
    h.api.closeActiveSession();
    release();
    assert.equal(await start, false);
    assert.equal(h.api.isChatGPTSession(), false);
});

test('Gemini Live transcriptions use ChatGPT only once and suppress Gemini answer text', async () => {
    const h = harness();
    h.stored.config.normalResponseProvider = 'chatgpt';
    assert.equal(await h.invoke('initialize-gemini', 'test-key'), true);
    const message = h.connections[0].callbacks.onmessage;
    message({ serverContent: { inputTranscription: { text: 'Practice question', finished: true }, outputTranscription: { text: 'Do not show' } } });
    await flush();
    message({ serverContent: { turnComplete: true } });
    await flush();
    assert.equal(h.chatgptRequests.length, 1);
    assert.equal(h.chatgptRequests[0].prompt, 'Practice question');
    assert.equal(
        h.events.some(event => event.data === 'Do not show'),
        false
    );
});

test('ChatGPT quota failure clears queued speech, pauses new calls, and keeps the actionable status', async () => {
    let release;
    const wait = new Promise(resolve => {
        release = resolve;
    });
    const h = harness({
        chatgptRespond: async () => {
            await wait;
            throw Object.assign(new Error('ChatGPT app usage limit reached.'), { status: 429, code: 'subscription_sharing_usage_limit_exceeded' });
        },
    });
    h.stored.config.normalResponseProvider = 'chatgpt';
    await h.invoke('initialize-gemini', 'test-key');
    const message = h.connections[0].callbacks.onmessage;
    message({ serverContent: { inputTranscription: { text: 'First question', finished: true } } });
    message({ serverContent: { turnComplete: true } });
    message({ serverContent: { inputTranscription: { text: 'Queued question', finished: true } } });
    release();
    await flush();
    message({ serverContent: { turnComplete: true } });
    message({ serverContent: { inputTranscription: { text: 'Later question', finished: true } } });
    await flush();
    assert.equal(h.chatgptRequests.length, 1);
    assert.equal((await h.invoke('send-text-message', 'Manual attempt')).code, 'subscription_sharing_usage_limit_exceeded');
    assert.equal(h.chatgptRequests.length, 1);
    assert.equal(h.events.filter(event => event.channel === 'update-status').at(-1).data, 'ChatGPT app usage limit reached.');
    h.api.closeActiveSession();
});

test('setup timeout closes the candidate and allows another fresh initialization', async () => {
    const h = harness({ autoSetup: false });
    const first = h.invoke('initialize-gemini', 'unit-test-key');
    await flush();
    await h.clock.advance(15000);
    assert.equal(await first, false);
    assert.equal(h.connections[0].closes, 1);
    assert.equal(h.ref.current, null);
    const second = h.invoke('initialize-gemini', 'unit-test-key');
    await flush();
    h.connections[1].callbacks.onmessage({ setupComplete: {} });
    assert.equal(await second, true);
    h.api.closeActiveSession();
});

test('closing a screenshot aborts the request and prevents late chunks from reaching a new session', async () => {
    let release;
    const gate = new Promise(resolve => {
        release = resolve;
    });
    const h = harness({
        stream: async function* () {
            await gate;
            yield { text: 'Old answer' };
        },
    });
    await h.invoke('initialize-screen-session');
    const screenshot = h.invoke('send-image-content', { data: Buffer.alloc(1600).toString('base64'), prompt: 'Solve this.' });
    await flush();
    await h.invoke('close-session', { silent: true });
    assert.equal(h.requests[0].config.abortSignal.aborted, true);
    await h.invoke('initialize-screen-session');
    release();
    const result = await screenshot;
    assert.equal(result.code, 'cancelled');
    assert.equal(h.events.filter(event => event.channel === 'new-response').length, 0);
    assert.equal(h.events.filter(event => event.channel === 'save-screen-analysis').length, 0);
});

test('native audio startup requires helper acknowledgement and permission failure ends the provider', async () => {
    const h = harness();
    await h.invoke('initialize-gemini', 'unit-test-key');
    let finished = false;
    const starting = h.api.startMacOSAudioCapture(h.ref).then(success => {
        finished = true;
        return success;
    });
    await flush();
    assert.equal(finished, false);
    h.children[0].stderr.emit('data', Buffer.from('System audio capture started: 24000 Hz\n'));
    assert.equal(await starting, true);
    h.children[0].stderr.emit('data', Buffer.from('Screen capture permission was denied\n'));
    h.children[0].emit('close', 1);
    assert.equal(h.ref.current, null);
    assert.match(h.events.filter(event => event.channel === 'provider-session-ended').at(-1).data.reason, /permission was denied/);
});

test('stop during native startup await cannot spawn an orphan and old child close cannot erase a newer child', async () => {
    const h = harness();
    const cancelled = h.api.startMacOSAudioCapture(h.ref);
    h.api.stopMacOSAudioCapture();
    assert.equal(await cancelled, false);
    assert.equal(h.children.length, 0);
    const first = h.api.startMacOSAudioCapture(h.ref);
    await flush();
    h.children[0].stderr.emit('data', Buffer.from('System audio capture started: 24000 Hz\n'));
    assert.equal(await first, true);
    const second = h.api.startMacOSAudioCapture(h.ref);
    await flush();
    h.children[1].stderr.emit('data', Buffer.from('System audio capture started: 24000 Hz\n'));
    assert.equal(await second, true);
    h.children[0].emit('close', 0);
    h.api.stopMacOSAudioCapture();
    assert.equal(h.children[1].kills.length, 1);
    assert.equal(h.events.filter(event => event.channel === 'provider-session-ended').length, 0);
});

const reviewJson = JSON.stringify({
    question_box: [100, 100, 800, 800],
    answers: [{ label: 'B', box: [350, 120, 375, 145] }],
    confidence: 0.95,
});

function reviewManagerStub() {
    const cached = [];
    let active = true;
    let current = 1;
    return {
        cached,
        isActive: () => active,
        end: () => {
            active = false;
        },
        start: () => {
            active = true;
        },
        status: () => {},
        invalidate: () => {
            current++;
        },
        validateCapture: token => (token?.requestId === current ? { success: true } : { success: false, error: 'Stale capture' }),
        cacheAnswer(token, answer, dimensions) {
            const valid = this.validateCapture(token);
            if (valid.success && active) cached.push({ token, answer, dimensions });
            return active ? valid : { success: false, error: 'Review ended' };
        },
    };
}

async function startReview(h, manager) {
    assert.equal(await h.invoke('initialize-screen-session', 'interview', '', 'test-review'), true);
    manager.start();
}

const reviewPayload = () => ({
    data: Buffer.alloc(1200, 2).toString('base64'),
    reviewCapture: { requestId: 1 },
    imageWidth: 1920,
    imageHeight: 1080,
});

test('test review caches complete validated JSON without streaming normal answers or starting Live/audio', async () => {
    const manager = reviewManagerStub();
    const h = harness({
        reviewOverlay: manager,
        stream: async function* () {
            yield { text: reviewJson.slice(0, 60) };
            yield { text: reviewJson.slice(60) };
        },
    });
    h.stored.config.normalResponseProvider = 'chatgpt';
    await startReview(h, manager);
    const result = await h.invoke('send-image-content', reviewPayload());
    assert.equal(result.success, true);
    assert.equal(result.reviewAnswer.answers[0].label, 'B');
    assert.equal(manager.cached.length, 1);
    assert.equal(h.connections.length, 0);
    assert.equal(h.children.length, 0);
    assert.equal(h.requests[0].config.responseMimeType, 'application/json');
    assert.equal(h.requests[0].config.systemInstruction, require('../src/utils/testReview').REVIEW_SYSTEM_PROMPT);
    assert.equal(
        h.events.some(event => ['new-response', 'update-response', 'save-screen-analysis'].includes(event.channel)),
        false
    );
});

test('malformed or uncertain review responses cannot be cached as visual choices', async () => {
    for (const text of [reviewJson.slice(0, -2), '{"question_box":[0,0,0,0],"answers":[],"confidence":0}']) {
        const manager = reviewManagerStub();
        const h = harness({
            reviewOverlay: manager,
            stream: async function* () {
                yield { text };
            },
        });
        await startReview(h, manager);
        const result = await h.invoke('send-image-content', reviewPayload());
        assert.equal(result.success, false);
        assert.equal(manager.cached.length, 0);
    }
});

test('review screenshots from another window or child frame and stale tokens are rejected before provider calls', async () => {
    const manager = reviewManagerStub();
    const h = harness({ reviewOverlay: manager });
    await startReview(h, manager);
    for (const event of [
        { sender: {}, senderFrame: {} },
        { sender: h.window.webContents, senderFrame: {} },
    ]) {
        const result = await h.invokeFrom('send-image-content', event, reviewPayload());
        assert.equal(result.success, false);
    }
    manager.invalidate();
    assert.equal((await h.invoke('send-image-content', reviewPayload())).success, false);
    assert.equal(h.requests.length, 0);
});

test('a review result arriving after a new capture cannot replace the cached answer', async () => {
    const manager = reviewManagerStub();
    let finish;
    const ready = new Promise(resolve => {
        finish = resolve;
    });
    const h = harness({
        reviewOverlay: manager,
        stream: async function* () {
            await ready;
            yield { text: reviewJson };
        },
    });
    await startReview(h, manager);
    const request = h.invoke('send-image-content', reviewPayload());
    await flush();
    manager.invalidate();
    finish();
    assert.equal((await request).success, false);
    assert.equal(manager.cached.length, 0);
});

test('review results use the configured Groq image provider with the same strict response format', async () => {
    const manager = reviewManagerStub();
    const bodies = [];
    const h = harness({
        reviewOverlay: manager,
        groqKey: 'unit-groq-key',
        fetch: async (_url, options) => {
            bodies.push(JSON.parse(options.body));
            let read = false;
            return {
                ok: true,
                status: 200,
                body: {
                    getReader: () => ({
                        read: async () => {
                            if (read) return { done: true };
                            read = true;
                            return {
                                done: false,
                                value: new TextEncoder().encode(
                                    `data: ${JSON.stringify({ choices: [{ delta: { content: reviewJson }, finish_reason: 'stop' }] })}\n\n`
                                ),
                            };
                        },
                    }),
                },
            };
        },
    });
    await startReview(h, manager);
    const result = await h.invoke('send-image-content', reviewPayload());
    assert.equal(result.success, true);
    assert.equal(manager.cached.length, 1);
    assert.equal(h.requests.length, 0);
    assert.match(bodies[0].messages[0].content, /multiple-choice practice test/);
    assert.equal(bodies[0].temperature, 0.1);
    assert.equal(
        h.events.some(event => ['new-response', 'update-response'].includes(event.channel)),
        false
    );
});

test('provider notifications stay addressed to the registered main window when overlays exist', () => {
    const h = harness();
    h.api.sendToRenderer('update-status', 'Main only');
    assert.equal(h.events.at(-1).data, 'Main only');
    h.api.setMainWindow(null);
    const count = h.events.length;
    h.api.sendToRenderer('update-status', 'No orphan overlay message');
    assert.equal(h.events.length, count);
});

async function setupImageMode(options, testReview = false) {
    const manager = testReview ? reviewManagerStub() : null;
    const h = harness({ ...options, reviewOverlay: manager });
    h.stored.config.geminiImageModel = options.selected || 'auto';
    if (testReview) await startReview(h, manager);
    else await h.invoke('initialize-screen-session');
    const payload = testReview ? reviewPayload() : { data: Buffer.alloc(1600).toString('base64'), prompt: 'Solve the displayed question.' };
    return { h, manager, request: () => h.invoke('send-image-content', payload) };
}

test('screenshots and Test Review use Chromium fetch with the exact request and cancellation signal', async () => {
    for (const testReview of [false, true]) {
        const calls = [];
        const response = { ok: true };
        const { h, request } = await setupImageMode(
            {
                netFetch: async (...args) => {
                    calls.push(args);
                    return response;
                },
                stream: async function* () {
                    yield { text: testReview ? reviewJson : '42' };
                },
            },
            testReview
        );
        assert.equal((await request()).success, true);
        const client = h.clients.at(-1);
        const init = { method: 'POST', body: 'fixture', signal: h.requests[0].config.abortSignal };
        assert.equal(await client.httpOptions.fetch('https://example.test/request', init), response);
        assert.equal(calls.length, 1);
        assert.equal(calls[0][1], init);
        assert.equal(client.httpOptions.timeout, 45000);
        assert.equal(client.httpOptions.retryOptions.attempts, 1);
        assert.equal(h.catalogueRequests.length, 1);
    }
});

test('Live catalogue client also uses Chromium fetch without substituting Node networking', async () => {
    const calls = [];
    const h = harness({
        netFetch: async (...args) => {
            calls.push(args);
            return 'chromium';
        },
    });
    await h.invoke('initialize-gemini', 'unit-test-key');
    assert.equal(await h.clients[0].httpOptions.fetch('https://example.test/catalogue', {}), 'chromium');
    assert.equal(calls.length, 1);
});

test('normal screenshots and Test Review replace a missing saved model before generation', async () => {
    for (const testReview of [false, true]) {
        const { h, request, manager } = await setupImageMode(
            {
                selected: 'gemini-3.1-flash-lite',
                catalogue: [{ name: 'models/gemini-3.5-flash-lite', supportedActions: ['generateContent'] }],
                stream: async function* () {
                    yield { text: testReview ? reviewJson : '42' };
                },
            },
            testReview
        );
        assert.equal((await request()).success, true);
        assert.deepEqual(
            h.requests.map(item => item.model),
            ['gemini-3.5-flash-lite']
        );
        assert.equal(h.catalogueRequests.length, 1);
        if (testReview) assert.equal(manager.cached.length, 1);
    }
});

test('both screenshot modes rotate once on explicit model rejection before streaming and remember the replacement', async () => {
    for (const testReview of [false, true]) {
        const { h, request } = await setupImageMode(
            {
                selected: 'gemini-3.1-flash-lite',
                stream: async function* (params) {
                    if (params.model === 'gemini-3.1-flash-lite') throw { status: 404, message: 'models/gemini-3.1-flash-lite is not found' };
                    yield { text: testReview ? reviewJson : '42' };
                },
            },
            testReview
        );
        assert.equal((await request()).success, true);
        assert.deepEqual(
            h.requests.map(item => item.model),
            ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']
        );
        assert.equal(h.catalogueRequests.length, 2);
        if (!testReview) {
            const saved = h.events.find(event => event.channel === 'save-screen-analysis').data;
            assert.equal(saved.modelInfo.modelId, 'gemini-3.5-flash-lite');
            assert.equal(saved.analysis.modelInfo.modelId, 'gemini-3.5-flash-lite');
            assert.equal(saved.modelsUsed.length, 1, 'A rejected model did not answer and must not be labeled as used');
        }
        assert.equal((await request()).success, true);
        assert.equal(h.requests.at(-1).model, 'gemini-3.5-flash-lite');
        assert.equal(h.requests.length, 3);
        assert.equal(h.catalogueRequests.length, 2);
    }
});

test('fallback excludes the rejected ID even after initial catalogue network failure', async () => {
    const { h, request } = await setupImageMode({
        selected: 'gemini-3.5-flash-lite',
        listModels: async (_params, count) => {
            if (count === 1) throw new Error('fetch failed');
            return (async function* () {
                yield { name: 'models/gemini-3.5-flash-lite', supportedActions: ['generateContent'] };
                yield { name: 'models/gemini-3.1-flash-lite', supportedActions: ['generateContent'] };
            })();
        },
        stream: async function* (params) {
            if (params.model === 'gemini-3.5-flash-lite') throw { status: 404, message: 'models/gemini-3.5-flash-lite is not found' };
            yield { text: '42' };
        },
    });
    assert.equal((await request()).success, true);
    assert.deepEqual(
        h.requests.map(item => item.model),
        ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']
    );
    assert.equal(h.catalogueRequests.length, 2);
});

test('metadata or text already streamed prevents any model retry in either screenshot mode', async () => {
    for (const testReview of [false, true]) {
        for (const chunk of [{ usageMetadata: { promptTokenCount: 10 } }, { text: 'Partial response' }]) {
            const { h, request } = await setupImageMode(
                {
                    stream: async function* () {
                        yield chunk;
                        throw { status: 404, message: 'models/selected is not found' };
                    },
                },
                testReview
            );
            assert.equal((await request()).success, false);
            assert.equal(h.requests.length, 1);
            assert.equal(h.catalogueRequests.length, 1);
        }
    }
});

test('auth, quota, non-model404 and overloaded503 never cause a second generation', async () => {
    for (const error of [
        { status: 401, message: 'models/selected is not found' },
        { status: 403, message: 'Model permission denied' },
        { status: 429, message: 'Model quota exhausted' },
        { status: 404, message: 'File not found' },
        { status: 503, message: 'The model is unavailable due to overload' },
    ]) {
        const { h, request } = await setupImageMode({
            stream: async function* () {
                throw error;
            },
        });
        assert.equal((await request()).success, false);
        assert.equal(h.requests.length, 1);
        assert.equal(h.catalogueRequests.length, 1);
    }
    const { h, request } = await setupImageMode({ catalogueError: { status: 429, message: 'Quota exhausted' } });
    assert.equal((await request()).code, 'quota');
    assert.equal(h.requests.length, 0);
    const unavailable = await setupImageMode({ catalogue: [{ name: 'models/embedding-001', supportedActions: ['embedContent'] }] });
    const result = await unavailable.request();
    assert.equal(result.code, 'model');
    assert.match(result.error, /compatible model/);
    assert.equal(unavailable.h.requests.length, 0);
});

test('auto model cache is scoped to normalized keys and expires without sending literal auto', async () => {
    const { h, request } = await setupImageMode({});
    h.stored.apiKey = '  fake-key-A  ';
    assert.equal((await request()).success, true);
    assert.equal((await request()).success, true);
    assert.equal(h.catalogueRequests.length, 1);
    assert.equal(h.clients[0].apiKey, 'fake-key-A');
    h.stored.apiKey = 'fake-key-B';
    assert.equal((await request()).success, true);
    assert.equal(h.catalogueRequests.length, 2);
    await h.clock.advance(600001);
    assert.equal((await request()).success, true);
    assert.equal(h.catalogueRequests.length, 3);
    assert.ok(h.requests.every(item => item.model === 'gemini-3.5-flash-lite'));
});

test('closing during model discovery aborts it and cannot submit a late image request', async () => {
    let finish;
    let signal;
    const pending = new Promise(resolve => (finish = resolve));
    const { h, request } = await setupImageMode({
        listModels: params => {
            signal = params.config.abortSignal;
            return pending;
        },
    });
    const result = request();
    await flush();
    await h.invoke('close-session', { silent: true });
    assert.equal(signal.aborted, true);
    finish(
        (async function* () {
            yield { name: 'models/gemini-3.5-flash-lite', supportedActions: ['generateContent'] };
        })()
    );
    assert.equal((await result).code, 'cancelled');
    assert.equal(h.requests.length, 0);
});

test('automatic Live model selection requires bidi capability and never submits literal auto', async () => {
    const h = harness({
        catalogue: [
            { name: 'models/gemini-3.5-flash-lite', supportedActions: ['generateContent'] },
            { name: 'models/gemini-2.5-flash-native-audio-preview-12-2025', supportedActions: ['bidiGenerateContent'] },
        ],
    });
    h.stored.config.geminiLiveModel = 'auto';
    assert.equal(await h.invoke('initialize-gemini', 'unit-test-key'), true);
    assert.equal(h.connections[0].model, 'gemini-2.5-flash-native-audio-preview-12-2025');
    h.api.closeActiveSession();
});

test('backend provider cleanup ends review without restoring hidden main-window controls', () => {
    const visibility = [];
    const h = harness({
        reviewOverlay: {
            isActive: () => true,
            status() {},
            end: (_reason, restoreControls = true) => visibility.push(restoreControls),
        },
    });
    h.api.closeActiveSession();
    assert.deepEqual(visibility, [false]);
});
