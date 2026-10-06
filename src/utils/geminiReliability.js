// Keep transport policy independent of Electron so reconnect races can be tested.
function classifyGoogleError(error = {}) {
    let parsed = {};
    const rawMessage = typeof error === 'string' ? error : error.reason || error.message || error.error?.message || '';
    try {
        parsed = JSON.parse(rawMessage);
    } catch {
        // WebSocket reasons are often plain text rather than JSON API errors.
    }
    const details = parsed.error || parsed;
    const message = `${rawMessage} ${details.message || ''} ${error.status || ''}`;
    const status = Number(error.status || error.code || error.error?.code || details.code) || 0;
    const retryMatch = message.match(/retry(?:\s+in|Delay["':\s]+)\s*([\d.]+)s/i);
    const retryAfterMs = retryMatch ? Math.ceil(Number(retryMatch[1]) * 1000) : 60000;

    if (
        [401, 403].includes(status) ||
        /api.?key.{0,30}(?:invalid|not valid|not found|expired|revoked|missing)|(?:invalid|missing).{0,20}api.?key|unauthenticated|permission.denied|reported as leaked|invalid credentials/i.test(
            message
        )
    ) {
        return {
            code: 'authentication',
            retryable: false,
            cooldownMs: Infinity,
            message: 'Gemini rejected the API key or project access. Check the key and API permissions in Google AI Studio, then start again.',
        };
    }
    if ([402, 429].includes(status) || /resource.exhausted|quota|rate.?limit|prepay|billing|credit.?balance/i.test(message)) {
        const dailyQuota = /per.?day|daily|limit:\s*0|limit["':\s]+0\b|credits?.*(?:exhausted|depleted)/i.test(message);
        return {
            code: 'quota',
            retryable: false,
            cooldownMs: dailyQuota ? Math.max(900000, retryAfterMs) : Math.max(60000, retryAfterMs),
            message: 'Gemini quota or billing limit reached. Requests are paused; check usage and billing in Google AI Studio before restarting.',
        };
    }
    if (
        (status === 0 || [400, 404, 1008].includes(status)) &&
        (/model.+(?:not found|not supported|does not support)|not found.+model|(?:unknown|invalid) model|(?:unsupported|not supported).+(?:model|generateContent|bidiGenerateContent)/i.test(
            message
        ) ||
            (status === 404 && /model.+unavailable/i.test(message)))
    ) {
        return {
            code: 'model',
            retryable: false,
            cooldownMs: 10000,
            message: 'Gemini could not use a compatible model for this request. Check model access in Google AI Studio and try again.',
        };
    }
    if ([400, 1007, 1008, 1009].includes(status) || /invalid.argument|unsupported|policy violation/i.test(message)) {
        return {
            code: 'configuration',
            retryable: false,
            cooldownMs: Infinity,
            message: 'Gemini rejected the session configuration or input. Check the selected model and settings before restarting.',
        };
    }
    if (
        [408, 500, 502, 503, 504, 1000, 1001, 1005, 1006, 1011, 1012, 1013].includes(status) ||
        /network|socket|connect|timeout|timed out|unavailable|internal|econn|fetch failed|aborted/i.test(message)
    ) {
        return {
            code: 'network',
            retryable: true,
            cooldownMs: 5000,
            message: 'Gemini connection interrupted. Check the network and try again.',
        };
    }
    return { code: 'unknown', retryable: false, cooldownMs: 10000, message: 'Gemini request failed. Check the model, key and connection.' };
}

function createReconnectController({
    reconnect,
    onRetry = () => {},
    onStopped = () => {},
    maxAttempts = 3,
    stableMs = 30000,
    timers = globalThis,
    random = Math.random,
}) {
    let attempts = 0;
    let generation = 0;
    let enabled = true;
    let timer = null;
    let stableTimer = null;
    let running = false;
    let pendingFailure = null;

    function clearTimers() {
        if (timer !== null) timers.clearTimeout(timer);
        if (stableTimer !== null) timers.clearTimeout(stableTimer);
        timer = null;
        stableTimer = null;
    }

    function cancel() {
        enabled = false;
        generation++;
        pendingFailure = null;
        clearTimers();
    }

    function reset() {
        cancel();
        enabled = true;
        running = false;
        attempts = 0;
    }

    function stop(failure) {
        cancel();
        onStopped(failure);
    }

    function markConnected() {
        if (!enabled) return;
        if (stableTimer !== null) timers.clearTimeout(stableTimer);
        const token = generation;
        stableTimer = timers.setTimeout(() => {
            if (enabled && token === generation && timer === null && !running) attempts = 0;
            stableTimer = null;
        }, stableMs);
    }

    function request(error) {
        if (!enabled) return false;
        const failure = classifyGoogleError(error);
        if (!failure.retryable) {
            stop(failure);
            return false;
        }
        if (stableTimer !== null) timers.clearTimeout(stableTimer);
        stableTimer = null;
        if (running) {
            pendingFailure = error;
            return false;
        }
        if (timer !== null) return false;
        if (attempts >= maxAttempts) {
            stop({ ...failure, message: `Gemini could not reconnect after ${maxAttempts} attempts. Check your network and start again.` });
            return false;
        }
        const delay = Math.min(30000, 1000 * 2 ** attempts + Math.floor(random() * 500));
        const token = generation;
        onRetry(attempts + 1, delay);
        timer = timers.setTimeout(async () => {
            timer = null;
            if (!enabled || token !== generation) return;
            running = true;
            attempts++;
            pendingFailure = null;
            let result;
            try {
                result = await reconnect(attempts);
            } catch (reconnectError) {
                result = reconnectError;
            }
            if (!enabled || token !== generation) return;
            running = false;
            if (pendingFailure) {
                const failureDuringConnect = pendingFailure;
                pendingFailure = null;
                request(failureDuringConnect);
            } else if (result === true) {
                markConnected();
            } else {
                request(result || { code: 1006 });
            }
        }, delay);
        return true;
    }

    return { request, reset, cancel, markConnected };
}

function createRequestGate({ now = Date.now } = {}) {
    let inFlight = false;
    let activeIdentity = null;
    const failures = new Map();
    return {
        begin(identity) {
            if (inFlight) return { success: true, skipped: true, code: 'busy' };
            const failure = failures.get(identity);
            if (failure && failure.until > now()) {
                return {
                    success: false,
                    error: failure.message,
                    code: failure.code,
                    retryAfterMs: Number.isFinite(failure.until) ? failure.until - now() : null,
                };
            }
            failures.delete(identity);
            activeIdentity = identity;
            inFlight = true;
            return null;
        },
        finish(error) {
            if (error && activeIdentity !== null) {
                const failure = classifyGoogleError(error);
                failures.set(activeIdentity, { ...failure, until: now() + failure.cooldownMs });
                // Identities include the configured key, so don't retain old keys indefinitely.
                if (failures.size > 8) failures.delete(failures.keys().next().value);
            }
            activeIdentity = null;
            inFlight = false;
        },
    };
}

function createPcmActivityFilter({ threshold = 100, hangoverMs = 900, now = Date.now } = {}) {
    let lastSpeechAt = -Infinity;
    let streamOpen = false;
    return {
        get isOpen() {
            return streamOpen;
        },
        inspect(buffer) {
            let squaredSum = 0;
            let peak = 0;
            const samples = Math.floor(buffer.length / 2);
            for (let i = 0; i < samples; i++) {
                const amplitude = Math.abs(buffer.readInt16LE(i * 2));
                squaredSum += amplitude ** 2;
                if (amplitude > peak) peak = amplitude;
            }
            const speech = samples > 0 && (Math.sqrt(squaredSum / samples) >= threshold || peak >= threshold * 4);
            if (speech) lastSpeechAt = now();
            if (speech || (streamOpen && now() - lastSpeechAt < hangoverMs)) {
                streamOpen = true;
                return { send: true, ended: false };
            }
            const ended = streamOpen;
            streamOpen = false;
            return { send: false, ended };
        },
        reset() {
            lastSpeechAt = -Infinity;
            streamOpen = false;
        },
    };
}

function buildSessionContext(history, maxChars = 8000, maxTurns = 6) {
    const validTurns = history.filter(turn => turn.transcription?.trim() && turn.ai_response?.trim()).slice(-maxTurns);
    const lines = [];
    let remaining = maxChars;
    for (let index = validTurns.length - 1; index >= 0 && remaining > 0; index--) {
        const turn = validTurns[index];
        const line = `[User]: ${turn.transcription.trim()}\n[Assistant]: ${turn.ai_response.trim()}`;
        const clipped = line.slice(-remaining);
        lines.unshift(clipped);
        remaining -= clipped.length + 2;
    }
    return lines.length ? lines.join('\n\n') : null;
}

function createSseLineBuffer() {
    let pending = '';
    return (chunk, final = false) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop();
        if (final && pending) {
            lines.push(pending);
            pending = '';
        }
        return lines.map(line => line.replace(/\r$/, ''));
    };
}

module.exports = {
    classifyGoogleError,
    createReconnectController,
    createRequestGate,
    createPcmActivityFilter,
    buildSessionContext,
    createSseLineBuffer,
};
