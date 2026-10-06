const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_PNG_BYTES = 16 * 1024 * 1024;
const MAX_DIMENSION = 16384;
const QUALITIES = new Set(['high', 'medium', 'low']);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Electron coalesces simultaneous getSources calls with identical options.
// Keep this gate across provider instances as well as after client timeouts:
// an old native capture must actually finish before a fresh one can start.
const nativeGate = { pending: null, requests: 0 };

function copyToken(token) {
    if (
        !token ||
        Array.isArray(token) ||
        !['captureId', 'requestId'].every(key => typeof token[key] === 'string' && token[key].length > 0 && token[key].length <= 256) ||
        !token.display ||
        Array.isArray(token.display) ||
        !['string', 'number'].includes(typeof token.display.id) ||
        String(token.display.id).length === 0 ||
        String(token.display.id).length > 128 ||
        (typeof token.display.id === 'number' && !Number.isFinite(token.display.id)) ||
        !token.display.bounds ||
        Array.isArray(token.display.bounds) ||
        !['x', 'y', 'width', 'height'].every(key => Number.isFinite(token.display.bounds[key])) ||
        token.display.bounds.width <= 0 ||
        token.display.bounds.height <= 0 ||
        !Number.isFinite(token.display.scaleFactor) ||
        token.display.scaleFactor <= 0 ||
        !Number.isFinite(token.display.rotation)
    ) {
        return null;
    }
    return {
        captureId: token.captureId,
        requestId: token.requestId,
        display: {
            id: token.display.id,
            bounds: { ...token.display.bounds },
            scaleFactor: token.display.scaleFactor,
            rotation: token.display.rotation,
        },
    };
}

function sameDisplay(left, right) {
    return (
        left &&
        right &&
        String(left.id) === String(right.id) &&
        ['x', 'y', 'width', 'height'].every(key => left.bounds?.[key] === right.bounds?.[key]) &&
        left.scaleFactor === right.scaleFactor &&
        left.rotation === right.rotation
    );
}

function localGridSize(display) {
    // Keep one capture pixel per display DIP for every quality setting. A
    // fractional resize changes glyph raster phase during integer-DIP scrolling;
    // network JPEG quality can be scaled separately without touching this grid.
    return { width: Math.round(display.bounds.width), height: Math.round(display.bounds.height) };
}

