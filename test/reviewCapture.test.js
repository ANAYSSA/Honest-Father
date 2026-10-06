const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createReviewCapture } = require('../src/utils/reviewCapture');

const clone = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

function png(width, height, marker = 0) {
    const bytes = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'ascii');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    bytes[24] = 8;
    bytes[25] = 6;
    bytes[32] = marker;
    return bytes;
}

function image(width = 1920, height = 1080, options = {}) {
    return {
        isEmpty: () => options.empty || false,
        getSize(scale) {
            assert.deepEqual(scale, { scaleFactor: 1 });
            return { width, height };
        },
        toPNG(scale) {
            assert.deepEqual(scale, { scaleFactor: 1 });
            options.onEncode?.();
            return options.bytes ?? png(width, height, options.marker);
        },
    };
}

function manualTimers() {
    const pending = [];
    return {
        pending,
        setTimeout(callback, delay) {
            const timer = { callback, delay, cleared: false };
            pending.push(timer);
            return timer;
        },
        clearTimeout(timer) {
            if (timer) timer.cleared = true;
        },
    };
}

function harness({ getSources, timers, display } = {}) {
    let active = true;
    let displays = [display || { id: 22, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 2, rotation: 0 }];
    let current = { captureId: 'capture-one', requestId: 'request-one', display: clone(displays[0]) };
    const token = clone(current);
    const calls = [];
    const validations = [];
    const reviewOverlay = {
        isActive: () => active,
        validateCapture(supplied, dimensions) {
            validations.push({ token: clone(supplied), dimensions: { ...dimensions } });
            if (!active || JSON.stringify(supplied) !== JSON.stringify(current)) {
                return { success: false, error: 'This review capture is no longer current.' };
            }
            if (
                Math.abs(dimensions.imageWidth / dimensions.imageHeight / (current.display.bounds.width / current.display.bounds.height) - 1) > 0.02
            ) {
                return { success: false, error: 'The screenshot does not match the captured display.' };
            }
            return { success: true, display: clone(current.display) };
        },
    };
    const provider = createReviewCapture({
        desktopCapturer: {
            getSources(options) {
                calls.push(options);
                return getSources
                    ? getSources(options, calls.length)
                    : Promise.resolve([
                          { id: 'screen:11:0', display_id: '22', thumbnail: image(options.thumbnailSize.width, options.thumbnailSize.height) },
                      ]);
            },
        },
        reviewOverlay,
        screen: { getAllDisplays: () => displays },
        ...(timers ? { timers } : {}),
    });
    return {
        provider,
        token,
        calls,
        validations,
        end: () => {
            active = false;
        },
        changeToken: requestId => {
            current = { ...current, requestId };
            return clone(current);
        },
        changeDisplays: value => {
            displays = value;
        },
    };
}

for (const quality of ['low', 'medium', 'high']) {
    test(`${quality} native Review capture keeps the exact display-DIP grid and returns PNG geometry`, async () => {
        const h = harness();
        const result = await h.provider.captureFrame(h.token, quality);
        assert.equal(result.success, true);
        assert.equal(result.mimeType, 'image/png');
        assert.equal(result.width, 1920);
        assert.equal(result.height, 1080);
        assert.deepEqual(h.calls, [{ types: ['screen'], thumbnailSize: { width: result.width, height: result.height }, fetchWindowIcons: false }]);
        assert.deepEqual(Buffer.from(result.data, 'base64'), png(result.width, result.height));
        assert.ok(h.validations.length >= 4, 'Both the request and captured dimensions are revalidated');
        await flush();
        h.provider.dispose();
    });
}

for (const scaleFactor of [1, 1.25, 2]) {
    test(`all qualities retain the same 1710-by-1107 DIP grid at display scale ${scaleFactor}`, async () => {
        const display = { id: 22, bounds: { x: -1710, y: 20, width: 1710, height: 1107 }, scaleFactor, rotation: 0 };
        const h = harness({ display });
        for (const quality of ['low', 'medium', 'high']) {
            const result = await h.provider.captureFrame(h.token, quality);
            assert.equal(result.success, true);
            assert.deepEqual({ width: result.width, height: result.height }, { width: 1710, height: 1107 });
            assert.deepEqual(Buffer.from(result.data, 'base64'), png(1710, 1107));
            await flush();
        }
        assert.equal(h.calls.length, 3);
        for (const call of h.calls) {
            assert.deepEqual(
                call.thumbnailSize,
                { width: 1710, height: 1107 },
                'Image quality and device scale cannot resample the local tracker grid'
            );
        }
        h.provider.dispose();
    });
}

