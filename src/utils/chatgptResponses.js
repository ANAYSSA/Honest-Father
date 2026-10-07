// ChatGPT plan usage: public Responses API only. Tokens remain in the main process.
// https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
const { chatGPTModelInfo, normalizeModelInfo } = require('./historyModels');
const API_ROOT = 'https://api.openai.com/v1';
const MODEL_CACHE_MS = 5 * 60 * 1000;
const MAX_EVENT_CHARS = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 512 * 1024;
const AUTH_ERROR_CODES = new Set([
    'sign_in_required',
    'plan_permission_required',
    'invalid_grant',
    'invalid_refresh_token',
    'token_expired',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused',
    'invalid_client',
    'auth_unavailable',
    'cancelled',
    'secure_storage_unavailable',
    'invalid_identity',
    'invalid_token_response',
]);

function safeText(value, token = '') {
    let text = typeof value === 'string' ? value : '';
    if (token) text = text.split(token).join('[redacted]');
    return text
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\b(?:sk-[\w-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .slice(0, 500);
}

function identifier(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) ? value : undefined;
}

class ChatGPTResponseError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'ChatGPTResponseError';
        Object.assign(this, details);
    }
}

function abortError() {
    const error = new Error('ChatGPT request cancelled.');
    error.name = 'AbortError';
    return error;
}

function waitFor(promise, signal) {
    if (signal.aborted) return Promise.reject(signal.reason || abortError());
    return new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason || abortError());
        signal.addEventListener('abort', aborted, { once: true });
        Promise.resolve(promise)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', aborted));
    });
}

function providerError(body, status, requestId, token) {
    const structured = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
    const code = identifier(structured?.code || body?.code);
    const param = identifier(structured?.param || body?.param);
    const details = { status, code, param, requestId: identifier(requestId) };
    details.bodyShape = structured ? 'error' : typeof body?.detail === 'string' ? 'detail' : typeof body === 'string' ? 'text' : 'other';
    let message;
    switch (code) {
        case 'subscription_sharing_usage_limit_exceeded':
            message = 'ChatGPT app usage limit reached. Check ChatGPT Settings → Usage, or select Gemini.';
            details.usageUrl = 'https://chatgpt.com/settings/usage';
            break;
        case 'subscription_sharing_user_not_eligible':
            message = 'ChatGPT plan usage is unavailable for this account or workspace. Select another account or Gemini.';
            break;
        case 'subscription_sharing_unsupported_capability':
            message = `The selected ChatGPT model or capability is unavailable${param ? ` (${param})` : ''}. Change the model or turn off Pro.`;
            break;
        default:
            if (status === 401) message = 'ChatGPT did not accept this account authorization. Sign in again to enable plan usage.';
            else if (status === 403) message = 'ChatGPT plan usage is restricted for this account, workspace, or region.';
            else if (status === 429) message = 'ChatGPT is rate limited. Wait before trying again; check ChatGPT Settings → Usage.';
            else if (status === 503) message = 'ChatGPT is temporarily unavailable. Try again shortly.';
            else message = 'ChatGPT could not complete the request.';
    }
    // Keep bounded diagnostics for troubleshooting without exposing bearer credentials.
    details.diagnostic = safeText(structured?.message || body?.detail || body?.message || (typeof body === 'string' ? body : ''), token);
    return new ChatGPTResponseError(message, details);
}

function normalizeModel(row) {
    if (!row || row.visibility !== 'list' || !identifier(row.slug) || typeof row.display_name !== 'string') return null;
    const id = row.slug;
    // These exact families are documented; do not infer capabilities for future names.
    const knownNone = /^(?:gpt-5\.6(?:-(?:sol|terra|luna))?|gpt-6-(?:sol|luna))(?:-\d{4}-\d{2}-\d{2})?$/.test(id);
    const knownLow = /^(?:gpt-6-astra|gpt-6\.1-sol)(?:-\d{4}-\d{2}-\d{2})?$/.test(id);
    const modes = Array.isArray(row.supported_reasoning_modes) ? row.supported_reasoning_modes : null;
    const levels = Array.isArray(row.supported_reasoning_levels)
        ? row.supported_reasoning_levels.map(level => (typeof level === 'string' ? level : level?.effort))
        : null;
    return {
        id,
        name: safeText(row.display_name) || id,
        supportsPro: modes ? modes.includes('pro') : typeof row.supports_pro === 'boolean' ? row.supports_pro : knownNone || knownLow,
        fastReasoningEffort: levels
            ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].find(effort => levels.includes(effort)) || null
            : knownNone
              ? 'none'
              : knownLow
                ? 'low'
                : null,
    };
}

