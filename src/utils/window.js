const { app, BrowserWindow, globalShortcut, ipcMain, screen, systemPreferences } = require('electron');
const path = require('node:path');
const storage = require('../storage');
const { getDefaultKeybinds, createShortcutRegistrar } = require('./keybinds');
const { registerAutomaticScreenCapture } = require('./screenCapture');
const { createReviewOverlay } = require('./reviewOverlay');
const { reviewAppearanceFromPreferences } = require('./reviewAppearance');
const { MIN_ANSWER_SIZE, copyDisplays, chooseDisplay, clampBounds, boundsFromPlacement, placementFromBounds } = require('./answerPlacement');
const shortcutRegistrar = createShortcutRegistrar(globalShortcut, process.platform);
const answerWindows = new WeakMap();

let mouseEventsIgnored = false;
let currentReviewOverlay = null;

function getReviewOverlay() {
    return currentReviewOverlay;
}

const DEFAULT_MAIN_WINDOW_SIZE = { width: 1100, height: 800 };
const MIN_WINDOW_SIZE = { width: 700, height: 320 };

function createAnswerWindowController(mainWindow) {
    let passive = false;
    let settingsBounds = null;
    let answerBounds = null;
    const displays = () => copyDisplays(screen.getAllDisplays());
    const primaryId = () => String(screen.getPrimaryDisplay().id);
    const persistBounds = () => {
        const available = displays();
        const bounds = mainWindow.getBounds();
        const display = chooseDisplay(available, null, bounds, primaryId());
        answerBounds = { ...bounds };
        const placement = placementFromBounds(bounds, display);
        if (storage.updatePreference('answerPlacement', placement) === false) console.warn('Could not save the answer window position.');
        mainWindow.webContents.send('answer-placement-changed', placement);
    };
    const setBounds = (bounds, display, minimum) => {
        mainWindow.setMinimumSize(Math.min(minimum.width, display.workArea.width), Math.min(minimum.height, display.workArea.height));
        mainWindow.setBounds(bounds, false);
    };
    const setInteractive = () => {
        mouseEventsIgnored = false;
        mainWindow.setFocusable(true);
        mainWindow.setIgnoreMouseEvents(false);
        mainWindow.setResizable(true);
        mainWindow.webContents.send('click-through-toggled', false);
    };
    function enter(view) {
        const nextPassive = view === 'assistant';
        if (nextPassive === passive) {
            if (!passive) setInteractive();
            return;
        }
        if (nextPassive) {
            settingsBounds = { ...mainWindow.getBounds() };
            const result = boundsFromPlacement(storage.getPreferences().answerPlacement, displays(), answerBounds || settingsBounds, primaryId());
            setBounds(result.bounds, result.display, MIN_ANSWER_SIZE);
            answerBounds = { ...result.bounds };
            passive = true;
            mouseEventsIgnored = true;
            mainWindow.setResizable(false);
            mainWindow.setIgnoreMouseEvents(true);
            mainWindow.setFocusable(false);
            // setFocusable(false) alone leaves the existing key window focused on macOS.
            mainWindow.blur();
            mainWindow.webContents.send('click-through-toggled', true);
        } else {
            persistBounds();
            passive = false;
            setInteractive();
            const available = displays();
            const desired = settingsBounds || mainWindow.getBounds();
            const display = chooseDisplay(available, null, desired, primaryId());
            setBounds(clampBounds(desired, display, MIN_WINDOW_SIZE), display, MIN_WINDOW_SIZE);
        }
    }
    function move(dx, dy) {
        if (mainWindow.isDestroyed() || (!passive && !mainWindow.isVisible())) return;
        const original = mainWindow.getBounds();
        const available = displays();
        const requested = { ...original, x: original.x + dx, y: original.y + dy };
        const display = chooseDisplay(available, null, requested, primaryId());
        const bounds = clampBounds(requested, display, passive ? MIN_ANSWER_SIZE : MIN_WINDOW_SIZE);
        mainWindow.setBounds(bounds, false);
        if (passive) persistBounds();
    }
    function restoreDisplayLayout() {
        if (mainWindow.isDestroyed()) return;
        const available = displays();
        if (!available.length) return;
        if (passive) {
            const result = boundsFromPlacement(
                storage.getPreferences().answerPlacement,
                available,
                answerBounds || mainWindow.getBounds(),
                primaryId()
            );
            setBounds(result.bounds, result.display, MIN_ANSWER_SIZE);
            persistBounds();
        } else {
            const desired = mainWindow.getBounds();
            const display = chooseDisplay(available, null, desired, primaryId());
            setBounds(clampBounds(desired, display, MIN_WINDOW_SIZE), display, MIN_WINDOW_SIZE);
        }
        mainWindow.webContents.send('answer-displays-changed');
    }
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(name, restoreDisplayLayout);
    return {
        enter,
        move,
        isPassive: () => passive,
        getLayout: () => {
            const available = displays();
            const result = boundsFromPlacement(
                storage.getPreferences().answerPlacement,
                available,
                answerBounds || mainWindow.getBounds(),
                primaryId()
            );
            return {
                success: true,
                displays: available,
                primaryDisplayId: primaryId(),
                placement: placementFromBounds(result.bounds, result.display),
            };
        },
        dispose: () => {
            for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(name, restoreDisplayLayout);
        },
    };
}