test('fractional display bounds are rounded once into an exact integer local grid', async () => {
    const display = { id: 22, bounds: { x: 0, y: 0, width: 1710.2, height: 1106.8 }, scaleFactor: 2, rotation: 0 };
    const h = harness({ display });
    const result = await h.provider.captureFrame(h.token, 'high');
    assert.equal(result.success, true);
    assert.deepEqual(h.calls[0].thumbnailSize, { width: 1710, height: 1107 });
    assert.equal(result.width, 1710);
    assert.equal(result.height, 1107);
    await flush();
    h.provider.dispose();
});

for (const bounds of [
    { width: 16385, height: 900 },
    { width: 8192, height: 4096 },
]) {
    test(`an unsupported ${bounds.width}-by-${bounds.height} local grid fails explicitly without fractional downscaling`, async () => {
        const h = harness({ display: { id: 22, bounds: { x: 0, y: 0, ...bounds }, scaleFactor: 1, rotation: 0 } });
        for (const quality of ['low', 'medium', 'high']) {
            const result = await h.provider.captureFrame(h.token, quality);
            assert.equal(result.code, 'unsupported_local_grid');
            assert.match(result.error, /display is too large/);
        }
        assert.equal(h.calls.length, 0);
        h.provider.dispose();
    });
}

test('the exact 16-megapixel and 16384-pixel grid limits remain supported', async () => {
    const h = harness({ display: { id: 22, bounds: { x: 0, y: 0, width: 16384, height: 1024 }, scaleFactor: 1, rotation: 0 } });
    const result = await h.provider.captureFrame(h.token, 'low');
    assert.equal(result.success, true);
    assert.deepEqual(h.calls[0].thumbnailSize, { width: 16384, height: 1024 });
    await flush();
    h.provider.dispose();
});

for (const size of [
    { width: 1920, height: 1243 },
    { width: 3420, height: 2214 },
    { width: 1711, height: 1107 },
]) {
    test(`a ${size.width}-by-${size.height} returned thumbnail is rejected instead of resizing the 1710-by-1107 grid`, async () => {
        let encoded = 0;
        const h = harness({
            display: { id: 22, bounds: { x: 0, y: 0, width: 1710, height: 1107 }, scaleFactor: 2, rotation: 0 },
            getSources: async () => [
                { id: 'screen:11:0', display_id: '22', thumbnail: image(size.width, size.height, { onEncode: () => encoded++ }) },
            ],
        });
        const result = await h.provider.captureFrame(h.token);
        assert.equal(result.code, 'unsupported_local_grid');
        assert.match(result.error, /does not match the display pixel grid/);
        assert.equal(Object.hasOwn(result, 'data'), false);
        assert.equal(encoded, 0);
        await flush();
        h.provider.dispose();
    });
}

test('the native frame is selected by exact display ID rather than source ordinal or primary-display fallback', async () => {
    const h = harness({
        getSources: async () => [
            { id: 'screen:22:0', display_id: '11', thumbnail: image(1920, 1080, { marker: 1 }) },
            { id: 'window:22:0', display_id: '22', thumbnail: image(1920, 1080, { marker: 2 }) },
            { id: 'screen:11:0', display_id: '22', thumbnail: image(1920, 1080, { marker: 3 }) },
        ],
    });
    const result = await h.provider.captureFrame(h.token);
    assert.equal(result.success, true);
    assert.equal(result.width, 1920);
    assert.equal(result.height, 1080);
    assert.deepEqual(Buffer.from(result.data, 'base64'), png(1920, 1080, 3));
    await flush();
    h.provider.dispose();
});

test('an unavailable selected display never falls back to another screen', async () => {
    const h = harness({ getSources: async () => [{ id: 'screen:22:0', display_id: '11', thumbnail: image() }] });
    const result = await h.provider.captureFrame(h.token);
    assert.equal(result.success, false);
    assert.match(result.error, /empty frame/);
    await flush();
    h.provider.dispose();
});

