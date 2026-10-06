const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatGPTAuth } = require('../src/utils/chatgptAuth');

const issuer = 'https://auth.openai.com';
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const revokeEndpoint = `${issuer}/api/accounts/oauth/revoke`;
const jwksEndpoint = `${issuer}/.well-known/jwks.json`;
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-signing-key', use: 'sig', alg: 'RS256' };
const encryptionKey = crypto.randomBytes(32);
const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
        const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(value) {
        const cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12));
        cipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString();
    },
};

function idToken(claims, header = {}) {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, ...header })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return `${head}.${body}.${signature}`;
}

function deferred() {
    let resolve;
    const promise = new Promise(done => (resolve = done));
    return { promise, resolve };
}

function harness(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-chatgpt-auth-'));
    const h = {
        directory,
        time: Date.now(),
        calls: [],
        changes: [],
        authorization: null,
        opened: deferred(),
        claims: {},
        scopes: 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct',
        clientId: 'oaiapp_test-client',
        tokenNumber: 0,
        async callback(parameters = {}) {
            const url = new URL(h.authorization.searchParams.get('redirect_uri'));
            url.search = new URLSearchParams({
                state: h.authorization.searchParams.get('state'),
                code: 'one-use-code',
                client_id: h.clientId,
                ...parameters,
            });
            return fetch(url);
        },
        defaultTokens(grant) {
            const result = {
                access_token: `secret-access-${++h.tokenNumber}`,
                refresh_token: `secret-refresh-${h.tokenNumber}`,
                token_type: 'Bearer',
                expires_in: 3600,
                scope: h.scopes,
            };
            if (grant === 'authorization_code') {
                result.id_token = idToken({
                    iss: issuer,
                    aud: h.clientId,
                    sub: 'verified-user-1',
                    email: 'person@example.test',
                    exp: Math.floor(h.time / 1000) + 3600,
                    iat: Math.floor(h.time / 1000),
                    nonce: h.authorization.searchParams.get('nonce'),
                    ...h.claims,
                });
            }
            return result;
        },
    };
    h.fetch = async (url, init = {}) => {
        const body = new URLSearchParams(init.body);
        h.calls.push({ url, init, body });
        if (h.fetchOverride) {
            const override = await h.fetchOverride(url, init, body);
            if (override) return override;
        }
        if (url.endsWith('/.well-known/openid-configuration')) {
            return Response.json({ issuer, jwks_uri: jwksEndpoint, revocation_endpoint: revokeEndpoint });
        }
        if (url === jwksEndpoint) return Response.json({ keys: [jwk] });
        if (url === tokenEndpoint) return Response.json(h.defaultTokens(body.get('grant_type')));
        if (url === revokeEndpoint) return new Response('', { status: 200 });
        throw new Error('Unexpected mocked endpoint');
    };
    h.options = {
        fetch: h.fetch,
        openExternal: async value => {
            h.authorization = new URL(value);
            h.opened.resolve(h.authorization);
        },
        safeStorage,
        userDataPath: directory,
        now: () => h.time,
        onChange: status => h.changes.push(status),
        ...options,
    };
    h.auth = createChatGPTAuth(h.options);
    h.begin = async parameters => {
        h.opened = deferred();
        const completed = h.auth.signIn(parameters);
        completed.catch(() => {});
        await h.opened.promise;
        return { completed, url: h.authorization };
    };
    h.signIn = async parameters => {
        const attempt = await h.begin(parameters);
        const response = await h.callback();
        await response.text();
        return attempt.completed;
    };
    h.readSaved = () => JSON.parse(safeStorage.decryptString(fs.readFileSync(path.join(directory, 'chatgpt-accounts.bin'))));
    t.after(() => {
        h.auth.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return h;
}

test('OAuth uses exact loopback URI, dynamic issued client, PKCE, nonce and encrypted owner-only storage', async t => {
    const h = harness(t);
    const { completed, url } = await h.begin();
    const query = url.searchParams;
    assert.equal(url.origin + url.pathname, `${issuer}/api/accounts/authorize`);
    assert.equal(query.get('client_id'), 'dynamic_agent_client');
    assert.equal(query.get('agent_name_hint'), 'Honest Father');
    assert.match(query.get('ext_agent_host_id'), /^urn:uuid:/);
    assert.match(query.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    assert.equal(query.get('resource'), 'https://api.openai.com/v1');
    assert.equal(query.get('code_challenge_method'), 'S256');
    assert.equal(query.get('prompt'), null);
    assert.equal(h.auth.getStatus().connecting, true);
    assert.equal((await h.callback()).status, 200);
    const status = await completed;
    assert.equal(status.connected, true);
    assert.equal(status.planEnabled, true);
    assert.equal(status.email, 'person@example.test');
    const exchange = h.calls.find(call => call.url === tokenEndpoint);
    assert.equal(exchange.body.get('client_id'), h.clientId);
    assert.equal(exchange.body.get('redirect_uri'), query.get('redirect_uri'));
    assert.equal(exchange.body.get('client_secret'), null);
    assert.equal(crypto.createHash('sha256').update(exchange.body.get('code_verifier')).digest('base64url'), query.get('code_challenge'));
    assert.equal(exchange.init.redirect, 'error');
    const filename = path.join(h.directory, 'chatgpt-accounts.bin');
    const contents = fs.readFileSync(filename);
    for (const secret of ['secret-access', 'secret-refresh', 'verified-user', 'person@example.test']) {
        assert.equal(contents.includes(Buffer.from(secret)), false);
        assert.equal(JSON.stringify(h.changes).includes(secret), secret === 'person@example.test');
    }
    if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.equal(await h.auth.getAccessToken(), 'secret-access-1');
    h.auth.dispose();
    h.auth = createChatGPTAuth(h.options);
    assert.equal(h.auth.getStatus().connected, true);
    assert.equal(await h.auth.getAccessToken(), 'secret-access-1');
    assert.equal(h.readSaved().hostId, query.get('ext_agent_host_id'));
});

test('invalid callback state cannot exchange a code or consume a valid pending authorization', async t => {
    const h = harness(t);
    const { completed } = await h.begin();
    const invalid = await h.callback({ state: 'wrong-state' });
    assert.equal(invalid.status, 400);
    assert.equal(
        h.calls.some(call => call.url === tokenEndpoint),
        false
    );
    assert.equal(h.auth.getStatus().connecting, true);
    await h.callback();
    assert.equal((await completed).connected, true);
});

test('declining consent validates state and ends sign-in without exchanging credentials', async t => {
    const h = harness(t);
    const { completed } = await h.begin();
    await h.callback({ error: 'access_denied' });
    await assert.rejects(completed, { code: 'access_denied' });
    assert.equal(
        h.calls.some(call => call.url === tokenEndpoint),
        false
    );
    assert.equal(h.auth.getStatus().connected, false);
    assert.equal(h.auth.getStatus().connecting, false);
});

for (const [name, claims] of [
    ['issuer', { iss: 'https://attacker.invalid' }],
    ['audience', { aud: 'another-client' }],
    ['nonce', { nonce: 'wrong-nonce' }],
    ['expiry', { exp: 1 }],
    ['authorized party', { aud: ['oaiapp_test-client', 'another-client'], azp: 'another-client' }],
]) {
    test(`ID token with invalid ${name} is rejected before saving credentials`, async t => {
        const h = harness(t);
        h.claims = claims;
        await assert.rejects(h.signIn(), { code: 'invalid_identity' });
        assert.equal(h.auth.getStatus().connected, false);
        assert.equal(h.readSaved().accounts.length, 0);
    });
}

test('signature tampering is rejected even when claims match', async t => {
    const h = harness(t);
    h.fetchOverride = (url, init, body) => {
        if (url !== tokenEndpoint) return;
        const data = h.defaultTokens(body.get('grant_type'));
        const [header, claims, signature] = data.id_token.split('.');
        const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(claims, 'base64url')), sub: 'another-person' })).toString('base64url');
        data.id_token = `${header}.${altered}.${signature}`;
        return Response.json(data);
    };
    await assert.rejects(h.signIn(), { code: 'invalid_identity' });
    assert.equal(h.auth.getStatus().connected, false);
});