function selectDefaultModel(models) {
    if (!Array.isArray(models) || !models.length) return '';
    return (
        models.find(model => /5[.\s]6/i.test(`${model.id} ${model.name}`) && /instant/i.test(`${model.id} ${model.name}`)) ||
        models.find(model => model.id === 'gpt-5.6-luna') ||
        models.find(model => /instant/i.test(`${model.id} ${model.name}`)) ||
        models[0]
    ).id;
}

function createInput(prompt, imageBase64, mimeType, history) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 50000) throw new Error('Enter a ChatGPT prompt of up to 50,000 characters.');
    const input = [];
    let remaining = 24000;
    // Keep recent text only. Never resend old screenshots, tools, or provider credentials.
    for (const entry of Array.isArray(history) ? history.slice(-12).reverse() : []) {
        if (!entry || !['user', 'assistant'].includes(entry.role) || typeof entry.content !== 'string') continue;
        const content = entry.content.slice(-Math.min(8000, remaining));
        if (content) input.unshift({ role: entry.role, content });
        remaining -= content.length;
        if (!remaining) break;
    }
    const content = [{ type: 'input_text', text: prompt.trim() }];
    if (imageBase64 !== undefined && imageBase64 !== null) {
        if (
            typeof imageBase64 !== 'string' ||
            !imageBase64.length ||
            imageBase64.length > 16 * 1024 * 1024 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64) ||
            !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)
        ) {
            throw new Error('ChatGPT needs a valid JPEG, PNG, or WebP screenshot.');
        }
        content.push({ type: 'input_image', image_url: `data:${mimeType};base64,${imageBase64}` });
    }
    input.push({ role: 'user', content });
    return input;
}

function responseText(response) {
    return (Array.isArray(response?.output) ? response.output : [])
        .filter(item => item?.type === 'message')
        .flatMap(item => (Array.isArray(item.content) ? item.content : []))
        .map(part => (part?.type === 'output_text' ? part.text : part?.type === 'refusal' ? part.refusal : ''))
        .filter(text => typeof text === 'string')
        .join('\n');
}