test('invalid qualities, token geometry, ended sessions and stale capture IDs do not enumerate screens', async () => {
    const h = harness();
    for (const quality of ['ultra', null, true, {}, ['medium'], '__proto__']) {
        assert.equal((await h.provider.captureFrame(h.token, quality)).success, false);
    }
    for (const token of [
        null,
        {},
        { ...h.token, captureId: '' },
        { ...h.token, display: { ...h.token.display, bounds: { width: NaN, height: 1 } } },
    ]) {
        assert.equal((await h.provider.captureFrame(token)).success, false);
    }
    h.changeToken('request-two');
    assert.equal((await h.provider.captureFrame(h.token)).code, 'stale');
    h.end();
    assert.equal((await h.provider.captureFrame(h.token)).code, 'stale');
    assert.equal(h.calls.length, 0);
    h.provider.dispose();
});

test('removing or changing display geometry rejects a frame before native capture begins', async () => {
    const h = harness();
    h.changeDisplays([]);
    assert.equal((await h.provider.captureFrame(h.token)).code, 'stale');
    h.changeDisplays([{ ...h.token.display, bounds: { ...h.token.display.bounds, width: 1900 } }]);
    assert.equal((await h.provider.captureFrame(h.token)).code, 'stale');
    assert.equal(h.calls.length, 0);
    h.provider.dispose();
});

test('disposing before the first microtask never starts native screen enumeration', async () => {
    const h = harness();
    const pending = h.provider.captureFrame(h.token);
    h.provider.dispose();
    assert.equal((await pending).code, 'stale');
    await flush();
    assert.equal(h.calls.length, 0);
    const next = harness();
    assert.equal((await next.provider.captureFrame(next.token)).success, true);
    await flush();
    next.provider.dispose();
});

for (const invalidation of ['session', 'token', 'display']) {
    test(`invalidating the ${invalidation} before the queued native microtask prevents screen enumeration`, async () => {
        const h = harness();
        const pending = h.provider.captureFrame(h.token);
        if (invalidation === 'session') h.end();
        else if (invalidation === 'token') h.changeToken('request-two');
        else h.changeDisplays([]);
        assert.equal((await pending).code, 'stale');
        await flush();
        assert.equal(h.calls.length, 0);
        h.provider.dispose();
    });
}

test('native completion cannot return pixels for a capture token invalidated during the read', async () => {
    let release;
    const h = harness({
        getSources: () =>
            new Promise(resolve => {
                release = resolve;
            }),
    });
    const pending = h.provider.captureFrame(h.token);
    await flush();
    h.changeToken('request-two');
    release([{ id: 'screen:11:0', display_id: '22', thumbnail: image() }]);
    assert.equal((await pending).code, 'stale');
    await flush();
    h.provider.dispose();
});

test('native frame encoding revalidates a display or session change instead of publishing stale PNG bytes', async () => {
    let h;
    h = harness({
        getSources: async () => [{ id: 'screen:11:0', display_id: '22', thumbnail: image(1920, 1080, { onEncode: () => h.end() }) }],
    });
    assert.equal((await h.provider.captureFrame(h.token)).code, 'stale');
    await flush();
    h.provider.dispose();
});

test('a queued newer capture discards the previous native result and starts a separate fresh enumeration', async () => {
    let release;
    const h = harness({
        getSources: (_options, index) =>
            index === 1
                ? new Promise(resolve => {
                      release = resolve;
                  })
                : Promise.resolve([{ id: 'screen:11:0', display_id: '22', thumbnail: image(1920, 1080, { marker: 2 }) }]),
    });
    const previous = h.provider.captureFrame(h.token);
    await flush();
    const newerToken = h.changeToken('request-two');
    const newer = h.provider.captureFrame(newerToken);
    const rejected = await h.provider.captureFrame(newerToken);
    assert.equal(rejected.code, 'busy');
    assert.equal(h.calls.length, 1, 'Only one native enumeration can run at a time');
    release([{ id: 'screen:11:0', display_id: '22', thumbnail: image(1920, 1080, { marker: 1 }) }]);
    assert.equal((await previous).code, 'stale');
    const result = await newer;
    assert.equal(result.success, true);
    assert.deepEqual(Buffer.from(result.data, 'base64'), png(1920, 1080, 2));
    assert.equal(h.calls.length, 2, 'The queued request never reuses a pre-barrier native result');
    await flush();
    h.provider.dispose();
});

