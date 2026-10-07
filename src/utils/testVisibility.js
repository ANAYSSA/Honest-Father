// These percentages affect normal-session answers, not the separate Test Review marks.
const DEFAULT_TEST_VISIBILITY = Object.freeze({
    blindMode: false,
    answerTextOpacity: 100,
    answerFrameOpacity: 100,
    emphasizeAnswerLabels: true,
});

function isOpacityPercent(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function normalizeTestVisibility(value) {
    const preferences = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        blindMode: typeof preferences.blindMode === 'boolean' ? preferences.blindMode : DEFAULT_TEST_VISIBILITY.blindMode,
        answerTextOpacity: isOpacityPercent(preferences.answerTextOpacity)
            ? preferences.answerTextOpacity
            : DEFAULT_TEST_VISIBILITY.answerTextOpacity,
        answerFrameOpacity: isOpacityPercent(preferences.answerFrameOpacity)
            ? preferences.answerFrameOpacity
            : DEFAULT_TEST_VISIBILITY.answerFrameOpacity,
        emphasizeAnswerLabels:
            typeof preferences.emphasizeAnswerLabels === 'boolean'
                ? preferences.emphasizeAnswerLabels
                : DEFAULT_TEST_VISIBILITY.emphasizeAnswerLabels,
    };
}

function validateTestVisibilityUpdate(preferences) {
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw new Error('Preferences must be an object.');
    for (const key of ['blindMode', 'emphasizeAnswerLabels']) {
        if (Object.hasOwn(preferences, key) && typeof preferences[key] !== 'boolean') throw new Error(`${key} must be enabled or disabled.`);
    }
    for (const key of ['answerTextOpacity', 'answerFrameOpacity']) {
        if (Object.hasOwn(preferences, key) && !isOpacityPercent(preferences[key])) throw new Error('Answer opacity must be between 0% and 100%.');
    }
}

module.exports = { DEFAULT_TEST_VISIBILITY, isOpacityPercent, normalizeTestVisibility, validateTestVisibilityUpdate };
