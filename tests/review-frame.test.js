const test = require('node:test');
const assert = require('node:assert/strict');
const { inflateSync } = require('node:zlib');
const { isReviewFrameUnchanged, createReviewFrameTracker } = require('../src/utils/reviewFrame');

function frame(width = 800, height = 600, color = 248) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
        data[index] = data[index + 1] = data[index + 2] = color;
        data[index + 3] = 255;
    }
    return { width, height, data };
}

function copy(source) {
    return { width: source.width, height: source.height, data: source.data.slice() };
}

function rectangle(image, x, y, width, height, color = [12, 12, 12]) {
    for (let py = Math.max(0, y); py < Math.min(image.height, y + height); py++) {
        for (let px = Math.max(0, x); px < Math.min(image.width, x + width); px++) {
            const index = (py * image.width + px) * 4;
            image.data[index] = color[0];
            image.data[index + 1] = color[1];
            image.data[index + 2] = color[2];
        }
    }
}

function text(image, x, y, seed, characters = 32, scale = 2) {
    // Deterministic distinct glyph-shaped texture: no image/OCR dependencies.
    for (let character = 0; character < characters; character++) {
        for (let row = 0; row < 7; row++) {
            for (let col = 0; col < 5; col++) {
                const bit = ((seed + character * 7919 + row * 104729 + col * 1723) ^ (character * 13 + row * 31 + col * 71)) % 17 < 8;
                if (bit) rectangle(image, x + character * 6 * scale + col * scale, y + row * scale, scale, scale);
            }
        }
    }
}

function fixture() {
    const image = frame();
    text(image, 195, 105, 59, 30);
    text(image, 195, 130, 211, 24);
    text(image, 215, 205, 683, 27);
    text(image, 215, 250, 1237, 24);
    text(image, 215, 295, 4051, 29);
    text(image, 215, 340, 7727, 22);
    rectangle(image, 176, 270, 14, 12);
    const answer = {
        questionBox: [150, 200, 650, 800],
        answers: [{ label: 'C', box: [450, 220, 470, 240] }],
        confidence: 0.95,
    };
    return { image, answer };
}

function translate(source, dx, dy, questionBox = [150, 200, 650, 800]) {
    const result = frame(source.width, source.height, source.data[0]);
    const [top, left, bottom, right] = questionBox;
    for (let y = Math.floor((top * source.height) / 1000); y < Math.ceil((bottom * source.height) / 1000); y++) {
        for (let x = Math.floor((left * source.width) / 1000); x < Math.ceil((right * source.width) / 1000); x++) {
            if (x + dx < 0 || y + dy < 0 || x + dx >= result.width || y + dy >= result.height) continue;
            const a = (y * source.width + x) * 4;
            const b = ((y + dy) * result.width + x + dx) * 4;
            result.data.set(source.data.subarray(a, a + 4), b);
        }
    }
    return result;
}

test('the pending guard accepts identical frames and small RGB noise without mutating its inputs', () => {
    const { image, answer } = fixture();
    const noisy = copy(image);
    for (let index = 0; index < noisy.data.length; index += 4) {
        noisy.data[index] = Math.max(0, noisy.data[index] - 2);
        noisy.data[index + 1] = Math.min(255, noisy.data[index + 1] + 2);
    }
    assert.equal(isReviewFrameUnchanged(image, image, answer), true);
    assert.equal(isReviewFrameUnchanged(image, noisy, answer), true);
    assert.equal(image.data[0], 248);
});

test('a small changed question word invalidates a frame even though it occupies less than 2% of the region', () => {
    const { image, answer } = fixture();
    const changed = copy(image);
    rectangle(changed, 280, 104, 42, 17, [248, 248, 248]);
    text(changed, 280, 104, 8839, 3);
    assert.equal(isReviewFrameUnchanged(image, changed, answer), false);
});

test('erasing a tiny stem glyph with 15 changed foreground pixels refuses stale marks even on a stable-position fast path', () => {
    const { image, answer } = fixture();
    const changed = copy(image);
    rectangle(changed, 213, 105, 3, 7, [248, 248, 248]);
    let changedPixels = 0;
    for (let index = 0; index < image.data.length; index += 4) {
        if (image.data[index] !== changed.data[index]) changedPixels++;
    }
    assert.equal(changedPixels, 15);
    assert.equal(isReviewFrameUnchanged(image, changed, answer), false);
    const tracker = createReviewFrameTracker(image, answer);
    assert.equal(tracker.locate(image).state, 'matched');
    assert.equal(tracker.locate(changed).state, 'hidden');
    assert.equal(tracker.locate(image).state, 'matched');
});

test('the control mask ignores its own ring without masking neighboring option text or the full row', () => {
    const { image, answer } = fixture();
    const ring = copy(image);
    rectangle(ring, 168, 262, 32, 28, [0, 255, 90]);
    assert.equal(isReviewFrameUnchanged(image, ring, answer), true);
    rectangle(ring, 220, 268, 30, 14, [0, 255, 90]);
    assert.equal(isReviewFrameUnchanged(image, ring, answer), false);
});

