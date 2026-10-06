const { createHash } = require('node:crypto');
const { classifyGoogleError } = require('./geminiReliability');

const DEFAULT_IMAGE_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_LIVE_MODEL = 'gemini-3.8-live';
const IMAGE_PREFERENCES = [
    DEFAULT_IMAGE_MODEL,
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-2.5-flash',
];
const LIVE_PREFERENCES = [DEFAULT_LIVE_MODEL, 'gemini-3.1-flash-live-preview', 'gemini-2.5-flash-native-audio-preview-12-2025'];
const LEGACY_DEFAULTS = new Set([...IMAGE_PREFERENCES, ...LIVE_PREFERENCES, 'gemini-2.0-flash', 'gemini-2.0-flash-lite']);

function normalizeModelName(value) {
    return typeof value === 'string' ? value.trim().replace(/^models\//, '') : '';
}

function supportsAction(model, kind) {
    const actions = model.supportedActions || model.supportedGenerationMethods || [];
    return actions.includes(kind === 'live' ? 'bidiGenerateContent' : 'generateContent');
}

function compatibleName(name, kind) {
    if (kind === 'live') return true;
    // ListModels does not expose input modalities. General Gemini Flash/Pro models
    // support image understanding; specialized audio/image-output models do not fit this request.
    return !/(?:tts|live|native-audio|embedding|transcribe|image|nano-banana|omni|robotics)/i.test(name);
}

function chooseModel(models, { selected = '', kind = 'image', rejected = new Set(), fallback = false } = {}) {
    selected = normalizeModelName(selected);
    const automatic = !selected || selected.toLowerCase() === 'auto';
    const configured = models.find(model => normalizeModelName(model.name) === selected);
    if (!fallback && !automatic && !rejected.has(selected) && compatibleName(selected, kind)) {
        if (configured && supportsAction(configured, kind)) return selected;
        // A valid custom alias/tuned model may not appear in the base-model catalogue.
        // Try it once and only fall back if the API explicitly rejects its model/capability.
        if (!configured && !LEGACY_DEFAULTS.has(selected)) return selected;
    }
    const candidates = models
        .filter(model => supportsAction(model, kind))
        .map(model => normalizeModelName(model.name))
        .filter(name => name && !rejected.has(name) && compatibleName(name, kind))
        .filter(name => (kind === 'live' ? !/translate/i.test(name) : /^gemini-(?:[\d.]+-)?(?:flash|pro)(?:[-.]|$)/i.test(name)));
    const preferences = kind === 'live' ? LIVE_PREFERENCES : IMAGE_PREFERENCES;
    candidates.sort((a, b) => {
        const rank = name => {
            const preferred = preferences.indexOf(name);
            if (preferred >= 0) return preferred;
            return preferences.length + (/flash-lite/i.test(name) ? 0 : /flash/i.test(name) ? 1 : 2);
        };
        return rank(a) - rank(b) || a.localeCompare(b);
    });
    if (candidates[0]) return candidates[0];
    throw Object.assign(
        new Error(`No compatible Gemini model: not found for ${kind === 'live' ? 'bidiGenerateContent' : 'generateContent'} in this project.`),
        { status: 404 }
    );
}

function createGeminiModelResolver({ now = Date.now, ttlMs = 600000 } = {}) {
    const cache = new Map();
    const keyId = key => createHash('sha256').update(key).digest('hex');
    const choiceId = (selected, kind) => `${kind}:${normalizeModelName(selected) || 'auto'}`;
    function getEntry(key) {
        const id = keyId(key);
        const entry = cache.get(id);
        if (entry && entry.expires > now() && !entry.signal?.aborted) return entry;
        cache.delete(id);
        return null;
    }
    function putEntry(key, entry) {
        cache.set(keyId(key), entry);
        if (cache.size > 8) cache.delete(cache.keys().next().value);
        return entry;
    }
    async function catalogue(key, client, signal, refresh = false) {
        let entry = getEntry(key);
        if (!refresh && entry?.models) return entry;
        if (!refresh && entry?.pending) return entry.pending;
        const discoverySignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
        entry = putEntry(key, {
            models: null,
            choices: entry?.choices || new Map(),
            rejected: entry?.rejected || new Map(),
            expires: now() + ttlMs,
            signal: discoverySignal,
        });
        entry.pending = (async () => {
            const pager = await client.models.list({
                config: { pageSize: 1000, abortSignal: discoverySignal, httpOptions: { timeout: 8000, retryOptions: { attempts: 1 } } },
            });
            const models = [];
            for await (const model of pager) {
                models.push(model);
                if (models.length >= 2000) break;
            }
            if (discoverySignal.aborted) throw new Error('Model discovery cancelled');
            entry.models = models;
            entry.signal = null;
            entry.pending = null;
            return entry;
        })();
        try {
            return await entry.pending;
        } catch (error) {
            if (cache.get(keyId(key)) === entry) cache.delete(keyId(key));
            throw error;
        }
    }
    return {
        async resolve({ apiKey, client, selected = '', kind = 'image', signal, fallback = false, exclude = [] }) {
            let entry = getEntry(apiKey);
            const id = choiceId(selected, kind);
            if (!fallback && entry?.choices.has(id)) return entry.choices.get(id);
            try {
                entry = await catalogue(apiKey, client, signal, fallback);
            } catch (error) {
                const classified = classifyGoogleError(error);
                if (signal?.aborted || fallback || ['authentication', 'quota', 'model', 'configuration'].includes(classified.code)) throw error;
                // Discovery failure must not disable a working configured model.
                const name = normalizeModelName(selected);
                return name && name.toLowerCase() !== 'auto' ? name : kind === 'live' ? DEFAULT_LIVE_MODEL : DEFAULT_IMAGE_MODEL;
            }
            return chooseModel(entry.models, {
                selected,
                kind,
                rejected: new Set([...(entry.rejected.get(kind) || []), ...exclude.map(normalizeModelName)]),
                fallback,
            });
        },
        remember(apiKey, selected, model, kind = 'image') {
            let entry = getEntry(apiKey);
            if (!entry) entry = putEntry(apiKey, { models: null, choices: new Map(), rejected: new Map(), expires: now() + 60000 });
            entry.choices.set(choiceId(selected, kind), normalizeModelName(model));
        },
        reject(apiKey, model, kind = 'image') {
            const entry = getEntry(apiKey);
            if (!entry) return;
            if (!entry.rejected.has(kind)) entry.rejected.set(kind, new Set());
            entry.rejected.get(kind).add(normalizeModelName(model));
            for (const [id, choice] of entry.choices) if (id.startsWith(`${kind}:`) && choice === normalizeModelName(model)) entry.choices.delete(id);
        },
    };
}

module.exports = { DEFAULT_IMAGE_MODEL, DEFAULT_LIVE_MODEL, normalizeModelName, chooseModel, createGeminiModelResolver };