function createWindow(sendToRenderer, geminiSessionRef) {
    let windowWidth = DEFAULT_MAIN_WINDOW_SIZE.width;
    let windowHeight = DEFAULT_MAIN_WINDOW_SIZE.height;

    const mainWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        minWidth: MIN_WINDOW_SIZE.width,
        minHeight: MIN_WINDOW_SIZE.height,
        resizable: true,
        frame: false,
        transparent: true,
        hasShadow: false,
        alwaysOnTop: process.platform === 'win32',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false, // TODO: change to true
            backgroundThrottling: false,
            enableBlinkFeatures: 'GetDisplayMedia',
            webSecurity: true,
            allowRunningInsecureContent: false,
        },
        backgroundColor: '#00000000',
    });

    const { session, desktopCapturer } = require('electron');
    currentReviewOverlay?.end();
    const reviewOverlay = createReviewOverlay({
        BrowserWindow,
        screen,
        mainWindow,
        appearance: reviewAppearanceFromPreferences(storage.getPreferences()),
        onWindowCreated: () => {
            if (process.platform === 'darwin') {
                app.setActivationPolicy('accessory');
                app.dock.hide();
            }
        },
        onEnd: ({ reason }) => {
            require('./gemini').closeActiveSession(geminiSessionRef);
            sendToRenderer('provider-session-ended', { reason: reason || 'The review session ended.', code: 'test_review' });
        },
    });
    currentReviewOverlay = reviewOverlay;
    const screenCapture = registerAutomaticScreenCapture(session.defaultSession, {
        desktopCapturer,
        screen,
        mainWindow,
        onSourceSelected: source => reviewOverlay.recordSource(source),
    });

    mainWindow.setContentProtection(true);
    if (process.platform === 'win32') {
        mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    }

    // Hide from Windows taskbar
    if (process.platform === 'win32') {
        try {
            mainWindow.setSkipTaskbar(true);
        } catch (error) {
            console.warn('Could not hide from taskbar:', error.message);
        }
    }

    // Hide from Mission Control on macOS
    if (process.platform === 'darwin') {
        try {
            mainWindow.setHiddenInMissionControl(true);
        } catch (error) {
            console.warn('Could not hide from Mission Control:', error.message);
        }
    }

    mainWindow.loadFile(path.join(__dirname, '../index.html'));

    // Register in the main process immediately; quitting also works if the renderer fails to load.
    const savedKeybinds = storage.getKeybinds();
    let result = updateGlobalShortcuts(savedKeybinds, mainWindow, sendToRenderer, geminiSessionRef, { allowPartial: true });
    if (!result.success) {
        console.warn('Invalid saved keyboard shortcuts, using defaults:', result.error);
        result = updateGlobalShortcuts(null, mainWindow, sendToRenderer, geminiSessionRef, { allowPartial: true });
    }
    if (result.failures.length) console.warn('Unavailable keyboard shortcuts:', result.failures);

    setupWindowIpcHandlers(mainWindow, geminiSessionRef, screenCapture);
    mainWindow.on('blur', () => setShortcutsPaused(false));
    mainWindow.webContents.on('render-process-gone', () => setShortcutsPaused(false));

    return mainWindow;
}