test('valid identity without direct permission stays signed in but cannot call inference', async t => {
    const h = harness(t);
    h.scopes = 'openid email profile offline_access';
    const status = await h.signIn();
    assert.equal(status.connected, true);
    assert.equal(status.planEnabled, false);
    await assert.rejects(h.auth.getAccessToken(), { code: 'plan_permission_required' });
    const attempt = await h.begin({ consent: true });
    assert.equal(attempt.url.searchParams.get('prompt'), 'consent');
    assert.equal(attempt.url.searchParams.get('client_id'), h.clientId);
    assert.ok(attempt.url.searchParams.get('id_token_hint'));
    h.scopes += ' chatgpt.tokens.use.direct';
    await h.callback();
    assert.equal((await attempt.completed).planEnabled, true);
});

test('concurrent near-expiry calls share one refresh and atomically persist rotating credentials', async t => {
    const h = harness(t);
    await h.signIn();
    h.time += 3600000;
    const gate = deferred();
    h.fetchOverride = async (url, init, body) => {
        if (body.get('grant_type') === 'refresh_token') await gate.promise;
    };
    const first = h.auth.getAccessToken();
    const second = h.auth.getAccessToken();
    gate.resolve();
    assert.deepEqual(await Promise.all([first, second]), ['secret-access-2', 'secret-access-2']);
    const refresh = h.calls.filter(call => call.body.get('grant_type') === 'refresh_token');
    assert.equal(refresh.length, 1);
    assert.equal(refresh[0].body.get('refresh_token'), 'secret-refresh-1');
    assert.equal(refresh[0].body.get('client_id'), h.clientId);
    assert.equal(refresh[0].body.get('scope'), null);
    assert.equal(h.readSaved().accounts[0].refreshToken, 'secret-refresh-2');
});

