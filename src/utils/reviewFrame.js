const MAX_GRID_SAMPLES = 8192;
const MAX_DETAIL_SAMPLES = 2048;
const MAX_GRAY_DIMENSION = 640;
const MAX_COARSE_CANDIDATES = 48;
const MAX_FINE_PROBES = 4096;
const MAX_FULL_COMPARISONS = 8;
const MAX_DENSE_PIXELS = 16 * 1024 * 1024;
const ANCHOR_SIZE = 12;
const MAX_CONTROL_SIZE = 80;

function validFrame(frame) {
    return (
        frame &&
        Number.isInteger(frame.width) &&
        Number.isInteger(frame.height) &&
        frame.width > 0 &&
        frame.height > 0 &&
        frame.width <= 16384 &&
        frame.height <= 16384 &&
        frame.width * frame.height <= MAX_DENSE_PIXELS &&
        (frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray) &&
        frame.data.length === frame.width * frame.height * 4
    );
}

function validBox(box) {
    return (
        Array.isArray(box) &&
        box.length === 4 &&
        box.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000) &&
        box[2] > box[0] &&
        box[3] > box[1]
    );
}

function geometry(frame, answer) {
    if (
        !answer ||
        !validBox(answer.questionBox) ||
        !Array.isArray(answer.answers) ||
        answer.answers.length < 1 ||
        answer.answers.length > 8 ||
        typeof answer.confidence !== 'number' ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence < 0.8 ||
        answer.confidence > 1
    )
        return null;
    const [top, left, bottom, right] = answer.questionBox;
    const question = {
        left: Math.floor((left * frame.width) / 1000),
        top: Math.floor((top * frame.height) / 1000),
        right: Math.ceil((right * frame.width) / 1000),
        bottom: Math.ceil((bottom * frame.height) / 1000),
    };
    question.width = question.right - question.left;
    question.height = question.bottom - question.top;
    if (question.width < 24 || question.height < 24 || question.width * question.height < 1024) return null;
    // Scale the small ring margin with captured pixels, rather than Electron DIP.
    const padding = Math.max(10, Math.ceil(Math.max(frame.width, frame.height) / 100));
    const masks = [];
    for (const option of answer.answers) {
        if (!option || !validBox(option.box)) return null;
        const [optionTop, optionLeft, optionBottom, optionRight] = option.box;
        if (
            optionBottom - optionTop > MAX_CONTROL_SIZE ||
            optionRight - optionLeft > MAX_CONTROL_SIZE ||
            optionTop < top ||
            optionLeft < left ||
            optionBottom > bottom ||
            optionRight > right
        ) {
            return null;
        }
        masks.push({
            left: (optionLeft * frame.width) / 1000 - padding,
            top: (optionTop * frame.height) / 1000 - padding,
            right: (optionRight * frame.width) / 1000 + padding,
            bottom: (optionBottom * frame.height) / 1000 + padding,
        });
    }
    return { question, masks };
}

function insideMask(x, y, masks, offset = { x: 0, y: 0 }) {
    return masks.some(mask => x >= mask.left + offset.x && x < mask.right + offset.x && y >= mask.top + offset.y && y < mask.bottom + offset.y);
}

function grayAt(frame, x, y) {
    const index = (y * frame.width + x) * 4;
    return (frame.data[index] * 77 + frame.data[index + 1] * 150 + frame.data[index + 2] * 29) >> 8;
}

