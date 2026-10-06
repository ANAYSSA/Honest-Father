const test = require('node:test');
const assert = require('node:assert/strict');
const {
    classifyGoogleError,
    googleErrorDiagnostics,
    createReconnectController,
    createRequestGate,
    createPcmActivityFilter,
    buildSessionContext,
    createSseLineBuffer,
} = require('../src/utils/geminiReliability');

test('transport diagnostics retain safe classes and codes without credential-bearing messages', () => {
    assert.deepEqual(
        googleErrorDiagnostics({
            name: 'TypeError',
            status: 503,
            message: 'secret-key https://private.test',
            cause: { code: 'ECONNRESET', message: 'secret-key', cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } },
        }),
        { errorClass: 'TypeError', status: 503, networkCodes: ['ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'] }
    );
    assert.deepEqual(googleErrorDiagnostics({ name: 'secret-key', code: 'secret-key', status: 'secret-key' }), {});
});

function fakeClock() {
    let now = 0;
    let nextId = 0;
    const pending = new Map();
    return {
        now: () => now,
        setTimeout(callback, delay) {
            const id = ++nextId;
            pending.set(id, { at: now + delay, callback });
            return id;
        },
        clearTimeout(id) {
            pending.delete(id);
        },
        async advance(milliseconds) {
            const target = now + milliseconds;
            while (true) {
                const due = [...pending].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                pending.delete(due[0]);
                now = due[1].at;
                await due[1].callback();
            }
            now = target;
        },
        get pendingCount() {
            return pending.size;
        },
    };
}

test('authentication, quota, invalid model and policy failures never retry automatically', () => {
    for (const error of [
        { status: 403, message: 'PERMISSION_DENIED' },
        { code: 1008, reason: 'API key reported as leaked' },
        { message: '{"error":{"code":429,"message":"RESOURCE_EXHAUSTED. Retry in 120s"}}' },
        { status: 404, message: 'model not found' },
        { code: 1007, reason: 'Invalid argument' },
    ]) {
        assert.equal(classifyGoogleError(error).retryable, false);
    }
    assert.equal(classifyGoogleError({ status: 429, message: 'Retry in 120s' }).cooldownMs, 120000);
    assert.equal(classifyGoogleError({ status: 429, message: 'Quota exceeded per day' }).cooldownMs, 900000);
    assert.equal(classifyGoogleError({ code: 1011 }).retryable, true);
    assert.equal(classifyGoogleError(new Error('fetch failed')).retryable, true);
});

test('duplicate close/error callbacks create one bounded exponential reconnect sequence', async () => {
    const clock = fakeClock();
    const retries = [];
    const stops = [];
    let connects = 0;
    const controller = createReconnectController({
        timers: clock,
        random: () => 0,
        reconnect: async () => {
            connects++;
            return { code: 1006 };
        },
        onRetry: (attempt, delay) => retries.push([attempt, delay]),
        onStopped: failure => stops.push(failure),
    });
    controller.request({ code: 1006 });
    controller.request({ code: 1011 });
    assert.equal(clock.pendingCount, 1);
    await clock.advance(10000);
    assert.equal(connects, 3);
    assert.deepEqual(retries, [
        [1, 1000],
        [2, 2000],
        [3, 4000],
    ]);
    assert.equal(stops.length, 1);
    assert.equal(clock.pendingCount, 0);
});

test('quit cancels a delayed retry and a reconnect completing after cancellation', async () => {
    const clock = fakeClock();
    let connects = 0;
    let resolveConnection;
    const controller = createReconnectController({
        timers: clock,
        random: () => 0,
        reconnect: () => {
            connects++;
            return new Promise(resolve => {
                resolveConnection = resolve;
            });
        },
    });
    controller.request({ code: 1006 });
    controller.cancel();
    await clock.advance(2000);
    assert.equal(connects, 0);
    controller.reset();
    controller.request({ code: 1006 });
    const advancing = clock.advance(1000);
    await Promise.resolve();
    controller.cancel();
    resolveConnection(true);
    await advancing;
    assert.equal(connects, 1);
    assert.equal(clock.pendingCount, 0);
});

test('successful reconnect only resets its failure budget after a stable connection', async () => {
    const clock = fakeClock();
    const retries = [];
    const controller = createReconnectController({
        timers: clock,
        random: () => 0,
        reconnect: async () => true,
        onRetry: (attempt, delay) => retries.push([attempt, delay]),
    });
    controller.request({ code: 1006 });
    await clock.advance(1000);
    controller.request({ code: 1006 });
    await clock.advance(2000);
    assert.equal(retries[1][0], 2);
    await clock.advance(30000);
    controller.request({ code: 1006 });
    assert.equal(retries[2][0], 1);
    controller.cancel();
});

test('quota response cancels an already scheduled network retry', async () => {
    const clock = fakeClock();
    const stops = [];
    let connects = 0;
    const controller = createReconnectController({
        timers: clock,
        reconnect: async () => {
            connects++;
            return true;
        },
        onStopped: failure => stops.push(failure),
    });
    controller.request({ code: 1006 });
    controller.request({ code: 1008, reason: 'Quota exceeded' });
    await clock.advance(10000);
    assert.equal(connects, 0);
    assert.equal(stops[0].code, 'quota');
});

test('screen requests cannot overlap and provider cooldown is scoped to configured model and key', () => {
    const clock = fakeClock();
    const gate = createRequestGate({ now: clock.now });
    assert.equal(gate.begin('model:key-a'), null);
    assert.equal(gate.begin('model:key-a').code, 'busy');
    gate.finish({ status: 429, message: 'Quota reached' });
    assert.equal(gate.begin('model:key-a').retryAfterMs, 60000);
    assert.equal(gate.begin('model:key-b'), null);
    gate.finish({ status: 403 });
    assert.equal(gate.begin('model:key-b').code, 'authentication');
    assert.equal(gate.begin('model:key-b').retryAfterMs, null);
});

test('quiet PCM frames are skipped while a speech tail and one stream-end signal are preserved', async () => {
    const clock = fakeClock();
    const filter = createPcmActivityFilter({ now: clock.now });
    const silence = Buffer.alloc(200);
    const speech = Buffer.alloc(200);
    for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(500, i);
    assert.deepEqual(filter.inspect(silence), { send: false, ended: false });
    assert.deepEqual(filter.inspect(speech), { send: true, ended: false });
    await clock.advance(800);
    assert.equal(filter.inspect(silence).send, true);
    await clock.advance(101);
    assert.deepEqual(filter.inspect(silence), { send: false, ended: true });
    assert.deepEqual(filter.inspect(silence), { send: false, ended: false });
    filter.reset();
    assert.equal(filter.isOpen, false);
});

test('fallback session context retains recent valid turns within a fixed character budget', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ transcription: `question-${i}`, ai_response: 'answer'.repeat(1000) }));
    history.push({ transcription: 'unfinished', ai_response: '' });
    const context = buildSessionContext(history);
    assert.ok(context.length <= 8000);
    assert.match(context, /question-19/);
    assert.doesNotMatch(context, /question-0|unfinished/);
    assert.equal(buildSessionContext([]), null);
});

test('SSE JSON lines split across network chunks are buffered and a trailing line is flushed', () => {
    const parse = createSseLineBuffer();
    assert.deepEqual(parse('data: {"ans'), []);
    assert.deepEqual(parse('wer":"42"}\r\n\ndata: [DO'), ['data: {"answer":"42"}', '']);
    assert.deepEqual(parse('NE]', true), ['data: [DONE]']);
});