async function readResponseStream(response, { signal, onText, onResponse, token }) {
    if (!response.body?.getReader) throw new ChatGPTResponseError('ChatGPT returned no readable response stream.', { code: 'missing_stream' });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts = new Map();
    let buffer = '';
    let dataLines = [];
    let eventName = '';
    let complete = false;
    let finalText = '';
    let eventChars = 0;
    const requestId = identifier(response.headers?.get('x-request-id'));
    const dispatch = () => {
        if (!dataLines.length) {
            eventName = '';
            return;
        }
        const raw = dataLines.join('\n');
        dataLines = [];
        eventChars = 0;
        if (raw === '[DONE]') return;
        let event;
        try {
            event = JSON.parse(raw);
        } catch {
            throw new ChatGPTResponseError('ChatGPT returned an unreadable stream event. Try again.', { code: 'invalid_stream', requestId });
        }
        const type = event.type || eventName;
        eventName = '';
        if (type === 'response.failed' || type === 'error') {
            throw providerError(event.response || (event.error ? event : { error: event }), response.status, requestId, token);
        }
        if (type === 'response.incomplete') {
            throw new ChatGPTResponseError('ChatGPT stopped before finishing the answer. Try a shorter prompt or another model.', {
                code: 'response_incomplete',
                reason: identifier(event.response?.incomplete_details?.reason),
                requestId,
            });
        }
        if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
            if (typeof event.delta !== 'string') return;
            const key = `${event.output_index || 0}:${event.content_index || 0}`;
            parts.set(key, (parts.get(key) || '') + event.delta);
            const text = [...parts.values()].join('\n');
            if (text.length > MAX_OUTPUT_CHARS) throw new ChatGPTResponseError('ChatGPT response is too long.', { code: 'response_too_large' });
            onText?.(text);
        } else if (type === 'response.completed') {
            if (event.response?.status && event.response.status !== 'completed') {
                throw new ChatGPTResponseError('ChatGPT did not finish the answer.', { code: 'response_incomplete', requestId });
            }
            finalText = responseText(event.response) || [...parts.values()].join('\n');
            if (!finalText.trim())
                throw new ChatGPTResponseError('ChatGPT returned an empty answer. Try again.', { code: 'empty_response', requestId });
            if (finalText.length > MAX_OUTPUT_CHARS) throw new ChatGPTResponseError('ChatGPT response is too long.', { code: 'response_too_large' });
            complete = true;
            onResponse?.(event.response);
            onText?.(finalText);
        }
    };
    function line(value) {
        if (!value) return dispatch();
        if (value.startsWith('data:')) {
            dataLines.push(value.slice(5).replace(/^ /, ''));
            eventChars += value.length;
            if (eventChars > MAX_EVENT_CHARS) throw new ChatGPTResponseError('ChatGPT stream event is too large.', { code: 'invalid_stream' });
        } else if (value.startsWith('event:')) eventName = value.slice(6).trim();
    }
    try {
        while (!complete) {
            const { value, done } = await waitFor(reader.read(), signal);
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const current = buffer.slice(0, newline).replace(/\r$/, '');
                buffer = buffer.slice(newline + 1);
                line(current);
                if (complete) break;
            }
            if (buffer.length > MAX_EVENT_CHARS) throw new ChatGPTResponseError('ChatGPT stream event is too large.', { code: 'invalid_stream' });
            if (done) {
                if (buffer) line(buffer.replace(/\r$/, ''));
                if (!complete) dispatch();
                break;
            }
        }
        if (!complete) {
            throw new ChatGPTResponseError('The ChatGPT connection ended before the answer was complete. Try again.', {
                code: 'interrupted_stream',
                requestId,
            });
        }
        return finalText;
    } finally {
        // Do not leave an HTTP stream open after cancellation, terminal events, or malformed data.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

function createChatGPTResponses({
    fetch,
    getAccessToken,
    now = Date.now,
    requestTimeoutMs = 90000,
    proTimeoutMs = 300000,
    modelTimeoutMs = 15000,
    retryDelayMs = 500,
}) {
    if (typeof fetch !== 'function' || typeof getAccessToken !== 'function') throw new TypeError('ChatGPT needs fetch and getAccessToken functions.');
    let cache = null;
    let pendingModels = null;
    let generation = 0;
    const active = new Set();

    function operation(timeoutMs, externalSignal) {
        const controller = new AbortController();
        const aborted = () => controller.abort(abortError());
        if (externalSignal?.aborted) aborted();
        else externalSignal?.addEventListener('abort', aborted, { once: true });
        const timer = setTimeout(() => {
            controller.abort(
                new ChatGPTResponseError('ChatGPT took too long to respond. Check the connection or choose a faster model.', { code: 'timeout' })
            );
        }, timeoutMs);
        active.add(controller);
        return {
            signal: controller.signal,
            close() {
                clearTimeout(timer);
                externalSignal?.removeEventListener('abort', aborted);
                active.delete(controller);
            },
        };
    }

    function invalidateModels() {
        generation++;
        cache = null;
        pendingModels = null;
        for (const controller of active) controller.abort(abortError());
        active.clear();
    }

    async function checkedFetch(url, options, signal, token) {
        const response = await waitFor(fetch(url, { ...options, signal, redirect: 'error' }), signal);
        if (response.ok) return response;
        const text = await readBoundedText(response, signal, 32768);
        let body;
        try {
            body = JSON.parse(text);
        } catch {
            body = text;
        }
        throw providerError(body, response.status, response.headers?.get('x-request-id'), token);
    }

    function listModels({ force = false, signal } = {}) {
        if (signal?.aborted) return Promise.reject(abortError());
        if (!force && cache && cache.expires > now()) return Promise.resolve(cache.models.map(model => ({ ...model })));
        if (!pendingModels) {
            const startedGeneration = generation;
            const request = operation(modelTimeoutMs);
            const pending = Promise.resolve().then(async () => {
                try {
                    const token = await waitFor(getAccessToken(), request.signal);
                    const response = await checkedFetch(
                        `${API_ROOT}/models`,
                        { headers: { Authorization: `Bearer ${token}` } },
                        request.signal,
                        token
                    );
                    let data;
                    try {
                        data = JSON.parse(await readBoundedText(response, request.signal, 1024 * 1024));
                    } catch (error) {
                        if (request.signal.aborted) throw error;
                        throw new ChatGPTResponseError('ChatGPT returned an invalid model catalog.', { code: 'invalid_catalog' });
                    }
                    if (!Array.isArray(data?.models))
                        throw new ChatGPTResponseError('ChatGPT returned an invalid model catalog.', { code: 'invalid_catalog' });
                    const seen = new Set();
                    const models = data.models.map(normalizeModel).filter(model => model && !seen.has(model.id) && seen.add(model.id));
                    if (!models.length)
                        throw new ChatGPTResponseError('This ChatGPT account has no available models for app usage.', { code: 'no_models' });
                    if (generation !== startedGeneration) throw abortError();
                    cache = { models, expires: now() + MODEL_CACHE_MS };
                    return models;
                } finally {
                    request.close();
                    if (pendingModels === pending) pendingModels = null;
                }
            });
            pendingModels = pending;
        }
        const result = signal ? waitFor(pendingModels, signal) : pendingModels;
        return result.then(models => models.map(model => ({ ...model })));
    }

    async function respond({
        model,
        prompt,
        imageBase64,
        mimeType = 'image/jpeg',
        history,
        instructions,
        signal,
        onText,
        onModel,
        reasoningMode = 'standard',
    }) {
        const input = createInput(prompt, imageBase64, mimeType, history);
        if (!['standard', 'pro'].includes(reasoningMode)) throw new Error('Choose Standard or Pro for ChatGPT.');
        if (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > 24000))
            throw new Error('ChatGPT instructions are too long.');
        const request = operation(reasoningMode === 'pro' ? proTimeoutMs : requestTimeoutMs, signal);
        try {
            const models = await listModels({ signal: request.signal });
            const id = !model || model === 'auto' ? selectDefaultModel(models) : model;
            const selected = models.find(candidate => candidate.id === id);
            if (!selected)
                throw new ChatGPTResponseError('This ChatGPT model is unavailable for the account. Choose a model in Home.', {
                    code: 'model_unavailable',
                });
            if (reasoningMode === 'pro' && !selected.supportsPro)
                throw new ChatGPTResponseError('Pro is not available for this ChatGPT model.', { code: 'unsupported_pro' });
            const body = { model: id, input, store: false, stream: true };
            if (instructions?.trim()) body.instructions = instructions.trim();
            const reasoning = {};
            if (reasoningMode === 'standard' && selected.fastReasoningEffort) reasoning.effort = selected.fastReasoningEffort;
            if (reasoningMode === 'pro') reasoning.mode = 'pro';
            if (Object.keys(reasoning).length) body.reasoning = reasoning;
            const token = await waitFor(getAccessToken(), request.signal);
            let response;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    response = await checkedFetch(
                        `${API_ROOT}/responses`,
                        {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                            body: JSON.stringify(body),
                        },
                        request.signal,
                        token
                    );
                    break;
                } catch (error) {
                    // Only a definite pre-stream 503 can be retried. Network failures may
                    // already have started/billed a response; never replay those automatically.
                    const retryableCode =
                        !error.code || ['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable'].includes(error.code);
                    if (attempt || error.status !== 503 || !retryableCode || request.signal.aborted) throw error;
                    await waitFor(new Promise(resolve => setTimeout(resolve, retryDelayMs)), request.signal);
                }
            }
            return await readResponseStream(response, {
                signal: request.signal,
                onText,
                token,
                onResponse(completed) {
                    const resolvedId = identifier(completed?.model) || id;
                    const resolved = models.find(candidate => candidate.id === resolvedId);
                    const selectedInfo = chatGPTModelInfo(resolved || { id: resolvedId }, reasoningMode);
                    onModel?.(
                        normalizeModelInfo({
                            ...selectedInfo,
                            reasoningMode: completed?.reasoning?.mode || reasoningMode,
                            reasoningEffort: completed?.reasoning?.effort || body.reasoning?.effort,
                        })
                    );
                },
            });
        } catch (error) {
            if (request.signal.aborted) throw request.signal.reason || abortError();
            if (error instanceof ChatGPTResponseError || error?.name === 'AbortError') throw error;
            if (AUTH_ERROR_CODES.has(error?.code)) throw new ChatGPTResponseError(safeText(error.message), { code: error.code });
            throw new ChatGPTResponseError('Could not connect to ChatGPT. Check the connection and try again.', { code: 'network_error' });
        } finally {
            request.close();
        }
    }

    return { listModels, respond, invalidateModels };
}

async function readBoundedText(response, signal, limit) {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
        while (true) {
            const { value, done } = await waitFor(reader.read(), signal);
            if (done) return text + decoder.decode();
            bytes += value.byteLength;
            if (bytes > limit) throw new ChatGPTResponseError('ChatGPT returned an oversized server response.', { code: 'invalid_server_response' });
            text += decoder.decode(value, { stream: true });
        }
    } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

module.exports = { createChatGPTResponses, selectDefaultModel, ChatGPTResponseError };
