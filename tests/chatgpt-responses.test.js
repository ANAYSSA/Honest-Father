const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatGPTResponses, selectDefaultModel } = require('../src/utils/chatgptResponses');

const row = (slug, display_name = slug, extra = {}) => ({ slug, display_name, visibility: 'list', ...extra });
const rows = [row('gpt-6-astra', 'GPT-6 Astra'), row('gpt-5.6-luna', 'GPT-5.6 Luna'), row('gpt-6.1-sol', 'GPT-6.1 Sol')];
const catalog = (models = rows) => new Response(JSON.stringify({ models }), { headers: { 'Content-Type': 'application/json' } });
const event = (type, data = {}) => `data: ${JSON.stringify({ type, ...data })}\n\n`;
const completed = (text = 'Answer') =>
    event('response.completed', { response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } });
const sse = (...chunks) => {
    let i = 0;
    return new Response(
        new ReadableStream({
            pull(controller) {
                if (i === chunks.length) controller.close();
                else controller.enqueue(typeof chunks[i] === 'string' ? new TextEncoder().encode(chunks[i++]) : chunks[i++]);
            },
        }),
        { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_stream' } }
    );
};
function service({ responses = [sse(completed())], models = rows, ...options } = {}) {
    const calls = [];
    const client = createChatGPTResponses({
        fetch: async (url, init) => {
            calls.push({ url, ...init });
            if (url.endsWith('/models')) return catalog(models);
            const response = responses.shift();
            if (response instanceof Error) throw response;
            if (typeof response === 'function') return response(init);
            assert.ok(response, 'Unexpected extra inference request');
            return response;
        },
        getAccessToken: async () => 'fake-oauth-token',
        retryDelayMs: 1,
        ...options,
    });
    return { ...client, calls };
}

test('catalog preserves account order, excludes hidden/malformed/duplicate entries and resolves documented capabilities', async () => {
    const client = service({
        models: [
            rows[0],
            row('hidden', 'Hidden', { visibility: 'hide' }),
            row('gpt-5.6-luna', 'GPT-5.6 Luna'),
            row('gpt-6.1-sol', 'GPT-6.1 Sol'),
            row('gpt-6.1-sol', 'Duplicate'),
            row('future-unknown', 'Future'),
            row('account-model', 'Account model', { supported_reasoning_modes: ['standard'], supported_reasoning_levels: [{ effort: 'low' }] }),
            row('bad slug', 'Bad'),
        ],
    });
    const models = await client.listModels();
    assert.deepEqual(
        models.map(model => model.id),
        ['gpt-6-astra', 'gpt-5.6-luna', 'gpt-6.1-sol', 'future-unknown', 'account-model']
    );
    assert.deepEqual(
        models.map(model => model.fastReasoningEffort),
        ['low', 'none', 'low', null, 'low']
    );
    assert.deepEqual(
        models.map(model => model.supportsPro),
        [true, true, true, false, false]
    );
    assert.equal(selectDefaultModel(models), 'gpt-5.6-luna');
    assert.equal(selectDefaultModel([{ id: 'actual-account-5.6-instant', name: 'GPT-5.6 Instant' }, ...models]), 'actual-account-5.6-instant');
    assert.equal(selectDefaultModel([models[0], { id: 'actual-instant', name: 'GPT Instant' }]), 'actual-instant');
    assert.equal(selectDefaultModel([models[0]]), 'gpt-6-astra');
    assert.equal(selectDefaultModel([]), '');
});

test('model requests share one in-flight request, cache isolated copies, and refresh on force/expiry/invalidation', async () => {
    let now = 0;
    const client = service({ now: () => now });
    const [a, b] = await Promise.all([client.listModels(), client.listModels()]);
    assert.equal(client.calls.length, 1);
    a[0].name = 'Mutated';
    assert.equal(b[0].name, 'GPT-6 Astra');
    assert.equal((await client.listModels())[0].name, 'GPT-6 Astra');
    await client.listModels({ force: true });
    assert.equal(client.calls.length, 2);
    now = 300001;
    await client.listModels();
    assert.equal(client.calls.length, 3);
    client.invalidateModels();
    await client.listModels();
    assert.equal(client.calls.length, 4);
});

test('auth failure preserves the original error and a subsequent model fetch can recover', async () => {
    let first = true;
    const denied = new Error('Account is disconnected');
    const client = service({
        getAccessToken: () => {
            if (first) {
                first = false;
                throw denied;
            }
            return 'fresh-token';
        },
    });
    await assert.rejects(client.listModels(), error => error === denied);
    assert.equal((await client.listModels()).length, 3);
});

test('account invalidation cancels an old catalog even when a transport does not obey abort', async () => {
    let resolveOld;
    let calls = 0;
    const client = service({
        fetch: async () =>
            ++calls === 1
                ? new Promise(resolve => {
                      resolveOld = resolve;
                  })
                : catalog([row('new-account-model')]),
    });
    const old = client.listModels();
    const rejection = assert.rejects(old, { name: 'AbortError' });
    await new Promise(resolve => setImmediate(resolve));
    client.invalidateModels();
    await rejection;
    const models = await client.listModels();
    resolveOld(catalog());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(models[0].id, 'new-account-model');
    assert.equal((await client.listModels())[0].id, 'new-account-model');
});

test('requests use public OAuth Responses with supported fields, concise context and one current screenshot', async () => {
    const client = service();
    const history = Array.from({ length: 20 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: 'x'.repeat(7000) }));
    history.push(
        { role: 'system', content: 'must not be replayed' },
        { role: 'user', content: [{ type: 'input_image', image_url: 'private old screenshot' }] }
    );
    const answer = await client.respond({ model: 'gpt-5.6-luna', prompt: ' Read this ', imageBase64: 'YWJj', history, instructions: ' Be brief. ' });
    assert.equal(answer, 'Answer');
    const request = client.calls.at(-1);
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.equal(request.headers.Authorization, 'Bearer fake-oauth-token');
    assert.equal(request.redirect, 'error');
    const body = JSON.parse(request.body);
    assert.deepEqual(Object.keys(body).sort(), ['model', 'input', 'store', 'stream', 'instructions', 'reasoning'].sort());
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.deepEqual(body.reasoning, { effort: 'none' });
    assert.equal(body.instructions, 'Be brief.');
    assert.ok(body.input.slice(0, -1).reduce((sum, item) => sum + item.content.length, 0) <= 24000);
    assert.ok(body.input.every(item => ['assistant', 'user'].includes(item.role)));
    assert.deepEqual(body.input.at(-1).content, [
        { type: 'input_text', text: 'Read this' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,YWJj' },
    ]);
    assert.ok(!request.body.includes('private old screenshot'));
});

test('Pro keeps account model ID and uses documented reasoning mode; unknown models never get invented capabilities', async () => {
    const client = service({ responses: [sse(completed()), sse(completed())] });
    await client.respond({ model: 'gpt-6-astra', reasoningMode: 'pro', prompt: 'Analyze' });
    assert.deepEqual(JSON.parse(client.calls.at(-1).body).reasoning, { mode: 'pro' });
    assert.equal(JSON.parse(client.calls.at(-1).body).model, 'gpt-6-astra');
    await assert.rejects(client.respond({ model: 'fake-pro', prompt: 'Test' }), error => error.code === 'model_unavailable');
    const unknown = service({ models: [row('new-account-model')] });
    await assert.rejects(
        unknown.respond({ model: 'new-account-model', reasoningMode: 'pro', prompt: 'Test' }),
        error => error.code === 'unsupported_pro'
    );
    await unknown.respond({ model: 'new-account-model', prompt: 'Test' });
    assert.equal(JSON.parse(unknown.calls.at(-1).body).reasoning, undefined);
});

test('stream decoder handles fragmented UTF-8, CRLF, comments, multiline data and cumulative text', async () => {
    const stream =
        ': comment\r\n\r\nevent: response.output_text.delta\r\ndata: {"delta":\r\ndata: "Привет 🌎"}\r\n\r\n' +
        event('response.output_text.delta', { delta: '!' }) +
        completed('Привет 🌎!');
    const bytes = new TextEncoder().encode(stream);
    const chunks = Array.from(bytes, value => Uint8Array.of(value));
    const client = service({ responses: [sse(...chunks)] });
    const updates = [];
    assert.equal(await client.respond({ prompt: 'Hello', onText: text => updates.push(text) }), 'Привет 🌎!');
    assert.deepEqual(updates, ['Привет 🌎', 'Привет 🌎!', 'Привет 🌎!']);
});

test('a completed response can supply the final answer without delta events and accepts a terminal event without final newline', async () => {
    const client = service({ responses: [sse(completed('Final only').trimEnd())] });
    assert.equal(await client.respond({ prompt: 'Hello' }), 'Final only');
});

test('partial content is not success without response.completed, including DONE sentinel', async () => {
    for (const tail of ['', 'data: [DONE]\n\n']) {
        const client = service({ responses: [sse(event('response.output_text.delta', { delta: 'Partial' }), tail)] });
        const updates = [];
        await assert.rejects(client.respond({ prompt: 'Hello', onText: text => updates.push(text) }), error => error.code === 'interrupted_stream');
        assert.deepEqual(updates, ['Partial']);
        assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
    }
});

test('usage failure after streaming preserves code, request ID, recovery link and never repeats billed request', async () => {
    const client = service({
        responses: [
            sse(
                event('response.output_text.delta', { delta: 'Partial' }),
                event('response.failed', { response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Limit' } } })
            ),
        ],
    });
    await assert.rejects(client.respond({ prompt: 'Hello' }), error => {
        assert.equal(error.code, 'subscription_sharing_usage_limit_exceeded');
        assert.equal(error.requestId, 'req_stream');
        assert.equal(error.usageUrl, 'https://chatgpt.com/settings/usage');
        return true;
    });
    assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
});

test('incomplete, malformed, empty and explicit error events are distinct failures', async () => {
    for (const [chunk, code] of [
        [event('response.incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' } } }), 'response_incomplete'],
        ['data: not JSON\n\n', 'invalid_stream'],
        [completed(''), 'empty_response'],
        [
            event('error', { code: 'subscription_sharing_unsupported_capability', param: 'reasoning.mode', message: 'Unsupported' }),
            'subscription_sharing_unsupported_capability',
        ],
    ]) {
        const client = service({ responses: [sse(chunk)] });
        await assert.rejects(client.respond({ prompt: 'Hello' }), error => error.code === code);
    }
});

