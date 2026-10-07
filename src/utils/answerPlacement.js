const { ANSWER_PLACEMENT_LIMITS, isAnswerPlacement } = require('./testVisibility');
const MIN_ANSWER_SIZE = Object.freeze({ width: ANSWER_PLACEMENT_LIMITS.minWidth, height: ANSWER_PLACEMENT_LIMITS.minHeight });
const MAX_ANSWER_SIZE = Object.freeze({ width: ANSWER_PLACEMENT_LIMITS.maxWidth, height: ANSWER_PLACEMENT_LIMITS.maxHeight });

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function normalizeAnswerPlacement(value) {
    if (!value || !isAnswerPlacement(value)) return null;
    return { displayId: value.displayId, x: value.x, y: value.y, width: value.width, height: value.height };
}

function copyDisplays(displays) {
    return displays
        .filter(display => display && display.workArea && ['x', 'y', 'width', 'height'].every(key => finite(display.workArea[key])))
        .filter(display => display.workArea.width > 0 && display.workArea.height > 0)
        .map((display, index) => ({
            id: String(display.id),
            label: typeof display.label === 'string' && display.label.trim() ? display.label : `Display ${index + 1}`,
            workArea: { ...display.workArea },
        }));
}

function overlapArea(bounds, area) {
    return (
        Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)) *
        Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y))
    );
}

function chooseDisplay(displays, displayId, bounds, primaryDisplayId) {
    if (!displays.length) throw new Error('No display is available for the answer window.');
    const requested = displays.find(display => display.id === String(displayId));
    if (requested) return requested;
    if (bounds) {
        const visible = [...displays].sort((a, b) => overlapArea(bounds, b.workArea) - overlapArea(bounds, a.workArea));
        if (overlapArea(bounds, visible[0].workArea) > 0) return visible[0];
    }
    return displays.find(display => display.id === String(primaryDisplayId)) || displays[0];
}

function clampBounds(bounds, display, minimum = MIN_ANSWER_SIZE) {
    const area = display.workArea;
    const width = Math.round(clamp(bounds.width, Math.min(minimum.width, area.width), area.width));
    const height = Math.round(clamp(bounds.height, Math.min(minimum.height, area.height), area.height));
    return {
        x: Math.round(clamp(bounds.x, area.x, area.x + area.width - width)),
        y: Math.round(clamp(bounds.y, area.y, area.y + area.height - height)),
        width,
        height,
    };
}

function boundsFromPlacement(placement, displays, fallbackBounds, primaryDisplayId) {
    const normalized = normalizeAnswerPlacement(placement);
    const display = chooseDisplay(displays, normalized?.displayId, fallbackBounds, primaryDisplayId);
    if (!normalized) return { display, bounds: clampBounds(fallbackBounds, display) };
    const bounds = clampBounds({ x: display.workArea.x, y: display.workArea.y, width: normalized.width, height: normalized.height }, display);
    bounds.x = Math.round(display.workArea.x + ((display.workArea.width - bounds.width) * normalized.x) / 100);
    bounds.y = Math.round(display.workArea.y + ((display.workArea.height - bounds.height) * normalized.y) / 100);
    return { display, bounds };
}

function placementFromBounds(bounds, display) {
    const fitted = clampBounds(bounds, display);
    const horizontalTravel = display.workArea.width - fitted.width;
    const verticalTravel = display.workArea.height - fitted.height;
    return {
        displayId: display.id,
        x: horizontalTravel > 0 ? ((fitted.x - display.workArea.x) / horizontalTravel) * 100 : 0,
        y: verticalTravel > 0 ? ((fitted.y - display.workArea.y) / verticalTravel) * 100 : 0,
        // Keep a valid saved size even when an unusually small display forces a smaller native window.
        width: Math.max(MIN_ANSWER_SIZE.width, Math.min(MAX_ANSWER_SIZE.width, fitted.width)),
        height: Math.max(MIN_ANSWER_SIZE.height, Math.min(MAX_ANSWER_SIZE.height, fitted.height)),
    };
}

module.exports = {
    MIN_ANSWER_SIZE,
    MAX_ANSWER_SIZE,
    normalizeAnswerPlacement,
    copyDisplays,
    chooseDisplay,
    clampBounds,
    boundsFromPlacement,
    placementFromBounds,
};