function denseQuestionMatches(snapshot, current, sourceGeometry, offset, previousOffset, budget) {
    const { question } = sourceGeometry;
    const masks = [...sourceGeometry.masks];
    if (previousOffset) {
        for (const mask of sourceGeometry.masks) {
            masks.push({
                left: mask.left + previousOffset.x - offset.x,
                right: mask.right + previousOffset.x - offset.x,
                top: mask.top + previousOffset.y - offset.y,
                bottom: mask.bottom + previousOffset.y - offset.y,
            });
        }
    }
    masks.sort((a, b) => a.left - b.left);
    const before = snapshot.data;
    const after = current.data;
    let changed = 0;
    let cursor = 0;
    let beforeRow = 0;
    let afterRow = 0;
    const scan = end => {
        const pixels = end - cursor;
        if (pixels > budget.remaining) {
            budget.remaining = 0;
            return false;
        }
        budget.remaining -= pixels;
        let a = beforeRow + cursor * 4;
        let b = afterRow + (cursor + offset.x) * 4;
        for (; cursor < end; cursor++, a += 4, b += 4) {
            if (Math.abs(before[a] - after[b]) > 40 || Math.abs(before[a + 1] - after[b + 1]) > 40 || Math.abs(before[a + 2] - after[b + 2]) > 40) {
                if (++changed >= 8) return false;
            }
        }
        return true;
    };
    for (let y = question.top; y < question.bottom; y++) {
        beforeRow = y * snapshot.width * 4;
        afterRow = (y + offset.y) * current.width * 4;
        cursor = question.left;
        // Sorted intervals merge as the cursor advances; controls never mask a row.
        for (const mask of masks) {
            if (y < mask.top || y >= mask.bottom || mask.right <= cursor || mask.left >= question.right) continue;
            if (!scan(Math.min(question.right, Math.max(cursor, Math.ceil(mask.left))))) return false;
            cursor = Math.min(question.right, Math.max(cursor, Math.ceil(mask.right)));
        }
        if (!scan(question.right)) return false;
    }
    return true;
}

function compareQuestion(snapshot, current, sourceGeometry, offset, previousOffset = null, features = [], budget = { remaining: MAX_DENSE_PIXELS }) {
    const { question, masks } = sourceGeometry;
    if (
        question.left + offset.x < 0 ||
        question.top + offset.y < 0 ||
        question.right + offset.x > current.width ||
        question.bottom + offset.y > current.height
    ) {
        return false;
    }
    const cols = Math.min(question.width, Math.max(1, Math.floor(Math.sqrt((MAX_GRID_SAMPLES * question.width) / question.height))));
    const rows = Math.min(question.height, Math.max(1, Math.floor(MAX_GRID_SAMPLES / cols)));
    const tilesAcross = Math.ceil(cols / 4);
    const tileSamples = new Uint8Array(tilesAcross * Math.ceil(rows / 4));
    const tileChanges = new Uint8Array(tileSamples.length);
    const changedPoints = [];
    let samples = 0;
    let changes = 0;
    let difference = 0;
    const masked = (x, y) => insideMask(x, y, masks) || (previousOffset && insideMask(x + offset.x, y + offset.y, masks, previousOffset));
    const pixelDifference = (x, y) => {
        const a = (y * snapshot.width + x) * 4;
        const b = ((y + offset.y) * current.width + x + offset.x) * 4;
        const red = Math.abs(snapshot.data[a] - current.data[b]);
        const green = Math.abs(snapshot.data[a + 1] - current.data[b + 1]);
        const blue = Math.abs(snapshot.data[a + 2] - current.data[b + 2]);
        return { changed: Math.max(red, green, blue) > 40, average: (red + green + blue) / 3 };
    };
    for (let row = 0; row < rows; row++) {
        const y = question.top + Math.floor(((row + 0.5) * question.height) / rows);
        for (let col = 0; col < cols; col++) {
            const x = question.left + Math.floor(((col + 0.5) * question.width) / cols);
            if (masked(x, y)) continue;
            const tile = Math.floor(row / 4) * tilesAcross + Math.floor(col / 4);
            const pixel = pixelDifference(x, y);
            samples++;
            tileSamples[tile]++;
            difference += pixel.average;
            if (pixel.changed) {
                changes++;
                tileChanges[tile]++;
                if (changedPoints.length < MAX_DETAIL_SAMPLES / 64) changedPoints.push({ x, y });
            }
        }
    }
    if (samples < 256 || samples < cols * rows * 0.5 || changes / samples > 0.02 || difference / samples > 3) return false;
    for (let tile = 0; tile < tileSamples.length; tile++) {
        if (tileChanges[tile] >= 3 && tileChanges[tile] / tileSamples[tile] >= 0.12) return false;
    }
    // Fixed text-edge features cover small words between the regular grid points.
    let changedFeatures = 0;
    for (const feature of features) {
        if (masked(feature.x, feature.y)) continue;
        if (pixelDifference(feature.x, feature.y).changed) {
            if (++changedFeatures >= 3) return false;
            if (changedPoints.length < MAX_DETAIL_SAMPLES / 64) changedPoints.push(feature);
        }
    }
    // A small changed word can occupy much less than 2% of a large question.
    // Inspect short neighborhoods around changed samples, with a fixed budget.
    for (const point of changedPoints) {
        let localChanges = 0;
        for (let dy = -4; dy < 4; dy++) {
            for (let dx = -4; dx < 4; dx++) {
                const x = point.x + dx;
                const y = point.y + dy;
                if (x < question.left || y < question.top || x >= question.right || y >= question.bottom || masked(x, y)) continue;
                if (pixelDifference(x, y).changed && ++localChanges >= 8) return false;
            }
        }
    }
    return denseQuestionMatches(snapshot, current, sourceGeometry, offset, previousOffset, budget);
}