function createReviewCapture({ desktopCapturer, reviewOverlay, screen, timeoutMs = 3000, timers = { setTimeout, clearTimeout } }) {
    let disposed = false;
    const requests = new Set();
    const failure = (code, error) => ({ success: false, code, error });
    const cleanError = error => {
        const message = typeof error === 'string' ? error : error?.message;
        return typeof message === 'string'
            ? message
                  .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 512) || 'Unable to capture the selected screen.'
            : 'Unable to capture the selected screen.';
    };
    const validate = (token, dimensions) => {
        if (disposed || !reviewOverlay.isActive()) return failure('stale', 'The review session has ended.');
        const result = reviewOverlay.validateCapture(token, { imageWidth: dimensions.width, imageHeight: dimensions.height });
        if (!result?.success) return failure('stale', cleanError(result?.error || 'This review capture is no longer current.'));
        const display = screen.getAllDisplays().find(item => String(item.id) === String(result.display?.id));
        if (!sameDisplay(result.display, token.display) || !sameDisplay(display, result.display)) {
            return failure('stale', 'The captured display changed. Start a new review session.');
        }
        return { success: true, display: result.display };
    };

    function captureFrame(suppliedToken, imageQuality = 'medium') {
        const token = copyToken(suppliedToken);
        if (!token || typeof imageQuality !== 'string' || !QUALITIES.has(imageQuality)) {
            return Promise.resolve(failure('invalid_request', 'The review frame request is invalid.'));
        }
        const dimensions = localGridSize(token.display);
        let validation;
        try {
            validation = validate(token, dimensions);
        } catch (error) {
            return Promise.resolve(failure('capture_failed', cleanError(error)));
        }
        if (!validation.success) return Promise.resolve(validation);
        if (
            !Number.isInteger(dimensions.width) ||
            !Number.isInteger(dimensions.height) ||
            dimensions.width <= 0 ||
            dimensions.height <= 0 ||
            dimensions.width > MAX_DIMENSION ||
            dimensions.height > MAX_DIMENSION ||
            dimensions.width * dimensions.height > MAX_PIXELS
        ) {
            return Promise.resolve(
                failure(
                    'unsupported_local_grid',
                    'This display is too large for safe local tracking. Use a smaller display resolution and start a new session.'
                )
            );
        }
        // One native operation and at most one waiter. Timed-out operations still
        // occupy their slot until native completion, bounding stalled work.
        if (nativeGate.requests >= 2) {
            return Promise.resolve(failure('busy', 'The screen is finishing a previous frame. Try again shortly.'));
        }
        nativeGate.requests++;
        const request = { canceled: false, finished: false, finish: null };
        requests.add(request);
        const deadline = Date.now() + timeoutMs;
        let timer;
        const result = new Promise(resolve => {
            request.finish = value => {
                if (request.finished) return;
                request.finished = true;
                timers.clearTimeout(timer);
                resolve(value);
            };
            timer = timers.setTimeout(() => {
                request.canceled = true;
                request.finish(failure('timeout', 'The shared screen did not return a fresh frame. Share it again.'));
            }, timeoutMs);
        });
        const run = async () => {
            if (nativeGate.pending) {
                // Never use this older operation's pixels: a manual hide barrier
                // may have happened after its capture started.
                await nativeGate.pending.catch(() => {});
            }
            if (request.canceled) return;
            if (Date.now() >= deadline) {
                request.canceled = true;
                return request.finish(failure('timeout', 'The shared screen did not return a fresh frame. Share it again.'));
            }
            const current = validate(token, dimensions);
            if (!current.success) return request.finish(current);
            const native = Promise.resolve().then(() => {
                // Session cancellation can happen after run() queues this task
                // but before it starts. Do not even enumerate screens then.
                if (request.canceled) return null;
                const beforeStart = validate(token, dimensions);
                if (!beforeStart.success) {
                    request.canceled = true;
                    request.finish(beforeStart);
                    return null;
                }
                return desktopCapturer.getSources({ types: ['screen'], thumbnailSize: dimensions, fetchWindowIcons: false });
            });
            nativeGate.pending = native;
            let sources;
            try {
                sources = await native;
            } finally {
                if (nativeGate.pending === native) nativeGate.pending = null;
            }
            if (request.canceled) return;
            if (Date.now() >= deadline) {
                request.canceled = true;
                return request.finish(failure('timeout', 'The shared screen did not return a fresh frame. Share it again.'));
            }
            const afterCapture = validate(token, dimensions);
            if (!afterCapture.success) return request.finish(afterCapture);
            const source = Array.isArray(sources)
                ? sources.find(
                      item => typeof item.id === 'string' && item.id.startsWith('screen:') && item.display_id === String(afterCapture.display.id)
                  )
                : null;
            const image = source?.thumbnail;
            if (!image || image.isEmpty()) throw new Error('The captured display returned an empty frame. Share it again.');
            const size = image.getSize({ scaleFactor: 1 });
            if (
                !Number.isInteger(size.width) ||
                !Number.isInteger(size.height) ||
                size.width <= 0 ||
                size.height <= 0 ||
                size.width > MAX_DIMENSION ||
                size.height > MAX_DIMENSION ||
                size.width * size.height > MAX_PIXELS
            ) {
                throw new Error('The captured display returned invalid frame dimensions.');
            }
            if (size.width !== dimensions.width || size.height !== dimensions.height) {
                return request.finish(
                    failure('unsupported_local_grid', 'The captured frame does not match the display pixel grid. Start a new review session.')
                );
            }
            const actual = validate(token, size);
            if (!actual.success) return request.finish(actual);
            const png = image.toPNG({ scaleFactor: 1 });
            if (
                !Buffer.isBuffer(png) ||
                png.length < 24 ||
                png.length > MAX_PNG_BYTES ||
                !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
                png.toString('ascii', 12, 16) !== 'IHDR' ||
                png.readUInt32BE(16) !== size.width ||
                png.readUInt32BE(20) !== size.height
            ) {
                throw new Error('The captured display returned an invalid or oversized PNG frame.');
            }
            const latest = validate(token, size);
            if (!latest.success) return request.finish(latest);
            if (Date.now() >= deadline) {
                request.canceled = true;
                return request.finish(failure('timeout', 'The shared screen did not return a fresh frame. Share it again.'));
            }
            request.finish({ success: true, data: png.toString('base64'), mimeType: 'image/png', width: size.width, height: size.height });
        };
        run()
            .catch(error => {
                if (!request.canceled) request.finish(failure('capture_failed', cleanError(error)));
            })
            .finally(() => {
                requests.delete(request);
                nativeGate.requests--;
            });
        return result;
    }

    function dispose() {
        disposed = true;
        for (const request of requests) {
            request.canceled = true;
            request.finish(failure('stale', 'The review session has ended.'));
        }
    }

    return { captureFrame, dispose };
}

module.exports = { createReviewCapture };