test('one pre-stream 503 retry is bounded and retains credentials; other errors never automatically retry', async () => {
    const temporary = () =>
        new Response(JSON.stringify({ detail: 'Temporarily unavailable' }), { status: 503, headers: { 'x-request-id': 'req_503' } });
    const client = service({ responses: [temporary(), sse(completed('Recovered'))] });
    assert.equal(await client.respond({ prompt: 'Hi' }), 'Recovered');
    assert.equal(client.calls.filter(call => call.method === 'POST').length, 2);
    const twice = service({ responses: [temporary(), temporary()] });
    await assert.rejects(
        twice.respond({ prompt: 'Hi' }),
        error => error.status === 503 && error.bodyShape === 'detail' && error.requestId === 'req_503'
    );
    for (const status of [400, 401, 403, 429, 500]) {
        const failed = service({
            responses: [new Response(JSON.stringify({ error: { code: 'test_failure', param: 'model', message: 'Diagnostic' } }), { status })],
        });
        await assert.rejects(
            failed.respond({ prompt: 'Hi' }),
            error => error.status === status && error.code === 'test_failure' && error.param === 'model'
        );
        assert.equal(failed.calls.filter(call => call.method === 'POST').length, 1);
    }
});

test('raw network failures do not replay potentially billed requests and provider diagnostics redact credentials', async () => {
    const client = service({ responses: [new Error('socket failed with fake-oauth-token')] });
    await assert.rejects(client.respond({ prompt: 'Hi' }), error => error.code === 'network_error' && !error.message.includes('fake-oauth-token'));
    assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
    const unsafe = service({
        responses: [new Response(JSON.stringify({ detail: 'fake-oauth-token Bearer secret-value ' + 'x'.repeat(1000) }), { status: 403 })],
    });
    await assert.rejects(unsafe.respond({ prompt: 'Hi' }), error => {
        assert.ok(!error.diagnostic.includes('fake-oauth-token'));
        assert.ok(!error.diagnostic.includes('secret-value'));
        assert.ok(error.diagnostic.length <= 500);
        return true;
    });
});

