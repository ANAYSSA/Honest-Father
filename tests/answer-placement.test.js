const test = require('node:test');
const assert = require('node:assert/strict');
const {
    copyDisplays,
    normalizeAnswerPlacement,
    boundsFromPlacement,
    placementFromBounds,
    chooseDisplay,
    clampBounds,
} = require('../src/utils/answerPlacement');

const displays = copyDisplays([
    { id: 1, label: 'Built-in', workArea: { x: 0, y: 25, width: 1440, height: 850 } },
    { id: -2, label: 'External', workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
]);
const fallback = { x: 100, y: 100, width: 1100, height: 800 };

test('answer geometry uses display-independent points and exact edge anchors on negative-coordinate monitors', () => {
    const placement = { displayId: '-2', x: 100, y: 100, width: 640, height: 240 };
    const result = boundsFromPlacement(placement, displays, fallback, '1');
    assert.deepEqual(result.bounds, { x: -640, y: 840, width: 640, height: 240 });
    assert.deepEqual(placementFromBounds(result.bounds, result.display), placement);
    const centered = boundsFromPlacement({ ...placement, x: 50, y: 50 }, displays, fallback, '1');
    assert.deepEqual(centered.bounds, { x: -1280, y: 420, width: 640, height: 240 });
});

test('missing displays preserve normalized positioning on a connected monitor and shrink oversized windows', () => {
    const placement = { displayId: 'gone', x: 100, y: 100, width: 7680, height: 4320 };
    const { bounds, display } = boundsFromPlacement(placement, displays, fallback, '1');
    assert.equal(display.id, '1');
    assert.deepEqual(bounds, { x: 0, y: 25, width: 1440, height: 850 });
    const small = [{ id: 'small', workArea: { x: 0, y: 0, width: 300, height: 100 } }];
    const fitted = boundsFromPlacement(placement, small, fallback, 'small');
    assert.deepEqual(fitted.bounds, { x: 0, y: 0, width: 300, height: 100 });
    assert.ok(
        normalizeAnswerPlacement(placementFromBounds(fitted.bounds, fitted.display)),
        'Tiny work areas do not produce invalid saved preferences'
    );
});

test('unset placement keeps existing geometry while malformed data cannot produce nonfinite native bounds', () => {
    assert.deepEqual(boundsFromPlacement(null, displays, fallback, '1').bounds, { x: 100, y: 75, width: 1100, height: 800 });
    for (const value of [
        false,
        [],
        {},
        { displayId: 1, x: 0, y: 0, width: 640, height: 240 },
        { displayId: '1', x: NaN, y: 0, width: 640, height: 240 },
        { displayId: '1', x: 101, y: 0, width: 640, height: 240 },
        { displayId: '1', x: 0, y: 0, width: 640.5, height: 240 },
    ]) {
        assert.equal(normalizeAnswerPlacement(value), null);
        assert.deepEqual(boundsFromPlacement(value, displays, fallback, '1').bounds, { x: 100, y: 75, width: 1100, height: 800 });
    }
});

test('monitor matching considers visible overlap and repeated off-screen moves clamp to the usable work area', () => {
    const selected = chooseDisplay(displays, null, { x: -1000, y: 200, width: 640, height: 240 }, '1');
    assert.equal(selected.id, '-2');
    assert.deepEqual(clampBounds({ x: -100000, y: -10000, width: 640, height: 240 }, selected), { x: -1920, y: 0, width: 640, height: 240 });
    assert.deepEqual(clampBounds({ x: 100000, y: 10000, width: 640, height: 240 }, selected), { x: -640, y: 840, width: 640, height: 240 });
    assert.throws(() => chooseDisplay([], null, fallback, '1'), /No display/);
});
