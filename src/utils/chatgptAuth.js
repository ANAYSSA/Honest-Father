const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// Official public-client flow:
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
// https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const AUTH_ERROR = Symbol('chatgpt-auth-error');
const TERMINAL_REFRESH = new Set([
    'invalid_grant',
    'invalid_refresh_token',
    'token_expired',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused',
]);

function authError(message, code = 'chatgpt_auth_error') {
    const error = new Error(message);
    error.code = code;
    error[AUTH_ERROR] = true;
    return error;
}

function validClientId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,255}$/.test(value) && value !== 'dynamic_agent_client';
}

function equalSecret(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const first = Buffer.from(a);
    const second = Buffer.from(b);
    return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function safeAuthEndpoint(value) {
    try {
        const url = new URL(value);
        return url.origin === ISSUER && !url.username && !url.password && !url.hash ? url.href : null;
    } catch {
        return null;
    }
}

// The Electron main process is the sole owner of this service. The app also takes
// Electron's single-instance lock to avoid racing rotating refresh tokens.
function createChatGPTAuth({
    fetch,
    openExternal,
    safeStorage,
    userDataPath,
    onChange = () => {},
    now = Date.now,
    authorizationTimeoutMs = 5 * 60 * 1000,
    requestTimeoutMs = 15000,
}) {
    if (typeof fetch !== 'function' || typeof openExternal !== 'function' || !userDataPath) {
        throw new TypeError('ChatGPT authentication requires fetch, openExternal, and userDataPath.');
    }
    const credentialPath = path.join(userDataPath, 'chatgpt-accounts.bin');
    let saved = { version: 1, hostId: `urn:uuid:${crypto.randomUUID()}`, activeAccountId: null, accounts: [] };
    let storageError = null;
    let lastError = null;
    let pending = null;
    let starting = false;
    let signingOut = false;
    let signOutPromise = null;
    let disposed = false;
    let generation = 0;
    let refreshPromise = null;
    let writePromise = Promise.resolve();
    let discoveryCache = null;
    let keysCache = null;
    const requests = new Set();

    function checkStorage() {
        if (!safeStorage?.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')) {
            throw authError(
                'Secure system credential storage is unavailable. Unlock your system keychain and try again.',
                'secure_storage_unavailable'
            );
        }
        if (storageError) throw authError(storageError, 'secure_storage_unavailable');
    }

    try {
        if (fs.existsSync(credentialPath)) {
            checkStorage();
            const stat = fs.lstatSync(credentialPath);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid credential file');
            const parsed = JSON.parse(safeStorage.decryptString(fs.readFileSync(credentialPath)));
            if (
                parsed.version !== 1 ||
                !/^urn:uuid:[a-f0-9-]{36}$/i.test(parsed.hostId) ||
                !Array.isArray(parsed.accounts) ||
                parsed.accounts.some(
                    account =>
                        !validClientId(account.clientId) ||
                        typeof account.subject !== 'string' ||
                        account.issuer !== ISSUER ||
                        !Array.isArray(account.scopes)
                )
            ) {
                throw new Error('Invalid credential record');
            }
            saved = parsed;
            if (process.platform !== 'win32') fs.chmodSync(credentialPath, 0o600);
        }
    } catch {
        storageError = 'Saved ChatGPT credentials could not be unlocked. Unlock your system keychain and restart Honest Father.';
        lastError = storageError;
    }

    function activeAccount() {
        return saved.accounts.find(account => account.clientId === saved.activeAccountId);
    }

    function getStatus() {
        const account = activeAccount();
        return {
            connected: Boolean(account?.accessToken && !signingOut),
            planEnabled: Boolean(account?.accessToken && !signingOut && account.scopes.includes(PLAN_SCOPE)),
            email: account?.email || '',
            connecting: Boolean(pending || starting),
            error: lastError,
            activeAccountId: saved.activeAccountId,
            accounts: saved.accounts.map(item => ({
                id: item.clientId,
                email: item.email || '',
                connected: Boolean(item.accessToken && !signingOut),
            })),
        };
    }

    function notify() {
        try {
            onChange(getStatus());
        } catch {
            // A detached renderer must not affect credential lifetime.
        }
    }

    function ensureActive() {
        if (disposed) throw authError('ChatGPT connection has been closed.', 'cancelled');
    }

    function persist() {
        checkStorage();
        const encrypted = safeStorage.encryptString(JSON.stringify(saved));
        const next = writePromise
            .catch(() => {})
            .then(async () => {
                await fs.promises.mkdir(userDataPath, { recursive: true, mode: 0o700 });
                const temp = `${credentialPath}.${crypto.randomUUID()}.tmp`;
                try {
                    await fs.promises.writeFile(temp, encrypted, { mode: 0o600, flag: 'wx' });
                    await fs.promises.rename(temp, credentialPath);
                    if (process.platform !== 'win32') await fs.promises.chmod(credentialPath, 0o600);
                } finally {
                    await fs.promises.unlink(temp).catch(() => {});
                }
            });
        writePromise = next;
        return next;
    }

    async function request(url, options = {}, attemptSignal) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        requests.add(controller);
        const abort = () => controller.abort();
        attemptSignal?.addEventListener('abort', abort, { once: true });
        if (attemptSignal?.aborted || disposed) controller.abort();
        try {
            const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
            const text = await response.text();
            if (text.length > 256 * 1024) throw authError('ChatGPT authentication returned an invalid response.');
            let data = {};
            if (text) {
                try {
                    data = JSON.parse(text);
                } catch {
                    throw authError('ChatGPT authentication returned an invalid response.');
                }
            }
            if (!response.ok || response.status !== 200) {
                // Never copy endpoint bodies or descriptions into logs/UI: they may
                // contain credentials. Only an allowlisted OAuth code leaves here.
                const rawCode = typeof data.error === 'string' ? data.error : data.error?.code;
                const code = TERMINAL_REFRESH.has(rawCode) || ['invalid_client', 'access_denied'].includes(rawCode) ? rawCode : 'auth_unavailable';
                const error = authError(
                    code === 'invalid_client'
                        ? 'This ChatGPT app registration is no longer valid. Connect a new account.'
                        : code === 'auth_unavailable'
                          ? 'ChatGPT authentication is temporarily unavailable. Try again shortly.'
                          : 'ChatGPT authorization expired. Continue with ChatGPT again.',
                    code
                );
                error.status = response.status;
                throw error;
            }
            return data;
        } catch (error) {
            if (error[AUTH_ERROR]) throw error;
            throw authError(
                controller.signal.aborted
                    ? 'ChatGPT authentication was cancelled or timed out.'
                    : 'Could not connect to ChatGPT. Check your connection and try again.',
                controller.signal.aborted ? 'cancelled' : 'auth_unavailable'
            );
        } finally {
            clearTimeout(timer);
            requests.delete(controller);
            attemptSignal?.removeEventListener('abort', abort);
        }
    }

    async function discovery(signal) {
        if (discoveryCache && discoveryCache.expires > now()) return discoveryCache.value;
        const value = await request(`${ISSUER}/.well-known/openid-configuration`, {}, signal);
        if (value.issuer !== ISSUER || !safeAuthEndpoint(value.jwks_uri) || !safeAuthEndpoint(value.revocation_endpoint)) {
            throw authError('ChatGPT identity configuration could not be verified.', 'invalid_identity');
        }
        discoveryCache = { value, expires: now() + 60 * 60 * 1000 };
        return value;
    }

    async function signingKeys(force, signal) {
        if (!force && keysCache && keysCache.expires > now()) return keysCache.value;
        const config = await discovery(signal);
        const value = await request(config.jwks_uri, {}, signal);
        if (!Array.isArray(value.keys) || value.keys.length > 100) throw authError('ChatGPT signing keys could not be verified.', 'invalid_identity');
        keysCache = { value: value.keys, expires: now() + 60 * 60 * 1000 };
        return value.keys;
    }

    async function validateIdToken(token, clientId, { nonce, subject, signal } = {}) {
        const invalid = () => authError('ChatGPT account identity could not be verified. Please sign in again.', 'invalid_identity');
        if (typeof token !== 'string' || token.length > 32768) throw invalid();
        const parts = token.split('.');
        if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
        let header;
        let claims;
        try {
            header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
            claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        } catch {
            throw invalid();
        }
        if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit) throw invalid();
        let keys = await signingKeys(false, signal);
        let jwk = keys.find(
            key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig')
        );
        if (!jwk) {
            keys = await signingKeys(true, signal);
            jwk = keys.find(
                key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig')
            );
        }
        if (!jwk) throw invalid();
        try {
            const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
            if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw invalid();
        } catch {
            throw invalid();
        }
        const seconds = now() / 1000;
        const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (
            claims.iss !== ISSUER ||
            !audience.includes(clientId) ||
            (audience.length > 1 && claims.azp !== clientId) ||
            (claims.azp && claims.azp !== clientId) ||
            !Number.isFinite(claims.exp) ||
            claims.exp <= seconds ||
            (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 60)) ||
            (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > seconds + 60)) ||
            typeof claims.sub !== 'string' ||
            !claims.sub ||
            (nonce !== undefined && !equalSecret(claims.nonce, nonce)) ||
            (subject !== undefined && claims.sub !== subject)
        ) {
            throw invalid();
        }
        return claims;
    }

    function tokensFromResponse(data, previous = {}) {
        if (
            typeof data.access_token !== 'string' ||
            !data.access_token ||
            data.access_token.length > 65536 ||
            String(data.token_type).toLowerCase() !== 'bearer' ||
            !Number.isFinite(data.expires_in) ||
            data.expires_in <= 0 ||
            data.expires_in > 24 * 60 * 60 ||
            typeof data.refresh_token !== 'string' ||
            !data.refresh_token ||
            data.refresh_token.length > 65536
        ) {
            throw authError('ChatGPT returned incomplete credentials. Please sign in again.', 'invalid_token_response');
        }
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            idToken: data.id_token || previous.idToken,
            scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : previous.scopes || [],
            expiresAt: now() + data.expires_in * 1000,
        };
    }

    function clearTokens(account) {
        if (!account) return;
        delete account.accessToken;
        delete account.refreshToken;
        delete account.idToken;
        delete account.expiresAt;
        account.scopes = [];
    }

    function finishAttempt(attempt, error, status) {
        if (attempt.finished) return;
        attempt.finished = true;
        clearTimeout(attempt.timer);
        attempt.controller.abort();
        attempt.server.close();
        attempt.server.closeIdleConnections?.();
        if (pending === attempt) pending = null;
        if (error) lastError = error.message;
        notify();
        if (error) attempt.reject(error);
        else attempt.resolve(status || getStatus());
    }

    async function signIn({ consent = false, newAccount = false, accountId } = {}) {
        ensureActive();
        checkStorage();
        if (pending || starting) throw authError('ChatGPT sign-in is already in progress.', 'sign_in_in_progress');
        if (signingOut) throw authError('ChatGPT is signing out. Try again shortly.', 'sign_out_in_progress');
        const expectedGeneration = generation;
        const selected = newAccount ? null : accountId ? saved.accounts.find(account => account.clientId === accountId) : activeAccount();
        if (accountId && !selected && !newAccount) throw authError('Select an existing ChatGPT account or add a new account.', 'unknown_account');
        starting = true;
        lastError = null;
        notify();
        try {
            // Save the stable host ID before launching the browser, including if
            // the user cancels their first authorization attempt.
            await persist();
            ensureActive();
            if (expectedGeneration !== generation) throw authError('ChatGPT sign-in was cancelled.', 'cancelled');
            const attempt = {
                state: crypto.randomBytes(32).toString('base64url'),
                nonce: crypto.randomBytes(32).toString('base64url'),
                verifier: crypto.randomBytes(48).toString('base64url'),
                clientId:
                    selected?.clientId || (!newAccount && validClientId(saved.pendingClientId) ? saved.pendingClientId : 'dynamic_agent_client'),
                selected,
                controller: new AbortController(),
                finished: false,
                exchanging: false,
                generation,
            };
            const completed = new Promise((resolve, reject) => Object.assign(attempt, { resolve, reject }));
            // Attach immediately so cancellation while opening the browser cannot
            // create an unhandled rejection before the final await.
            completed.catch(() => {});
            attempt.server = http.createServer((req, res) => {
                const reply = (status, message) => {
                    res.writeHead(status, {
                        'Content-Type': 'text/plain; charset=utf-8',
                        'Cache-Control': 'no-store',
                        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
                        'Referrer-Policy': 'no-referrer',
                        Connection: 'close',
                    });
                    res.end(message);
                };
                if (
                    !attempt.redirectUri ||
                    req.method !== 'GET' ||
                    req.url.length > 16384 ||
                    req.headers.host !== new URL(attempt.redirectUri).host
                ) {
                    reply(400, 'Invalid callback.');
                    return;
                }
                const callback = new URL(req.url, attempt.redirectUri);
                if (callback.pathname !== '/auth/callback') {
                    reply(404, 'Not found.');
                    return;
                }
                const query = callback.searchParams;
                if (
                    ['state', 'code', 'client_id', 'error'].some(key => query.getAll(key).length > 1) ||
                    !equalSecret(query.get('state'), attempt.state)
                ) {
                    reply(400, 'The sign-in state did not match. Return to the original sign-in tab.');
                    return;
                }
                if (attempt.finished || attempt.exchanging) {
                    reply(409, 'This sign-in callback has already been used.');
                    return;
                }
                if (query.has('error')) {
                    reply(200, 'ChatGPT sign-in was cancelled. You can close this tab.');
                    finishAttempt(attempt, authError('ChatGPT sign-in was cancelled. You can try again from Honest Father.', 'access_denied'));
                    return;
                }
                const returnedId = query.get('client_id');
                const clientId = returnedId || (attempt.clientId !== 'dynamic_agent_client' ? attempt.clientId : null);
                if (
                    !validClientId(clientId) ||
                    (attempt.clientId !== 'dynamic_agent_client' && clientId !== attempt.clientId) ||
                    !query.get('code') ||
                    query.get('code').length > 8192
                ) {
                    reply(400, 'ChatGPT registration was incomplete. Return to Honest Father and sign in again.');
                    finishAttempt(attempt, authError('ChatGPT registration was incomplete. Please sign in again.', 'invalid_callback'));
                    return;
                }
                attempt.exchanging = true;
                void (async () => {
                    try {
                        const data = await request(
                            TOKEN,
                            {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                body: new URLSearchParams({
                                    grant_type: 'authorization_code',
                                    client_id: clientId,
                                    code: query.get('code'),
                                    code_verifier: attempt.verifier,
                                    redirect_uri: attempt.redirectUri,
                                    resource: RESOURCE,
                                }).toString(),
                            },
                            attempt.controller.signal
                        );
                        const claims = await validateIdToken(data.id_token, clientId, {
                            nonce: attempt.nonce,
                            subject: selected?.subject,
                            signal: attempt.controller.signal,
                        });
                        const tokens = tokensFromResponse(data);
                        if (attempt.finished || disposed || attempt.generation !== generation)
                            throw authError('ChatGPT sign-in was cancelled.', 'cancelled');
                        const existing = saved.accounts.find(account => account.clientId === clientId);
                        if (existing && existing.subject !== claims.sub)
                            throw authError('ChatGPT account identity did not match its registration.', 'invalid_identity');
                        const record = {
                            clientId,
                            subject: claims.sub,
                            issuer: ISSUER,
                            email: typeof claims.email === 'string' && claims.email.length <= 320 ? claims.email : '',
                            ...tokens,
                        };
                        const previousSaved = saved;
                        saved = {
                            ...saved,
                            activeAccountId: clientId,
                            accounts: [...saved.accounts.filter(account => account.clientId !== clientId), record],
                        };
                        delete saved.pendingClientId;
                        try {
                            await persist();
                        } catch {
                            saved = previousSaved;
                            throw authError(
                                'ChatGPT credentials could not be saved securely. Check your keychain and disk, then try again.',
                                'secure_storage_unavailable'
                            );
                        }
                        if (attempt.finished || disposed || attempt.generation !== generation)
                            throw authError('ChatGPT sign-in was cancelled.', 'cancelled');
                        generation++;
                        lastError = tokens.scopes.includes(PLAN_SCOPE)
                            ? null
                            : 'Signed in, but ChatGPT plan use is not enabled. Enable it before starting.';
                        reply(200, 'ChatGPT is connected. You can close this tab and return to Honest Father.');
                        finishAttempt(attempt);
                    } catch (error) {
                        if (error.code === 'invalid_grant' && !selected && !attempt.finished && attempt.generation === generation) {
                            saved.pendingClientId = clientId;
                            await persist().catch(() => {});
                        }
                        reply(400, 'ChatGPT sign-in could not be completed. Return to Honest Father for details.');
                        finishAttempt(attempt, error.code ? error : authError('ChatGPT sign-in could not be completed. Please try again.'));
                    }
                })();
            });
            pending = attempt;
            starting = false;
            attempt.server.requestTimeout = 10000;
            attempt.server.headersTimeout = 10000;
            try {
                await new Promise((resolve, reject) => {
                    attempt.server.once('error', reject);
                    attempt.server.listen(0, '127.0.0.1', resolve);
                });
                if (attempt.finished || disposed) throw authError('ChatGPT sign-in was cancelled.', 'cancelled');
                attempt.redirectUri = `http://127.0.0.1:${attempt.server.address().port}/auth/callback`;
                attempt.timer = setTimeout(
                    () => finishAttempt(attempt, authError('ChatGPT sign-in timed out. Continue with ChatGPT again.', 'sign_in_timeout')),
                    authorizationTimeoutMs
                );
                const url = new URL(AUTHORIZE);
                const parameters = {
                    client_id: attempt.clientId,
                    ext_agent_host_id: saved.hostId,
                    response_type: 'code',
                    redirect_uri: attempt.redirectUri,
                    scope: SCOPES,
                    resource: RESOURCE,
                    state: attempt.state,
                    nonce: attempt.nonce,
                    code_challenge_method: 'S256',
                    code_challenge: crypto.createHash('sha256').update(attempt.verifier).digest('base64url'),
                };
                if (attempt.clientId === 'dynamic_agent_client') parameters.agent_name_hint = 'Honest Father';
                if (selected) {
                    if (selected.idToken) parameters.id_token_hint = selected.idToken;
                    if (selected.email) parameters.login_hint = selected.email;
                }
                if (consent) parameters.prompt = 'consent';
                url.search = new URLSearchParams(parameters).toString();
                notify();
                await Promise.race([openExternal(url.href), completed]);
            } catch {
                finishAttempt(attempt, authError('Could not open ChatGPT sign-in. Check your default browser and try again.', 'browser_unavailable'));
            }
            return await completed;
        } finally {
            starting = false;
            notify();
        }
    }

    async function getAccessToken({ forceRefresh = false } = {}) {
        ensureActive();
        if (signingOut) throw authError('ChatGPT is signed out. Continue with ChatGPT before starting.', 'sign_in_required');
        const account = activeAccount();
        if (!account?.accessToken) throw authError('Continue with ChatGPT before starting.', 'sign_in_required');
        if (!account.scopes.includes(PLAN_SCOPE)) throw authError('Enable ChatGPT plan use before starting.', 'plan_permission_required');
        if (!forceRefresh && account.expiresAt > now() + 60000) return account.accessToken;
        if (refreshPromise) return refreshPromise;
        const expectedGeneration = generation;
        refreshPromise = (async () => {
            try {
                checkStorage();
                const data = await request(TOKEN, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'refresh_token',
                        client_id: account.clientId,
                        refresh_token: account.refreshToken,
                        resource: RESOURCE,
                    }).toString(),
                });
                if (data.id_token) await validateIdToken(data.id_token, account.clientId, { subject: account.subject });
                const tokens = tokensFromResponse(data, account);
                if (disposed || generation !== expectedGeneration) throw authError('The ChatGPT account changed. Start again.', 'cancelled');
                Object.assign(account, tokens);
                await persist();
                if (disposed || generation !== expectedGeneration) throw authError('The ChatGPT account changed. Start again.', 'cancelled');
                lastError = null;
                notify();
                if (!account.scopes.includes(PLAN_SCOPE)) throw authError('Enable ChatGPT plan use before starting.', 'plan_permission_required');
                return account.accessToken;
            } catch (error) {
                if (generation === expectedGeneration && !disposed) {
                    if (TERMINAL_REFRESH.has(error.code)) {
                        clearTokens(account);
                        await persist();
                    }
                    lastError = error.message;
                    notify();
                }
                throw error;
            } finally {
                refreshPromise = null;
            }
        })();
        return refreshPromise;
    }

    async function endSession() {
        ensureActive();
        generation++;
        if (pending) finishAttempt(pending, authError('ChatGPT sign-in was cancelled.', 'cancelled'));
        for (const controller of requests) controller.abort();
        const account = activeAccount();
        let remoteRevocationConfirmed = !account?.refreshToken;
        if (account?.refreshToken) {
            try {
                const config = await discovery();
                const parameters = {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        token: account.refreshToken,
                        token_type_hint: 'refresh_token',
                        client_id: account.clientId,
                    }).toString(),
                };
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        await request(config.revocation_endpoint, parameters);
                        remoteRevocationConfirmed = true;
                        break;
                    } catch (error) {
                        if (attempt || (error.status && error.status < 500)) break;
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                }
            } catch {
                // Always remove local credentials; report unconfirmed remote revoke.
            }
        }
        clearTokens(account);
        await persist();
        lastError = remoteRevocationConfirmed
            ? null
            : 'Signed out locally. Remote revocation could not be confirmed; disconnect Honest Father in ChatGPT Settings.';
        notify();
        return { ...getStatus(), remoteRevocationConfirmed };
    }

    function signOut() {
        if (signOutPromise) return signOutPromise;
        signingOut = true;
        notify();
        signOutPromise = endSession().finally(() => {
            signingOut = false;
            signOutPromise = null;
            notify();
        });
        return signOutPromise;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        generation++;
        if (pending) finishAttempt(pending, authError('ChatGPT sign-in was cancelled.', 'cancelled'));
        for (const controller of requests) controller.abort();
    }

    return { getStatus, signIn, signOut, getAccessToken, dispose };
}

module.exports = { createChatGPTAuth };