function isReviewFrameUnchanged(snapshotImageData, currentImageData, reviewAnswer) {
    if (
        !validFrame(snapshotImageData) ||
        !validFrame(currentImageData) ||
        snapshotImageData.width !== currentImageData.width ||
        snapshotImageData.height !== currentImageData.height
    ) {
        return false;
    }
    const sourceGeometry = geometry(snapshotImageData, reviewAnswer);
    if (!sourceGeometry) return false;
    const features = selectFeatures(grayscale(snapshotImageData), sourceGeometry);
    return compareQuestion(snapshotImageData, currentImageData, sourceGeometry, { x: 0, y: 0 }, null, features);
}

function grayscale(frame) {
    const scale = Math.min(1, MAX_GRAY_DIMENSION / Math.max(frame.width, frame.height));
    const width = Math.max(1, Math.round(frame.width * scale));
    const height = Math.max(1, Math.round(frame.height * scale));
    const data = new Uint8Array(width * height);
    const scaleX = frame.width / width;
    const scaleY = frame.height / height;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            data[y * width + x] = grayAt(
                frame,
                Math.min(frame.width - 1, Math.floor((x + 0.5) * scaleX)),
                Math.min(frame.height - 1, Math.floor((y + 0.5) * scaleY))
            );
        }
    }
    return { width, height, data, scaleX, scaleY };
}

function selectFeatures(gray, sourceGeometry) {
    const { question, masks } = sourceGeometry;
    const left = Math.ceil(question.left / gray.scaleX);
    const top = Math.ceil(question.top / gray.scaleY);
    const right = Math.floor(question.right / gray.scaleX);
    const bottom = Math.floor(question.bottom / gray.scaleY);
    const cols = Math.min(32, right - left);
    const rows = Math.min(32, bottom - top);
    const features = [];
    const seen = new Set();
    const add = (x, y) => {
        const pixel = { x: Math.floor((x + 0.5) * gray.scaleX), y: Math.floor((y + 0.5) * gray.scaleY) };
        const key = pixel.y * Math.round(gray.width * gray.scaleX) + pixel.x;
        if (!insideMask(pixel.x, pixel.y, masks) && !seen.has(key)) {
            features.push(pixel);
            seen.add(key);
        }
    };
    // Two sides of the strongest edge in each cell: at most 2048 pixels.
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const cellLeft = left + Math.floor((col * (right - left)) / cols);
            const cellRight = left + Math.floor(((col + 1) * (right - left)) / cols);
            const cellTop = top + Math.floor((row * (bottom - top)) / rows);
            const cellBottom = top + Math.floor(((row + 1) * (bottom - top)) / rows);
            let best = null;
            for (let y = Math.max(top + 1, cellTop); y < cellBottom; y++) {
                for (let x = Math.max(left + 1, cellLeft); x < cellRight; x++) {
                    const px = Math.floor((x + 0.5) * gray.scaleX);
                    const py = Math.floor((y + 0.5) * gray.scaleY);
                    if (insideMask(px, py, masks)) continue;
                    const value = gray.data[y * gray.width + x];
                    const horizontal = Math.abs(value - gray.data[y * gray.width + x - 1]);
                    const vertical = Math.abs(value - gray.data[(y - 1) * gray.width + x]);
                    const strength = Math.max(horizontal, vertical);
                    if (strength >= 28 && (!best || strength > best.strength)) best = { x, y, strength, horizontal: horizontal >= vertical };
                }
            }
            if (!best) continue;
            add(best.x, best.y);
            add(best.x - (best.horizontal ? 1 : 0), best.y - (best.horizontal ? 0 : 1));
        }
    }
    return features;
}