test('a client timeout keeps the native lock until actual completion, then a waiter captures fresh pixels', async () => {
    const timers = manualTimers();
    let release;
    const h = harness({
        timers,
        getSources: (_options, index) =>
            index === 1
                ? new Promise(resolve => {
                      release = resolve;
                  })
                : Promise.resolve([{ id: 'screen:11:0', display_id: '22', thumbnail: image(1920, 1080, { marker: 2 }) }]),
    });
    const previous = h.provider.captureFrame(h.token);
    await flush();
    assert.equal(timers.pending[0].delay, 3000);
    timers.pending[0].callback();
    assert.equal((await previous).code, 'timeout');
    const newer = h.provider.captureFrame(h.changeToken('request-two'));
    await flush();
    assert.equal(h.calls.length, 1, 'Timing out a client cannot unlock an unfinished native capturer');
    release([{ id: 'screen:11:0', display_id: '22', thumbnail: image(1920, 1080, { marker: 1 }) }]);
    const result = await newer;
    assert.equal(result.success, true);
    assert.deepEqual(Buffer.from(result.data, 'base64'), png(1920, 1080, 2));
    assert.equal(h.calls.length, 2);
    assert.equal(
        timers.pending.every(timer => timer.cleared),
        true
    );
    await flush();
    h.provider.dispose();
});

test('a timed-out queued request never starts another native operation when the older call finally completes', async () => {
    const timers = manualTimers();
    let release;
    const h = harness({
        timers,
        getSources: () =>
            new Promise(resolve => {
                release = resolve;
            }),
    });
    const first = h.provider.captureFrame(h.token);
    await flush();
    const queued = h.provider.captureFrame(h.token);
    timers.pending[1].callback();
    assert.equal((await queued).code, 'timeout');
    release([{ id: 'screen:11:0', display_id: '22', thumbnail: image() }]);
    assert.equal((await first).success, true);
    await flush();
    assert.equal(h.calls.length, 1);
    h.provider.dispose();
});

test('disposing a provider cancels its result but keeps native serialization across a replacement provider', async () => {
    let release;
    let encoded = 0;
    const first = harness({
        getSources: () =>
            new Promise(resolve => {
                release = resolve;
            }),
    });
    const pending = first.provider.captureFrame(first.token);
    await flush();
    first.provider.dispose();
    assert.equal((await pending).code, 'stale');
    const replacement = harness();
    const newer = replacement.provider.captureFrame(replacement.token);
    await flush();
    assert.equal(replacement.calls.length, 0);
    release([{ id: 'screen:11:0', display_id: '22', thumbnail: image(1920, 1080, { onEncode: () => encoded++ }) }]);
    assert.equal((await newer).success, true);
    assert.equal(replacement.calls.length, 1);
    assert.equal(encoded, 0, 'A canceled result is discarded before PNG encoding');
    await flush();
    replacement.provider.dispose();
});

test('mutating the caller token after acquisition cannot alter the provider immutable request', async () => {
    let release;
    const h = harness({
        getSources: () =>
            new Promise(resolve => {
                release = resolve;
            }),
    });
    const supplied = clone(h.token);
    const pending = h.provider.captureFrame(supplied);
    await flush();
    supplied.requestId = 'mutated';
    supplied.display.bounds.width = 1;
    release([{ id: 'screen:11:0', display_id: '22', thumbnail: image() }]);
    assert.equal((await pending).success, true);
    await flush();
    h.provider.dispose();
});

for (const [name, thumbnail] of [
    ['empty image', image(1920, 1080, { empty: true })],
    ['zero width', image(0, 1080)],
    ['too many pixels', image(8192, 4096)],
    ['mismatched aspect', image(1080, 1920)],
    ['empty PNG', image(1920, 1080, { bytes: Buffer.alloc(0) })],
    ['invalid PNG signature', image(1920, 1080, { bytes: Buffer.alloc(33) })],
    ['PNG dimension mismatch', image(1920, 1080, { bytes: png(1921, 1080) })],
    ['oversized PNG', image(1920, 1080, { bytes: Buffer.alloc(16 * 1024 * 1024 + 1) })],
]) {
    test(`${name} is rejected without returning screenshot data`, async () => {
        const h = harness({ getSources: async () => [{ id: 'screen:11:0', display_id: '22', thumbnail }] });
        const result = await h.provider.captureFrame(h.token);
        assert.equal(result.success, false);
        assert.equal(Object.hasOwn(result, 'data'), false);
        await flush();
        h.provider.dispose();
    });
}

