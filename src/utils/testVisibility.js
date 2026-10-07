// These percentages affect normal-session answers, not the separate Test Review marks.
const DEFAULT_TEST_VISIBILITY = Object.freeze({
    blindMode: false,
    answerTextOpacity: 100,
    answerFrameOpacity: 100,
    answerTextColor: '',
    answerPlacement: null,
    emphasizeAnswerLabels: true,
});

const ANSWER_PLACEMENT_LIMITS = Object.freeze({ minWidth: 320, minHeight: 120, maxWidth: 7680, maxHeight: 4320 });

function isOpacityPercent(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isAnswerTextColor(value) {
    return value === '' || (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value));
}

function isAnswerPlacement(value) {
    if (value === null) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return (
        Object.keys(value).every(key => ['displayId', 'x', 'y', 'width', 'height'].includes(key)) &&
        typeof value.displayId === 'string' &&
        /^[a-z0-9_-]{1,128}$/i.test(value.displayId) &&
        isOpacityPercent(value.x) &&
        isOpacityPercent(value.y) &&
        Number.isInteger(value.width) &&
        value.width >= ANSWER_PLACEMENT_LIMITS.minWidth &&
        value.width <= ANSWER_PLACEMENT_LIMITS.maxWidth &&
        Number.isInteger(value.height) &&
        value.height >= ANSWER_PLACEMENT_LIMITS.minHeight &&
        value.height <= ANSWER_PLACEMENT_LIMITS.maxHeight
    );
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
        answerTextColor: isAnswerTextColor(preferences.answerTextColor)
            ? preferences.answerTextColor.toLowerCase()
            : DEFAULT_TEST_VISIBILITY.answerTextColor,
        answerPlacement:
            preferences.answerPlacement && isAnswerPlacement(preferences.answerPlacement)
                ? { ...preferences.answerPlacement }
                : DEFAULT_TEST_VISIBILITY.answerPlacement,
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
    if (Object.hasOwn(preferences, 'answerTextColor') && !isAnswerTextColor(preferences.answerTextColor)) {
        throw new Error('Choose a valid answer text color.');
    }
    if (Object.hasOwn(preferences, 'answerPlacement') && !isAnswerPlacement(preferences.answerPlacement)) {
        throw new Error('Choose a valid answer position and size.');
    }
}

module.exports = {
    DEFAULT_TEST_VISIBILITY,
    ANSWER_PLACEMENT_LIMITS,
    isOpacityPercent,
    isAnswerTextColor,
    isAnswerPlacement,
    normalizeTestVisibility,
    validateTestVisibilityUpdate,
};