test('pixels outside the question region do not invalidate a cached answer', () => {
    const { image, answer } = fixture();
    const changed = copy(image);
    rectangle(changed, 20, 20, 100, 60, [0, 50, 200]);
    assert.equal(isReviewFrameUnchanged(image, changed, answer), true);
});

test('invalid buffers, dimension changes, tiny regions, and oversized control masks fail closed', () => {
    const { image, answer } = fixture();
    for (const current of [null, { ...image, data: [] }, { ...image, data: new Uint8Array(10) }, frame(801, 600)]) {
        assert.equal(isReviewFrameUnchanged(image, current, answer), false);
    }
    for (const badAnswer of [
        null,
        { ...answer, questionBox: [150, 200, 160, 210] },
        { ...answer, questionBox: [150, 200, 650, 1001] },
        { ...answer, confidence: 0.7 },
        { ...answer, answers: [{ label: 'C', box: [400, 220, 600, 450] }] },
        { ...answer, answers: [{ label: 'C', box: [50, 220, 60, 240] }] },
    ]) {
        assert.equal(isReviewFrameUnchanged(image, image, badAnswer), false);
        assert.equal(createReviewFrameTracker(image, badAnswer).locate(image).state, 'hidden');
    }
    const masked = { ...answer, questionBox: [430, 210, 490, 255] };
    assert.equal(isReviewFrameUnchanged(image, image, masked), false);
    assert.equal(isReviewFrameUnchanged(image, translate(image, 0, 36), answer), false);
});

test('cached local tracking returns normalized translations in both vertical directions and a small horizontal shift', () => {
    const { image, answer } = fixture();
    const tracker = createReviewFrameTracker(image, answer);
    assert.equal(tracker.locate(image).state, 'matched');
    for (const [dx, dy] of [
        [0, 36],
        [0, -48],
        [11, 72],
        [-9, -31],
    ]) {
        const located = tracker.locate(translate(image, dx, dy));
        assert.equal(located.state, 'matched', `${dx},${dy}`);
        assert.deepEqual(located.offset, { x: (dx * 1000) / image.width, y: (dy * 1000) / image.height });
        assert.deepEqual(
            located.reviewAnswer.answers[0].box,
            answer.answers[0].box.map((value, index) => value + (index % 2 ? located.offset.x : located.offset.y))
        );
        assert.deepEqual(answer.questionBox, [150, 200, 650, 800]);
    }
});

test('a question temporarily offscreen hides marks and restores them from the same cache on scrolling back', () => {
    const { image, answer } = fixture();
    const tracker = createReviewFrameTracker(image, answer);
    assert.equal(tracker.locate(image).state, 'matched');
    assert.deepEqual(tracker.locate(translate(image, 0, 240)), { state: 'hidden', reason: 'offscreen' });
    assert.equal(tracker.locate(frame()).state, 'hidden');
    const returned = tracker.locate(translate(image, 0, 60));
    assert.equal(returned.state, 'matched');
    assert.deepEqual(returned.offset, { x: 0, y: 100 });
});

test('changing the question stem or choice text after scrolling refuses stale annotations', () => {
    const { image, answer } = fixture();
    for (const [x, y] of [
        [280, 104],
        [330, 250],
    ]) {
        const tracker = createReviewFrameTracker(image, answer);
        const changed = translate(image, 0, 60);
        rectangle(changed, x, y + 60, 42, 17, [248, 248, 248]);
        text(changed, x, y + 60, 9911, 3);
        assert.equal(tracker.locate(changed).state, 'hidden');
    }
});

test('tracking ignores the previous captured ring during a scroll and does not turn controls into row masks', () => {
    const { image, answer } = fixture();
    const tracker = createReviewFrameTracker(image, answer);
    assert.equal(tracker.locate(image).state, 'matched');
    const scrolled = translate(image, 0, 60);
    rectangle(scrolled, 168, 262, 32, 28, [0, 255, 90]);
    const result = tracker.locate(scrolled);
    assert.equal(result.state, 'matched');
    assert.deepEqual(result.offset, { x: 0, y: 100 });
});

test('untextured screens and ambiguous repeated questions cannot acquire an annotation', () => {
    const { answer } = fixture();
    assert.equal(createReviewFrameTracker(frame(), answer).locate(frame()).state, 'hidden');
    const image = frame(800, 1000);
    text(image, 190, 40, 211, 28);
    text(image, 210, 100, 683, 24);
    text(image, 210, 145, 4051, 27);
    const repeatedAnswer = { ...answer, questionBox: [20, 200, 190, 800], answers: [{ label: 'C', box: [135, 220, 150, 240] }] };
    const duplicated = translate(image, 0, 0, repeatedAnswer.questionBox);
    const second = translate(image, 0, 240, repeatedAnswer.questionBox);
    for (let y = 260; y < 430; y++) {
        duplicated.data.set(second.data.subarray(y * 800 * 4, (y + 1) * 800 * 4), y * 800 * 4);
    }
    assert.equal(createReviewFrameTracker(image, repeatedAnswer).locate(duplicated).state, 'hidden');
});