function selectAnchors(gray, sourceGeometry) {
    const { question, masks } = sourceGeometry;
    const candidates = [];
    const left = Math.ceil(question.left / gray.scaleX);
    const top = Math.ceil(question.top / gray.scaleY);
    const right = Math.floor(question.right / gray.scaleX);
    const bottom = Math.floor(question.bottom / gray.scaleY);
    for (let y = top; y + ANCHOR_SIZE <= bottom; y += 6) {
        for (let x = left; x + ANCHOR_SIZE <= right; x += 6) {
            if (
                masks.some(
                    mask =>
                        x * gray.scaleX < mask.right &&
                        (x + ANCHOR_SIZE) * gray.scaleX > mask.left &&
                        y * gray.scaleY < mask.bottom &&
                        (y + ANCHOR_SIZE) * gray.scaleY > mask.top
                )
            ) {
                continue;
            }
            let sum = 0;
            let squares = 0;
            let edges = 0;
            let minimum = 255;
            let maximum = 0;
            const points = [];
            for (let ay = 0; ay < ANCHOR_SIZE; ay++) {
                for (let ax = 0; ax < ANCHOR_SIZE; ax++) {
                    const value = gray.data[(y + ay) * gray.width + x + ax];
                    const gradient = ax ? Math.abs(value - gray.data[(y + ay) * gray.width + x + ax - 1]) : 0;
                    sum += value;
                    squares += value * value;
                    minimum = Math.min(minimum, value);
                    maximum = Math.max(maximum, value);
                    if (gradient > 20) edges++;
                    points.push({ x: x + ax, y: y + ay, value, gradient });
                }
            }
            const count = ANCHOR_SIZE * ANCHOR_SIZE;
            const variance = squares / count - (sum / count) ** 2;
            if (variance < 180 || edges < 10) continue;
            points.sort((a, b) => b.gradient - a.gradient);
            candidates.push({ x, y, points, contrast: maximum - minimum, score: variance + edges * 20 });
        }
    }
    candidates.sort((a, b) => b.score - a.score);
    const height = bottom - top;
    const stem = candidates.find(anchor => anchor.y + ANCHOR_SIZE / 2 < top + height * 0.4);
    const choices = candidates.find(anchor => anchor.y + ANCHOR_SIZE / 2 > top + height * 0.5);
    if (!stem || !choices) return [];
    const anchors = [stem, choices];
    for (const candidate of candidates) {
        if (anchors.every(anchor => Math.abs(candidate.x - anchor.x) >= ANCHOR_SIZE * 1.5 || Math.abs(candidate.y - anchor.y) >= ANCHOR_SIZE * 1.5)) {
            anchors.push(candidate);
            if (anchors.length === 5) break;
        }
    }
    return anchors.length >= 3 ? anchors : [];
}

function anchorMatches(anchor, readPixel, offset, sourceGeometry, previousOffset, scaleX, scaleY, coarse = false) {
    const maxChangedFraction = coarse ? 0.35 : 0.06;
    const maxAverageDifference = coarse ? 50 : 7;
    let count = 0;
    let difference = 0;
    let changes = 0;
    let minimum = 255;
    let maximum = 0;
    for (const point of anchor.points) {
        const x = Math.floor((point.x + 0.5) * scaleX) + offset.x;
        const y = Math.floor((point.y + 0.5) * scaleY) + offset.y;
        if (previousOffset && insideMask(x, y, sourceGeometry.masks, previousOffset)) continue;
        const current = readPixel(point, x, y);
        if (current === null) return false;
        const delta = Math.abs(point.value - current);
        count++;
        minimum = Math.min(minimum, current);
        maximum = Math.max(maximum, current);
        difference += delta;
        if (delta > 40) changes++;
        if (changes > anchor.points.length * maxChangedFraction || difference > anchor.points.length * maxAverageDifference) return false;
    }
    return (
        count >= anchor.points.length * 0.6 &&
        changes / count <= maxChangedFraction &&
        difference / count <= maxAverageDifference &&
        maximum - minimum >= anchor.contrast * 0.5
    );
}