test('temporary refresh failure preserves credentials; terminal refresh failure clears tokens but retains registration', async t => {
    const h = harness(t);
    await h.signIn();
    h.time += 3600000;
    h.fetchOverride = (url, init, body) => {
        if (body.get('grant_type') === 'refresh_token') return Response.json({ error: 'server_error' }, { status: 503 });
    };
    await assert.rejects(h.auth.getAccessToken(), { code: 'auth_unavailable' });
    assert.equal(h.auth.getStatus().connected, true);
    assert.equal(h.readSaved().accounts[0].refreshToken, 'secret-refresh-1');
    h.fetchOverride = (url, init, body) => {
        if (body.get('grant_type') === 'refresh_token') return Response.json({ error: 'invalid_grant' }, { status: 400 });
    };
    await assert.rejects(h.auth.getAccessToken(), { code: 'invalid_grant' });
    assert.equal(h.auth.getStatus().connected, false);
    assert.equal(h.readSaved().accounts[0].clientId, h.clientId);
    assert.equal(h.readSaved().accounts[0].refreshToken, undefined);
    assert.equal(h.readSaved().accounts[0].idToken, undefined);
});

test('logout revokes renewable session and returning sign-in reuses registration without a retained token hint', async t => {
    const h = harness(t);
    await h.signIn();
    const initialHost = h.readSaved().hostId;
    const result = await h.auth.signOut();
    assert.equal(result.remoteRevocationConfirmed, true);
    assert.equal(result.connected, false);
    const revoke = h.calls.find(call => call.url === revokeEndpoint);
    assert.equal(revoke.body.get('token'), 'secret-refresh-1');
    assert.equal(revoke.body.get('token_type_hint'), 'refresh_token');
    assert.equal(revoke.body.get('client_id'), h.clientId);
    const attempt = await h.begin();
    assert.equal(attempt.url.searchParams.get('client_id'), h.clientId);
    assert.equal(attempt.url.searchParams.get('ext_agent_host_id'), initialHost);
    assert.equal(attempt.url.searchParams.get('agent_name_hint'), null);
    assert.equal(attempt.url.searchParams.get('id_token_hint'), null);
    await h.callback();
    await attempt.completed;
});

test('logout clears local tokens after bounded remote failure and reports unconfirmed revocation', async t => {
    const h = harness(t);
    await h.signIn();
    h.fetchOverride = url => (url === revokeEndpoint ? Response.json({ error: 'unavailable' }, { status: 503 }) : undefined);
    const result = await h.auth.signOut();
    assert.equal(result.connected, false);
    assert.equal(result.remoteRevocationConfirmed, false);
    assert.match(result.error, /Remote revocation could not be confirmed/);
    assert.equal(h.calls.filter(call => call.url === revokeEndpoint).length, 2);
    assert.equal(h.readSaved().accounts[0].accessToken, undefined);
});