for (const reason of [undefined, null, 'Screen capture denied\nby macOS']) {
    test(`native rejection ${String(reason)} settles safely and releases the native gate`, async () => {
        const h = harness({ getSources: () => Promise.reject(reason) });
        const result = await h.provider.captureFrame(h.token);
        assert.equal(result.code, 'capture_failed');
        assert.equal(/[\n\r]/.test(result.error), false);
        await flush();
        h.provider.dispose();
        const next = harness();
        assert.equal((await next.provider.captureFrame(next.token)).success, true);
        await flush();
        next.provider.dispose();
    });
}

test('native frame IPC rejects other windows and child frames before constructing a provider, and disposes it on close', async () => {
    const handlers = new Map();
    const ipcMain = new EventEmitter();
    ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
    ipcMain.removeHandler = channel => handlers.delete(channel);
    const calls = [];
    const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) };
    const desktopCapturer = {};
    const overlay = { isActive: () => false, end() {} };
    const provider = {
        captureFrame(token, quality) {
            calls.push({ token, quality });
            return Promise.resolve({ success: true });
        },
        dispose() {
            calls.push('dispose');
        },
    };
    class Window extends EventEmitter {
        constructor() {
            super();
            this.destroyed = false;
            this.webContents = new EventEmitter();
            this.webContents.mainFrame = {};
        }
        isDestroyed() {
            return this.destroyed;
        }
        setContentProtection() {}
        setVisibleOnAllWorkspaces() {}
        setAlwaysOnTop() {}
        setSkipTaskbar() {}
        loadFile() {}
    }
    let constructed = 0;
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/utils/window.js'), 'utf8'), {
        module,
        __dirname: path.resolve(__dirname, '../src/utils'),
        process: { platform: 'win32' },
        console,
        require(name) {
            if (name === 'node:path') return path;
            if (name === 'electron')
                return { app: {}, BrowserWindow: Window, ipcMain, screen, desktopCapturer, globalShortcut: {}, session: { defaultSession: {} } };
            if (name === '../storage') return { getKeybinds: () => null };
            if (name === './reviewOverlay') return { createReviewOverlay: () => overlay };
            if (name === './screenCapture') return { registerAutomaticScreenCapture: () => ({}) };
            if (name === './keybinds')
                return {
                    getDefaultKeybinds() {},
                    createShortcutRegistrar: () => ({ update: () => ({ success: true, failures: [] }), setPaused() {} }),
                };
            if (name === './reviewCapture')
                return {
                    createReviewCapture(options) {
                        assert.equal(options.desktopCapturer, desktopCapturer);
                        assert.equal(options.screen, screen);
                        assert.equal(options.reviewOverlay, overlay);
                        constructed++;
                        return provider;
                    },
                };
            throw new Error(`Unexpected module: ${name}`);
        },
    });
    const window = module.exports.createWindow(() => {}, { current: null });
    const handler = handlers.get('review:capture-frame');
    for (const event of [{ sender: {} }, { sender: window.webContents, senderFrame: {} }]) {
        assert.equal((await handler(event, {}, 'high')).success, false);
    }
    assert.equal(constructed, 0);
    assert.equal(calls.length, 0);
    const trusted = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const token = { captureId: 'trusted-token' };
    assert.equal((await handler(trusted, token, 'medium')).success, true);
    assert.equal((await handler(trusted, token, 'low')).success, true);
    assert.equal(constructed, 1, 'Native serialization lives in one provider for this window');
    assert.deepEqual(calls, [
        { token, quality: 'medium' },
        { token, quality: 'low' },
    ]);
    window.destroyed = true;
    assert.equal((await handler(trusted, token, 'high')).success, false);
    window.emit('closed');
    assert.equal(calls.at(-1), 'dispose');
    assert.equal(handlers.has('review:capture-frame'), false);
});
