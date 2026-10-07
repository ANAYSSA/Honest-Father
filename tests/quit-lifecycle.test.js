const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createShutdownHandler, createQuitController } = require('../src/utils/shutdown');
const { createShortcutRegistrar, getDefaultKeybinds } = require('../src/utils/keybinds');

function makeClock() {
    let now = 0;
    const timers = new Map();
    return {
        timers,
        schedule(callback, delay) {
            const timer = {
                unref() {
                    timer.unreferenced = true;
                },
            };
            timers.set(timer, { callback, due: now + delay });
            return timer;
        },
        cancel(timer) {
            timers.delete(timer);
        },
        advance(ms) {
            now += ms;
            for (const [timer, { callback, due }] of [...timers]) {
                if (due <= now) {
                    timers.delete(timer);
                    callback();
                }
            }
        },
    };
}

test('quit starts cleanup once and forces a stalled process to exit within the deadline', () => {
    const clock = makeClock();
    const exits = [];
    const warnings = [];
    let cleanups = 0;
    const controller = createQuitController({
        shutdown: () => cleanups++,
        exit: code => exits.push(code),
        schedule: clock.schedule,
        cancel: clock.cancel,
        logger: { warn: warning => warnings.push(warning), error() {} },
    });
    assert.equal(controller.isQuitting(), false);
    controller.beginQuit();
    controller.beginQuit();
    assert.equal(controller.isQuitting(), true);
    assert.equal(cleanups, 1);
    assert.equal(clock.timers.size, 1);
    assert.equal([...clock.timers.keys()][0].unreferenced, true);
    clock.advance(1999);
    assert.deepEqual(exits, []);
    clock.advance(1);
    assert.deepEqual(exits, [0]);
    assert.equal(warnings.length, 1);
});

test('actual process exit cancels the fallback without holding a healthy process open', () => {
    const clock = makeClock();
    let forced = false;
    const controller = createQuitController({
        shutdown() {},
        exit: () => {
            forced = true;
        },
        schedule: clock.schedule,
        cancel: clock.cancel,
    });
    controller.beginQuit();
    controller.processExited();
    controller.processExited();
    clock.advance(5000);
    assert.equal(clock.timers.size, 0);
    assert.equal(forced, false);
});

test('cleanup failures and never-settling cleanup do not disable the quit deadline', async () => {
    for (const shutdown of [
        () => {
            throw new Error('broken');
        },
        () => Promise.reject(new Error('broken')),
        () => new Promise(() => {}),
    ]) {
        const clock = makeClock();
        const exits = [];
        const controller = createQuitController({
            shutdown,
            exit: code => exits.push(code),
            schedule: clock.schedule,
            cancel: clock.cancel,
            logger: { warn() {}, error() {} },
        });
        controller.beginQuit();
        await Promise.resolve();
        clock.advance(2000);
        assert.deepEqual(exits, [0]);
    }
});

test('closing windows and pending renderer blur IPC cannot re-register shortcuts after shutdown', () => {
    const shortcuts = new Map();
    let registrations = 0;
    const registrar = createShortcutRegistrar(
        {
            register(accelerator, callback) {
                registrations++;
                shortcuts.set(accelerator, callback);
                return true;
            },
            unregisterAll() {
                shortcuts.clear();
            },
        },
        'win32'
    );
    const actions = Object.fromEntries(Object.keys(getDefaultKeybinds('win32')).map(action => [action, () => {}]));
    registrar.update(null, actions, { allowPartial: true });
    registrar.dispose();
    const previousRegistrations = registrations;
    assert.equal(registrar.setPaused(false).success, false);
    assert.equal(registrar.update(null, actions).success, false);
    assert.equal(shortcuts.size, 0);
    assert.equal(registrations, previousRegistrations);
});

test('application app.quit and hotkey lifecycle keep the deadline after will-quit and suppress reopening', () => {
    const clock = makeClock();
    const app = new EventEmitter();
    const processEvents = new EventEmitter();
    const exits = [];
    const cleanup = [];
    let activations = 0;
    app.setName = () => {};
    app.requestSingleInstanceLock = () => true;
    app.setAppUserModelId = () => {};
    app.whenReady = () => new Promise(() => {});
    app.exit = code => exits.push(code);
    app.quit = () => {
        app.emit('before-quit');
        app.emit('will-quit');
    };
    processEvents.platform = 'win32';
    const mocks = {
        'electron-squirrel-startup': false,
        electron: {
            app,
            globalShortcut: { unregisterAll: () => cleanup.push('final-shortcuts') },
            BrowserWindow: {
                getAllWindows: () => {
                    activations++;
                    return [];
                },
            },
        },
        './utils/window': { disposeGlobalShortcuts: () => cleanup.push('shortcuts') },
        './utils/chatgpt': { setupChatGPT() {} },
        './utils/gemini': {
            closeActiveSession: () => cleanup.push('session'),
            stopMacOSAudioCapture: () => cleanup.push('audio'),
        },
        './utils/localai': { closeLocalSession: () => cleanup.push('local') },
        './utils/shutdown': {
            createShutdownHandler,
            createQuitController: options =>
                createQuitController({
                    ...options,
                    schedule: clock.schedule,
                    cancel: clock.cancel,
                    logger: { warn() {}, error() {} },
                }),
        },
        './utils/keybinds': {},
        './utils/reviewAppearance': require('../src/utils/reviewAppearance'),
        './utils/historyActions': require('../src/utils/historyActions'),
        './storage': {},
    };
    const filename = path.resolve(__dirname, '../src/index.js');
    vm.runInNewContext(
        fs.readFileSync(filename, 'utf8'),
        {
            require: id => {
                assert.ok(Object.hasOwn(mocks, id), id);
                return mocks[id];
            },
            process: processEvents,
            console: { log() {}, warn() {}, error() {} },
        },
        { filename }
    );
    app.quit();
    app.emit('activate');
    assert.equal(activations, 0);
    assert.deepEqual(cleanup, ['session', 'audio', 'local', 'shortcuts', 'final-shortcuts']);
    assert.equal(clock.timers.size, 1, 'will-quit does not mean the process has exited');
    clock.advance(2000);
    assert.deepEqual(exits, [0]);
    processEvents.emit('exit');
});