function shiftedAnswer(answer, offset) {
    const shift = box => [box[0] + offset.y, box[1] + offset.x, box[2] + offset.y, box[3] + offset.x];
    return {
        questionBox: shift(answer.questionBox),
        answers: answer.answers.map(option => ({ label: option.label, box: shift(option.box) })),
        confidence: answer.confidence,
    };
}

/**
 * Tracks translations of a cached question using local screenshot pixels only.
 * At most 640 x 640 grayscale samples, 48 coarse candidates, 4096 refinement
 * probes and 8 dense question comparisons (16 million pixels total) are used.
 * Verified initial and stable positions reuse their known alignment. It requires distinct text-like anchors in the question
 * and choice area, then checks the whole aligned question region. Untextured,
 * ambiguous, clipped, changed, or resized questions hide the annotation. This
 * conservative pixel matcher is not OCR or a semantic correctness guarantee.
 */
function createReviewFrameTracker(snapshotImageData, reviewAnswer) {
    const sourceGeometry = validFrame(snapshotImageData) ? geometry(snapshotImageData, reviewAnswer) : null;
    const sourceAnswer = sourceGeometry ? shiftedAnswer(reviewAnswer, { x: 0, y: 0 }) : null;
    // Keep an immutable local copy; the renderer may reuse its canvas buffer.
    const snapshot = sourceGeometry
        ? { width: snapshotImageData.width, height: snapshotImageData.height, data: snapshotImageData.data.slice() }
        : null;
    const gray = snapshot ? grayscale(snapshot) : null;
    const anchors = gray ? selectAnchors(gray, sourceGeometry) : [];
    const features = gray ? selectFeatures(gray, sourceGeometry) : [];
    let lastOffset = null;
    const hidden = reason => {
        lastOffset = null;
        return { state: 'hidden', reason };
    };
    const matched = pixels => {
        lastOffset = pixels;
        const offset = { x: (pixels.x * 1000) / snapshot.width, y: (pixels.y * 1000) / snapshot.height };
        return { state: 'matched', offset, reviewAnswer: shiftedAnswer(sourceAnswer, offset) };
    };
    return {
        retainedBytes: snapshot
            ? snapshot.data.byteLength + gray.data.byteLength + anchors.length * ANCHOR_SIZE * ANCHOR_SIZE * 96 + features.length * 64 + 1024
            : 0,
        locate(currentImageData) {
            if (
                !snapshot ||
                anchors.length < 3 ||
                !validFrame(currentImageData) ||
                currentImageData.width !== snapshot.width ||
                currentImageData.height !== snapshot.height
            ) {
                return hidden('unmatched');
            }
            const pixelRead = (point, x, y) =>
                x >= 0 && y >= 0 && x < currentImageData.width && y < currentImageData.height ? grayAt(currentImageData, x, y) : null;
            const denseBudget = { remaining: MAX_DENSE_PIXELS };
            const knownOffset = lastOffset || { x: 0, y: 0 };
            if (
                anchors.every(anchor => anchorMatches(anchor, pixelRead, knownOffset, sourceGeometry, lastOffset, gray.scaleX, gray.scaleY)) &&
                compareQuestion(snapshot, currentImageData, sourceGeometry, knownOffset, lastOffset, features, denseBudget)
            ) {
                return matched(knownOffset);
            }
            const currentGray = grayscale(currentImageData);
            const candidates = [];
            const coarseRead = (point, x, y, dx, dy) => {
                const gx = point.x + dx;
                const gy = point.y + dy;
                return gx >= 0 && gy >= 0 && gx < currentGray.width && gy < currentGray.height ? currentGray.data[gy * currentGray.width + gx] : null;
            };
            const horizontalLimit = Math.min(24, Math.ceil(gray.width * 0.04));
            for (const searchAnchor of anchors.slice(0, 2)) {
                for (let dy = -searchAnchor.y; dy <= gray.height - searchAnchor.y - ANCHOR_SIZE; dy++) {
                    for (let dx = -horizontalLimit; dx <= horizontalLimit; dx++) {
                        const offset = { x: Math.round(dx * gray.scaleX), y: Math.round(dy * gray.scaleY) };
                        if (
                            !anchorMatches(
                                searchAnchor,
                                (point, x, y) => coarseRead(point, x, y, dx, dy),
                                offset,
                                sourceGeometry,
                                lastOffset,
                                gray.scaleX,
                                gray.scaleY,
                                true
                            )
                        )
                            continue;
                        let matchingAnchors = 0;
                        for (const anchor of anchors) {
                            if (
                                anchorMatches(
                                    anchor,
                                    (point, x, y) => coarseRead(point, x, y, dx, dy),
                                    offset,
                                    sourceGeometry,
                                    lastOffset,
                                    gray.scaleX,
                                    gray.scaleY,
                                    true
                                )
                            )
                                matchingAnchors++;
                        }
                        if (matchingAnchors < 3) continue;
                        if (candidates.some(candidate => candidate.dx === dx && candidate.dy === dy)) continue;
                        // Repeated letters create many loose coarse matches. Keep
                        // a bounded best set rather than rejecting the real match
                        // before its row is reached. Dense verification is unchanged.
                        let score = 0;
                        for (const anchor of anchors) {
                            for (const point of anchor.points) {
                                const value = coarseRead(point, 0, 0, dx, dy);
                                score += value === null ? 255 : Math.abs(point.value - value);
                            }
                        }
                        candidates.push({ dx, dy, offset, score });
                        candidates.sort((a, b) => a.score - b.score);
                        if (candidates.length > MAX_COARSE_CANDIDATES) candidates.pop();
                    }
                }
                if (candidates.length) break;
            }
            const matches = [];
            let foundOffscreen = false;
            const radiusX = Math.min(16, Math.ceil(gray.scaleX));
            const radiusY = Math.min(16, Math.ceil(gray.scaleY));
            let fineProbes = 0;
            let fullComparisons = 0;
            for (const candidate of candidates) {
                let matchedAnchors = 0;
                for (const anchor of anchors) {
                    if (
                        anchorMatches(
                            anchor,
                            (point, x, y) => coarseRead(point, x, y, candidate.dx, candidate.dy),
                            candidate.offset,
                            sourceGeometry,
                            lastOffset,
                            gray.scaleX,
                            gray.scaleY,
                            true
                        )
                    )
                        matchedAnchors++;
                }
                if (matchedAnchors < 3) continue;
                const { question } = sourceGeometry;
                if (
                    question.left + candidate.offset.x < 0 ||
                    question.top + candidate.offset.y < 0 ||
                    question.right + candidate.offset.x > snapshot.width ||
                    question.bottom + candidate.offset.y > snapshot.height
                ) {
                    foundOffscreen = true;
                    continue;
                }
                let refined = null;
                for (let ry = -radiusY; ry <= radiusY && !refined; ry++) {
                    for (let rx = -radiusX; rx <= radiusX; rx++) {
                        if (++fineProbes > MAX_FINE_PROBES) return hidden('unmatched');
                        const offset = { x: candidate.offset.x + rx, y: candidate.offset.y + ry };
                        if (!anchors.every(anchor => anchorMatches(anchor, pixelRead, offset, sourceGeometry, lastOffset, gray.scaleX, gray.scaleY)))
                            continue;
                        if (++fullComparisons > MAX_FULL_COMPARISONS) return hidden('unmatched');
                        if (compareQuestion(snapshot, currentImageData, sourceGeometry, offset, lastOffset, features, denseBudget)) {
                            refined = offset;
                            break;
                        }
                        if (denseBudget.remaining === 0) return hidden('unmatched');
                    }
                }
                if (!refined) continue;
                if (!matches.some(offset => Math.abs(offset.x - refined.x) <= 2 && Math.abs(offset.y - refined.y) <= 2)) matches.push(refined);
                if (matches.length > 1) return hidden('unmatched');
            }
            if (matches.length !== 1) return hidden(foundOffscreen ? 'offscreen' : 'unmatched');
            return matched(matches[0]);
        },
    };
}

module.exports = { isReviewFrameUnchanged, createReviewFrameTracker };