function updateGlobalShortcuts(keybinds, mainWindow, sendToRenderer, geminiSessionRef, options) {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const moveIncrement = Math.floor(Math.min(width, height) * 0.1);
    const moveWindow = (dx, dy) => {
        if (mainWindow.isDestroyed()) return;
        const answerWindow = answerWindows.get(mainWindow);
        if (answerWindow) return answerWindow.move(dx, dy);
        if (!mainWindow.isVisible()) return;
        const [x, y] = mainWindow.getPosition();
        mainWindow.setPosition(x + dx, y + dy);
    };
    const actions = {
        moveUp: () => moveWindow(0, -moveIncrement),
        moveDown: () => moveWindow(0, moveIncrement),
        moveLeft: () => moveWindow(-moveIncrement, 0),
        moveRight: () => moveWindow(moveIncrement, 0),
        toggleVisibility: () => {
            if (mainWindow.isDestroyed()) return;
            if (mainWindow.isVisible()) mainWindow.hide();
            else mainWindow.showInactive();
        },
        toggleReviewMarks: () => {
            if (mainWindow.isDestroyed() || !currentReviewOverlay?.isActive()) return;
            currentReviewOverlay.toggle();
        },
        openVisibilitySettings: () => {
            if (mainWindow.isDestroyed()) return;
            const answerWindow = answerWindows.get(mainWindow);
            if (answerWindow) answerWindow.enter('test-visibility');
            else {
                mouseEventsIgnored = false;
                mainWindow.setFocusable(true);
                mainWindow.setIgnoreMouseEvents(false);
                mainWindow.webContents.send('click-through-toggled', false);
            }
            sendToRenderer('open-test-visibility');
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        },
        toggleClickThrough: () => {
            if (mainWindow.isDestroyed()) return;
            // Active answers never capture mouse input, even if the legacy shortcut is pressed.
            if (answerWindows.get(mainWindow)?.isPassive()) return;
            mouseEventsIgnored = !mouseEventsIgnored;
            mainWindow.setIgnoreMouseEvents(mouseEventsIgnored, { forward: true });
            mainWindow.webContents.send('click-through-toggled', mouseEventsIgnored);
        },
        nextStep: async () => {
            if (mainWindow.isDestroyed()) return;
            try {
                const shortcut = process.platform === 'darwin' ? 'cmd+enter' : 'ctrl+enter';
                await mainWindow.webContents.executeJavaScript(`cheatingDaddy.handleShortcut('${shortcut}');`);
            } catch (error) {
                console.error('Error handling next step shortcut:', error);
            }
        },
        previousResponse: () => sendToRenderer('navigate-previous-response'),
        nextResponse: () => sendToRenderer('navigate-next-response'),
        scrollUp: () => sendToRenderer('scroll-response-up'),
        scrollDown: () => sendToRenderer('scroll-response-down'),
        // Quit is independent of visibility, click-through, and session state.
        // before-quit handles transports/audio/helpers; ordinary quit preserves saved data.
        quitApplication: () => app.quit(),
        emergencyErase: () => {
            if (!mainWindow.isDestroyed()) mainWindow.hide();
            try {
                storage.clearAllData();
            } catch (error) {
                console.error('Error clearing local data:', error);
            } finally {
                app.quit();
            }
        },
    };
    return shortcutRegistrar.update(keybinds, actions, options);
}

function setShortcutsPaused(paused) {
    return shortcutRegistrar.setPaused(paused);
}

function getKeybindStatus() {
    return shortcutRegistrar.getStatus();
}

function disposeGlobalShortcuts() {
    shortcutRegistrar.dispose();
}