test('tracking owns immutable pixels and reports bounded cache memory for retention policy', () => {
    const { image, answer } = fixture();
    const original = copy(image);
    const tracker = createReviewFrameTracker(image, answer);
    assert.ok(tracker.retainedBytes >= image.data.byteLength);
    assert.ok(tracker.retainedBytes <= image.data.byteLength + 640 * 640 + 5 * 12 * 12 * 96 + 2048 * 64 + 1024);
    rectangle(image, 200, 105, 400, 30, [248, 248, 248]);
    assert.equal(tracker.locate(original).state, 'matched');
    assert.equal(tracker.locate(image).state, 'hidden');
    assert.equal(tracker.locate(frame(400, 300)).state, 'hidden');
});

test('a changed tiny word between uniform sample rows is caught by text-edge features across a large question', () => {
    const image = frame(1920, 1200);
    text(image, 180, 100, 59, 30, 2);
    text(image, 205, 300, 683, 27, 2);
    text(image, 205, 610, 1237, 24, 2);
    text(image, 205, 850, 4051, 29, 2);
    text(image, 700, 150, 7727, 4, 1);
    const answer = {
        questionBox: [50, 50, 950, 950],
        answers: [{ label: 'C', box: [700, 80, 710, 90] }],
        confidence: 0.95,
    };
    const changed = copy(image);
    rectangle(changed, 700, 150, 24, 7, [248, 248, 248]);
    assert.equal(isReviewFrameUnchanged(image, changed, answer), false);
    const tracker = createReviewFrameTracker(image, answer);
    assert.equal(tracker.locate(image).state, 'matched');
    assert.equal(tracker.locate(changed).state, 'hidden');
});

test('stable position reuse still checks changed choice text and keeps an immutable answer geometry', () => {
    const { image, answer } = fixture();
    const tracker = createReviewFrameTracker(image, answer);
    assert.equal(tracker.locate(image).state, 'matched');
    answer.questionBox[0] = 0;
    answer.answers[0].box[0] = 0;
    const unchanged = tracker.locate(image);
    assert.equal(unchanged.state, 'matched');
    assert.deepEqual(unchanged.reviewAnswer.questionBox, [150, 200, 650, 800]);
    assert.deepEqual(unchanged.reviewAnswer.answers[0].box, [450, 220, 470, 240]);
    const changed = copy(image);
    rectangle(changed, 330, 250, 42, 17, [248, 248, 248]);
    text(changed, 330, 250, 9991, 3);
    assert.equal(tracker.locate(changed).state, 'hidden');
});

test('Retina capture pixels determine movement without applying a display scale or global monitor origin', () => {
    const { image, answer } = fixture();
    const doubled = frame(1600, 1200);
    for (let y = 0; y < doubled.height; y++) {
        for (let x = 0; x < doubled.width; x++) {
            const index = (Math.floor(y / 2) * image.width + Math.floor(x / 2)) * 4;
            doubled.data.set(image.data.subarray(index, index + 4), (y * doubled.width + x) * 4);
        }
    }
    const result = createReviewFrameTracker(doubled, answer).locate(translate(doubled, 0, 120));
    assert.equal(result.state, 'matched');
    assert.deepEqual(result.offset, { x: 0, y: 100 });
});

test('real browser Arial glyphs acquire and track exact 61-pixel scrolling, both directly and after a previous match', () => {
    // Synthetic canvas text exported from the isolated Electron smoke, never a user screen.
    const fixture = require('./fixtures/review-browser-text.json');
    const image = {
        width: fixture.width,
        height: fixture.height,
        data: new Uint8ClampedArray(inflateSync(Buffer.from(fixture.rgbaDeflateBase64, 'base64'))),
    };
    const answer = {
        questionBox: [100, 100, 650, 900],
        answers: [{ label: 'B', box: [390, 128, 418, 152] }],
        confidence: 0.95,
    };
    for (const dy of [61, -61]) {
        const moved = translate(image, 0, dy, [0, 0, 1000, 1000]);
        const tracker = createReviewFrameTracker(image, answer);
        const standalone = tracker.locate(moved);
        assert.equal(standalone.state, 'matched');
        assert.deepEqual(standalone.offset, { x: 0, y: (dy * 1000) / image.height });
        assert.equal(tracker.locate(image).state, 'matched');
        const again = tracker.locate(moved);
        assert.equal(again.state, 'matched');
        assert.deepEqual(again.offset, standalone.offset);
    }
});
