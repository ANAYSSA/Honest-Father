const DEFAULT_REVIEW_APPEARANCE = Object.freeze({ color: '#16a34a', opacity: 1 });
const MIN_REVIEW_MARKER_OPACITY = 0.1;

function isReviewMarkerColor(value) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function isReviewMarkerOpacity(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= MIN_REVIEW_MARKER_OPACITY && value <= 1;
}

function normalizeReviewAppearance(value) {
    const appearance = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        color: isReviewMarkerColor(appearance.color) ? appearance.color.toLowerCase() : DEFAULT_REVIEW_APPEARANCE.color,
        opacity: isReviewMarkerOpacity(appearance.opacity) ? appearance.opacity : DEFAULT_REVIEW_APPEARANCE.opacity,
    };
}

function reviewAppearanceFromPreferences(preferences) {
    return normalizeReviewAppearance({ color: preferences?.reviewMarkerColor, opacity: preferences?.reviewMarkerOpacity });
}

module.exports = {
    DEFAULT_REVIEW_APPEARANCE,
    MIN_REVIEW_MARKER_OPACITY,
    isReviewMarkerColor,
    isReviewMarkerOpacity,
    normalizeReviewAppearance,
    reviewAppearanceFromPreferences,
};
