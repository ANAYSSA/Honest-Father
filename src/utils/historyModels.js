// History records resolved provider choices, never credentials or guessed models.
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function label(value) {
    return typeof value === 'string'
        ? value
              .replace(/[\u0000-\u001f\u007f]/g, '')
              .trim()
              .slice(0, 200)
        : '';
}

function normalizeModelInfo(value) {
    if (!value || typeof value !== 'object') return null;
    const provider = label(value.provider);
    const modelId = label(value.modelId);
    if (!provider || !modelId || modelId === 'auto') return null;
    const result = { provider, modelId, displayName: label(value.displayName) || modelId };
    if (['standard', 'pro'].includes(value.reasoningMode)) result.reasoningMode = value.reasoningMode;
    if (REASONING_EFFORTS.has(value.reasoningEffort)) result.reasoningEffort = value.reasoningEffort;
    return result;
}

function mergeModelsUsed(...lists) {
    const result = [];
    const seen = new Set();
    for (const value of lists.flat()) {
        const model = normalizeModelInfo(value);
        if (!model) continue;
        const key = JSON.stringify([model.provider, model.modelId, model.reasoningMode, model.reasoningEffort]);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(model);
    }
    return result;
}

function chatGPTModelInfo(model, reasoningMode = 'standard') {
    return normalizeModelInfo({
        provider: 'chatgpt',
        modelId: model.id,
        displayName: model.name,
        reasoningMode,
        reasoningEffort: reasoningMode === 'standard' ? model.fastReasoningEffort : undefined,
    });
}

module.exports = { normalizeModelInfo, mergeModelsUsed, chatGPTModelInfo };