test('safe authentication failures remain actionable instead of turning into network failures', async () => {
    for (const code of ['sign_in_required', 'plan_permission_required', 'invalid_grant', 'secure_storage_unavailable']) {
        const client = service({
            getAccessToken() {
                throw Object.assign(new Error('Continue with ChatGPT before starting.'), { code });
            },
        });
        await assert.rejects(
            client.respond({ prompt: 'Hi' }),
            error => error.code === code && error.message === 'Continue with ChatGPT before starting.'
        );
    }
});

test('cancel and timeout stop stalled transports and do not retry', async () => {
    const controller = new AbortController();
    const client = service({ responses: [() => new Promise(() => {})] });
    const pending = client.respond({ prompt: 'Hi', signal: controller.signal });
    const cancelled = assert.rejects(pending, { name: 'AbortError' });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await cancelled;
    const timed = service({ requestTimeoutMs: 10, responses: [() => new Promise(() => {})] });
    await assert.rejects(timed.respond({ prompt: 'Hi' }), error => error.code === 'timeout');
    assert.equal(timed.calls.filter(call => call.method === 'POST').length, 1);
});

test('cancelled stream reader is released; signout cancels in-flight inference', async () => {
    let cancelled = false;
    const hanging = new Response(
        new ReadableStream({
            cancel() {
                cancelled = true;
            },
        })
    );
    const client = service({ responses: [hanging] });
    const pending = client.respond({ prompt: 'Hi' });
    const stopped = assert.rejects(pending, { name: 'AbortError' });
    await new Promise(resolve => setImmediate(resolve));
    client.invalidateModels();
    await stopped;
    assert.equal(cancelled, true);
    assert.equal(hanging.body.locked, false);
});

test('invalid inputs never make requests and an empty or malformed account catalog is actionable', async () => {
    const client = service();
    for (const input of [
        { prompt: '' },
        { prompt: 'Hi', imageBase64: 'not base64!' },
        { prompt: 'Hi', imageBase64: 'YWJj', mimeType: 'text/html' },
        { prompt: 'Hi', reasoningMode: 'invented' },
    ]) {
        await assert.rejects(client.respond(input));
    }
    assert.equal(client.calls.length, 0);
    await assert.rejects(service({ models: [] }).listModels(), error => error.code === 'no_models');
    await assert.rejects(service({ fetch: async () => new Response('{"data":[]}') }).listModels(), error => error.code === 'invalid_catalog');
});
