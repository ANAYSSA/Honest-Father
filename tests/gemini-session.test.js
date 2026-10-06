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
    reviewOverlay = null,
    catalogue = null,
    catalogueError = null,
    listModels = null,
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
    const catalogueRequests = [];
    const children = [];
    const stored = {
        apiKey: 'unit-test-key',
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
        './prompts': require('../src/utils/prompts'),
        './testReview': require('../src/utils/testReview'),
        '../storage': {
            getAvailableModel: () => stored.config.geminiImageModel || 'gemini-3.1-flash-lite',
            incrementLimitCount: () => {},
            getApiKey: () => stored.apiKey,
            getGroqApiKey: () => stored.groqKey,
            incrementCharUsage: () => {},
            getConfig: () => stored.config,
            getPreferences: () => ({ googleSearchEnabled: false }),
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

test('Groq screenshots receive the same answer-first instruction and custom study context', async () => {
    let body;
    let done = false;
    const h = harness({
        groqKey: 'unit-test-groq',
        fetch: async (url, options) => {
            body = JSON.parse(options.body);
            return {
                ok: true,
                status: 200,
                body: {
                    getReader: () => ({
                        read: async () => {
                            if (done) return { done: true };
                            done = true;
                            return { done: false, value: Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'B. 42' } }] })}\n\n`) };
                        },
                    }),
                },
            };
        },
    });
    const custom = 'Course: algorithms. Show the final answer first.';
    await h.invoke('initialize-screen-session', 'exam', custom);
    const result = await h.invoke('send-image-content', { data: Buffer.alloc(1600).toString('base64'), prompt: 'Answer the practice question.' });
    assert.equal(result.success, true);
    const system = body.messages[0].content;
    assert.equal(body.messages[0].role, 'system');
    assert.match(system, /exam preparation/);
    assert.match(system, /Put the answer or solution first/);
    assert.match(system, /complete runnable implementation/);
    assert.ok(system.includes(custom));
    assert.doesNotMatch(system, /exact words to say|sentences max|No coaching|no explanations/);
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

test('Groq screenshot streams survive JSON split across network chunks', async () => {
    const event = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Correct answer' } }] })}\n\ndata: [DONE]\n\n`;
    const fragments = [event.slice(0, 25), event.slice(25, 46), event.slice(46)];
    const h = harness({
        groqKey: 'unit-test-groq',
        fetch: async () => ({
            ok: true,
            status: 200,
            body: {
                getReader: () => ({ read: async () => (fragments.length ? { value: Buffer.from(fragments.shift()), done: false } : { done: true }) }),
            },
        }),
    });
    await h.invoke('initialize-screen-session');
    const result = await h.invoke('send-image-content', { data: Buffer.alloc(1600).toString('base64'), prompt: 'Solve this.' });
    assert.equal(result.text, 'Correct answer');
    assert.equal(h.events.filter(event => event.channel === 'new-response')[0].data, 'Correct answer');
    assert.equal(h.connections.length, 0);
});

test('closing a Groq screenshot aborts fetch and suppresses late response events', async () => {
    let release;
    let signal;
    let reads = 0;
    const wait = new Promise(resolve => {
        release = resolve;
    });
    const h = harness({
        groqKey: 'unit-test-groq',
        fetch: async (url, options) => {
            signal = options.signal;
            return {
                ok: true,
                status: 200,
                body: {
                    getReader: () => ({
                        read: async () => {
                            if (reads++) return { done: true };
                            await wait;
                            return {
                                done: false,
                                value: Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Old answer' } }] })}\n\n`),
                            };
                        },
                    }),
                },
            };
        },
    });
    await h.invoke('initialize-screen-session');
    const screenshot = h.invoke('send-image-content', { data: Buffer.alloc(1600).toString('base64'), prompt: 'Solve this.' });
    await flush();
    await h.invoke('close-session', { silent: true });
    assert.equal(signal.aborted, true);
    release();
    assert.equal((await screenshot).code, 'cancelled');
    assert.equal(h.events.filter(event => event.channel === 'new-response').length, 0);
    assert.equal(h.events.filter(event => event.channel === 'save-screen-analysis').length, 0);
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
    await startReview(h, manager);
    const result = await h.invoke('send-image-content', reviewPayload());
    assert.equal(result.success, true);
    assert.equal(result.reviewAnswer.answers[0].label, 'B');
    assert.equal(manager.cached.length, 1);
    assert.equal(h.connections.length, 0);
    assert.equal(h.children.length, 0);
    assert.equal(h.requests[0].config.responseMimeType, 'application/json');
    assert.match(h.requests[0].config.systemInstruction, /radio button or checkbox/);
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
