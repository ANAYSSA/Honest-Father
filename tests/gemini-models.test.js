const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseModel, createGeminiModelResolver } = require('../src/utils/geminiModels');
const { classifyGoogleError } = require('../src/utils/geminiReliability');

const model = (name, action = 'generateContent') => ({ name: `models/${name}`, supportedActions: [action] });
const catalogue = [
    model('gemini-3.8-live', 'bidiGenerateContent'),
    model('gemini-3.8-flash'),
    model('gemini-3.5-flash-lite'),
    model('gemini-3.1-flash-lite'),
];
function clientFor(rows = catalogue) {
    const calls = [];
    return {
        calls,
        models: {
            async list(options) {
                calls.push(options);
                return (async function* () {
                    yield* rows;
                })();
            },
        },
    };
}

test('automatic image/review selection chooses available low-cost vision generation, excluding specialized models', () => {
    const rows = [
        model('gemini-3.8-flash-tts'),
        model('gemini-3.1-flash-image'),
        model('embedding-001', 'embedContent'),
        model('gemini-3.8-live', 'bidiGenerateContent'),
        ...catalogue,
    ];
    assert.equal(chooseModel(rows, { selected: 'auto' }), 'gemini-3.5-flash-lite');
    assert.equal(chooseModel(rows, { selected: '', kind: 'review' }), 'gemini-3.5-flash-lite');
    assert.equal(chooseModel(rows, { selected: 'AUTO', kind: 'live' }), 'gemini-3.8-live');
    assert.equal(chooseModel(rows, { selected: 'gemini-3.8-live' }), 'gemini-3.5-flash-lite');
    assert.equal(chooseModel(rows, { selected: 'gemini-3.1-flash-image' }), 'gemini-3.5-flash-lite');
});

test('valid custom/legacy models and aliases are preserved; absent legacy defaults migrate automatically', () => {
    assert.equal(chooseModel(catalogue, { selected: ' models/gemini-3.1-flash-lite ' }), 'gemini-3.1-flash-lite');
    assert.equal(chooseModel(catalogue, { selected: 'my-custom-alias' }), 'my-custom-alias');
    assert.equal(chooseModel(catalogue, { selected: 'gemini-2.0-flash' }), 'gemini-3.5-flash-lite');
    assert.equal(chooseModel([{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }]), 'gemini-2.5-flash');
    assert.throws(() => chooseModel([model('embedding-001', 'embedContent')]), /No compatible Gemini model/);
});

test('catalogue requests are single-flight, cached per key and refreshed after expiry', async () => {
    let now = 0;
    const resolver = createGeminiModelResolver({ now: () => now, ttlMs: 100 });
    const client = clientFor();
    const common = { apiKey: 'fake-key-A', client, selected: 'auto' };
    const [image, live] = await Promise.all([resolver.resolve(common), resolver.resolve({ ...common, kind: 'live' })]);
    assert.equal(image, 'gemini-3.5-flash-lite');
    assert.equal(live, 'gemini-3.8-live');
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].config.pageSize, 1000);
    assert.equal(client.calls[0].config.httpOptions.timeout, 8000);
    assert.equal(client.calls[0].config.httpOptions.retryOptions.attempts, 1);
    await resolver.resolve(common);
    assert.equal(client.calls.length, 1);
    await resolver.resolve({ ...common, apiKey: 'fake-key-B' });
    assert.equal(client.calls.length, 2);
    now = 101;
    await resolver.resolve(common);
    assert.equal(client.calls.length, 3);
});

test('explicit exclusion survives discovery failure then refreshed fallback catalogue', async () => {
    const resolver = createGeminiModelResolver();
    let calls = 0;
    const client = {
        models: {
            async list() {
                if (++calls === 1) throw new Error('fetch failed');
                return (async function* () {
                    yield* catalogue;
                })();
            },
        },
    };
    const options = { apiKey: 'fake-key', client, selected: 'gemini-3.5-flash-lite' };
    assert.equal(await resolver.resolve(options), 'gemini-3.5-flash-lite');
    assert.equal(await resolver.resolve({ ...options, fallback: true, exclude: ['gemini-3.5-flash-lite'] }), 'gemini-3.1-flash-lite');
    assert.equal(calls, 2);
});

test('successful aliases are remembered, and review rejection cannot invalidate a valid normal image model', async () => {
    const resolver = createGeminiModelResolver();
    const client = clientFor();
    const options = { apiKey: 'fake-key', client, selected: 'my-custom-alias' };
    assert.equal(await resolver.resolve(options), 'my-custom-alias');
    resolver.remember(options.apiKey, options.selected, 'gemini-3.8-flash');
    assert.equal(await resolver.resolve(options), 'gemini-3.8-flash');
    resolver.reject(options.apiKey, 'gemini-3.8-flash', 'review');
    assert.equal(await resolver.resolve(options), 'gemini-3.8-flash');
});

test('auth/quota catalogue failures remain terminal; generic404 and503 are never model mismatches', async () => {
    for (const status of [401, 403, 429]) {
        const failure = { status, message: 'models/example is not found' };
        const resolver = createGeminiModelResolver();
        await assert.rejects(
            resolver.resolve({
                apiKey: 'fake',
                client: {
                    models: {
                        list: async () => {
                            throw failure;
                        },
                    },
                },
            }),
            error => error === failure
        );
        assert.notEqual(classifyGoogleError(failure).code, 'model');
    }
    assert.equal(classifyGoogleError({ status: 400, message: 'API key not found' }).code, 'authentication');
    assert.equal(classifyGoogleError({ status: 404, message: 'File not found' }).code, 'unknown');
    assert.equal(classifyGoogleError({ status: 503, message: 'Model unavailable due to server overload' }).code, 'network');
    assert.equal(classifyGoogleError({ status: 404, message: 'Selected model is unavailable' }).code, 'model');
    assert.equal(classifyGoogleError({ status: 404, message: 'models/example is not found for this API key' }).code, 'model');
});