function setupWindowIpcHandlers(mainWindow, geminiSessionRef, screenCapture) {
    const reviewOverlay = currentReviewOverlay;
    const answerWindow = createAnswerWindowController(mainWindow);
    answerWindows.set(mainWindow, answerWindow);
    let reviewCapture = null;
    const isTrusted = event =>
        !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame;
    ipcMain.handle('get-answer-displays', event => {
        if (!isTrusted(event)) return { success: false, error: 'Invalid answer layout request.' };
        return answerWindow.getLayout();
    });
    const reviewHandlers = {
        'review:begin': () => reviewOverlay.begin(),
        'review:prepare-capture': () => reviewOverlay.prepareCapture(),
        'review:show-answer': (token, offset) => reviewOverlay.showAnswer(token, offset),
        'review:reuse-answer': (token, previousToken, offset) => reviewOverlay.reuseAnswer(token, previousToken, offset),
        'review:move-answer': (token, offset) => reviewOverlay.moveAnswer(token, offset),
        'review:hide-answer': token => reviewOverlay.hideAnswer(token),
        'review:clear': token => reviewOverlay.clear(token),
        'review:status': text => reviewOverlay.status(text),
        'review:capture-frame': (token, imageQuality) => {
            if (!reviewCapture) {
                const { desktopCapturer } = require('electron');
                reviewCapture = require('./reviewCapture').createReviewCapture({ desktopCapturer, reviewOverlay, screen });
            }
            return reviewCapture.captureFrame(token, imageQuality);
        },
        'review:end': (options = {}) => {
            if (
                !options ||
                typeof options !== 'object' ||
                Array.isArray(options) ||
                Object.keys(options).some(key => key !== 'silent') ||
                (options.silent !== undefined && typeof options.silent !== 'boolean')
            ) {
                return { success: false, error: 'Invalid test review end request.' };
            }
            return reviewOverlay.end(undefined, options.silent !== true);
        },
    };
    for (const [channel, handler] of Object.entries(reviewHandlers)) {
        ipcMain.handle(channel, (event, ...args) => {
            if (!isTrusted(event)) return { success: false, error: 'Invalid test review request.' };
            return handler(...args);
        });
    }
    ipcMain.handle('screen-capture:diagnostics', event => {
        if (!isTrusted(event)) return { success: false, error: 'Invalid screen capture request.' };
        let permissionStatus = 'unknown';
        if (process.platform === 'darwin') {
            try {
                permissionStatus = systemPreferences.getMediaAccessStatus('screen');
            } catch {
                // Older macOS runtimes may not expose screen access status.
            }
        }
        return { failure: screenCapture?.getLastFailure() || null, permissionStatus };
    });
    const onViewChanged = (event, view) => {
        if (!isTrusted(event) || typeof view !== 'string') return;
        if (!mainWindow.isDestroyed()) {
            const isLiveMode = view === 'assistant';

            if (process.platform !== 'win32') {
                mainWindow.setAlwaysOnTop(isLiveMode);
                mainWindow.setVisibleOnAllWorkspaces(isLiveMode, {
                    visibleOnFullScreen: isLiveMode,
                    ...(process.platform === 'darwin' ? { skipTransformProcessType: true } : {}),
                });
            }

            answerWindow.enter(view);
        }
    };
    ipcMain.on('view-changed', onViewChanged);

    ipcMain.handle('window-minimize', () => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.minimize();
        }
    });

    ipcMain.handle('toggle-window-visibility', async event => {
        try {
            if (!isTrusted(event)) return { success: false, error: 'Invalid window request.' };
            if (mainWindow.isDestroyed()) {
                return { success: false, error: 'Window has been destroyed' };
            }

            if (mainWindow.isVisible()) {
                mainWindow.hide();
            } else {
                mainWindow.showInactive();
            }
            return { success: true };
        } catch (error) {
            console.error('Error toggling window visibility:', error);
            return { success: false, error: error.message };
        }
    });

    mainWindow.once('closed', () => {
        // This handler runs before the overlay's main-window listener. Abort pending
        // image requests before end() removes that listener and its onEnd callback.
        if (reviewOverlay?.isActive()) require('./gemini').closeActiveSession(geminiSessionRef);
        ipcMain.removeListener('view-changed', onViewChanged);
        ipcMain.removeHandler('window-minimize');
        ipcMain.removeHandler('toggle-window-visibility');
        ipcMain.removeHandler('screen-capture:diagnostics');
        ipcMain.removeHandler('get-answer-displays');
        for (const channel of Object.keys(reviewHandlers)) ipcMain.removeHandler(channel);
        reviewCapture?.dispose();
        reviewOverlay?.end();
        if (currentReviewOverlay === reviewOverlay) currentReviewOverlay = null;
        // Keep the global Quit shortcut available on macOS after the last window closes.
        setShortcutsPaused(false);
        mouseEventsIgnored = false;
        answerWindow.dispose();
        answerWindows.delete(mainWindow);
    });
}

module.exports = {
    getReviewOverlay,
    createWindow,
    getDefaultKeybinds,
    updateGlobalShortcuts,
    setShortcutsPaused,
    getKeybindStatus,
    disposeGlobalShortcuts,
    setupWindowIpcHandlers,
};