test('refresh completing after logout cannot restore or return revoked credentials', async t => {
    const h = harness(t);
    await h.signIn();
    h.time += 3600000;
    const gate = deferred();
    const started = deferred();
    h.fetchOverride = async (url, init, body) => {
        if (body.get('grant_type') === 'refresh_token') {
            started.resolve();
            await gate.promise;
        }
    };
    const refreshing = h.auth.getAccessToken();
    refreshing.catch(() => {});
    await started.promise;
    await h.auth.signOut();
    gate.resolve();
    await assert.rejects(refreshing, { code: 'cancelled' });
    assert.equal(h.auth.getStatus().connected, false);
    assert.equal(h.readSaved().accounts[0].refreshToken, undefined);
});

test('returning registration rejects a different identity or client without replacing the active account', async t => {
    const h = harness(t);
    await h.signIn();
    h.claims = { sub: 'a-different-user' };
    await assert.rejects(h.signIn(), { code: 'invalid_identity' });
    assert.equal(await h.auth.getAccessToken(), 'secret-access-1');
    h.claims = {};
    const attempt = await h.begin();
    await h.callback({ client_id: 'oaiapp_wrong-client' });
    await assert.rejects(attempt.completed, { code: 'invalid_callback' });
    assert.equal(await h.auth.getAccessToken(), 'secret-access-1');
});

test('new-account login keeps separate registration and failed attempts preserve the active account', async t => {
    const h = harness(t);
    await h.signIn();
    h.clientId = 'oaiapp_second-client';
    h.claims = { sub: 'verified-user-2' };
    const attempt = await h.begin({ newAccount: true });
    assert.equal(attempt.url.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(attempt.url.searchParams.get('id_token_hint'), null);
    assert.equal(await h.auth.getAccessToken(), 'secret-access-1');
    await h.callback();
    await attempt.completed;
    assert.equal(h.auth.getStatus().accounts.length, 2);
    assert.equal(h.auth.getStatus().activeAccountId, h.clientId);
    assert.equal(h.readSaved().accounts[0].accessToken, 'secret-access-1');
});

test('invalid authorization grant retains the issued client for a fresh attempt', async t => {
    const h = harness(t);
    h.fetchOverride = url => (url === tokenEndpoint ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : undefined);
    await assert.rejects(h.signIn(), { code: 'invalid_grant' });
    assert.equal(h.readSaved().pendingClientId, h.clientId);
    h.fetchOverride = null;
    const attempt = await h.begin();
    assert.equal(attempt.url.searchParams.get('client_id'), h.clientId);
    assert.equal(attempt.url.searchParams.get('agent_name_hint'), null);
    await h.callback();
    await attempt.completed;
    assert.equal(h.readSaved().pendingClientId, undefined);
});

test('unsafe identity discovery cannot redirect JWKS or revocation requests off the OpenAI origin', async t => {
    const h = harness(t);
    h.fetchOverride = url => {
        if (url.endsWith('/.well-known/openid-configuration')) {
            return Response.json({ issuer, jwks_uri: 'https://attacker.invalid/keys', revocation_endpoint: revokeEndpoint });
        }
    };
    await assert.rejects(h.signIn(), { code: 'invalid_identity' });
    assert.equal(
        h.calls.some(call => call.url.includes('attacker')),
        false
    );
});

test('secure storage unavailability never falls back to plaintext credentials', async t => {
    const h = harness(t, { safeStorage: { isEncryptionAvailable: () => false } });
    await assert.rejects(h.auth.signIn(), { code: 'secure_storage_unavailable' });
    assert.equal(h.authorization, null);
    assert.deepEqual(fs.readdirSync(h.directory), []);
});

test('authorization timeout and dispose close the callback server and stop pending authentication', async t => {
    const h = harness(t, { authorizationTimeoutMs: 30 });
    const attempt = await h.begin();
    await assert.rejects(attempt.completed, { code: 'sign_in_timeout' });
    assert.equal(h.auth.getStatus().connecting, false);
    await assert.rejects(h.callback());
    const second = await h.begin();
    h.auth.dispose();
    await assert.rejects(second.completed, { code: 'cancelled' });
    await assert.rejects(h.auth.getAccessToken(), { code: 'cancelled' });
});
