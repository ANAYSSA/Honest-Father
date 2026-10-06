if (require('electron-squirrel-startup')) {
    process.exit(0);
}

const { app, shell, ipcMain, globalShortcut } = require('electron');
const {
    createWindow,
    getReviewOverlay,
    updateGlobalShortcuts,
    setShortcutsPaused,
    getKeybindStatus,
    disposeGlobalShortcuts,
} = require('./utils/window');
const { setupGeminiIpcHandlers, stopMacOSAudioCapture, sendToRenderer, closeActiveSession, setMainWindow } = require('./utils/gemini');
const { normalizeKeybinds } = require('./utils/keybinds');
const { createShutdownHandler, createQuitController } = require('./utils/shutdown');
const storage = require('./storage');
const { reviewAppearanceFromPreferences } = require('./utils/reviewAppearance');
const { setupChatGPT } = require('./utils/chatgpt');

// One process owns rotating OAuth tokens and the global shortcuts.
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.exit(0);

app.setName('Honest Father');
if (process.platform === 'win32') app.setAppUserModelId('com.squirrel.HonestFather.HonestFather');
const geminiSessionRef = { current: null };
let mainWindow = null;
const shutdown = createShutdownHandler({
    closeActiveSession: () => closeActiveSession(geminiSessionRef),
    stopAudioCapture: stopMacOSAudioCapture,
    closeLocalSession: () => require('./utils/localai').closeLocalSession(),
    unregisterShortcuts: disposeGlobalShortcuts,
});
const quitController = createQuitController({ shutdown, exit: code => app.exit(code) });
process.once('exit', quitController.processExited);

function createMainWindow() {
    if (process.platform === 'darwin') app.setActivationPolicy('accessory');
    mainWindow = createWindow(sendToRenderer, geminiSessionRef);
    setMainWindow(mainWindow, getReviewOverlay());
    if (process.platform === 'darwin') {
        app.dock.hide();
        const createdWindow = mainWindow;
        createdWindow.webContents.once('did-finish-load', () => {
            // macOS can restore regular activation during launch, after the first window was created.
            if (!quitController.isQuitting() && !createdWindow.isDestroyed()) app.setActivationPolicy('accessory');
        });
    }
    return mainWindow;
}

app.whenReady().then(async () => {
    if (!ownsInstance || quitController.isQuitting()) return;
    // Initialize storage (checks version, resets if needed)
    storage.initializeStorage();

    createMainWindow();
    setupChatGPT({
        window: () => mainWindow,
        disconnected: () => {
            if (require('./utils/gemini').isChatGPTSession()) {
                closeActiveSession(geminiSessionRef);
                stopMacOSAudioCapture();
                sendToRenderer('provider-session-ended', {
                    reason: 'ChatGPT account changed. Start a new session.',
                    code: 'chatgpt_account_changed',
                });
            }
        },
    });
    setupGeminiIpcHandlers(geminiSessionRef);
    setupStorageIpcHandlers();
    setupGeneralIpcHandlers();
});

app.on('window-all-closed', () => {
    stopMacOSAudioCapture();
    if (process.platform !== 'darwin' && !quitController.isQuitting()) {
        app.quit();
    }
});

app.on('before-quit', quitController.beginQuit);
app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('activate', () => {
    if (!ownsInstance || quitController.isQuitting()) return;
    if (!mainWindow || mainWindow.isDestroyed()) {
        createMainWindow();
    } else if (!getReviewOverlay()?.isActive()) {
        mainWindow.show();
    }
});

function setupStorageIpcHandlers() {
    // ============ CONFIG ============
    ipcMain.handle('storage:get-config', async () => {
        try {
            return { success: true, data: storage.getConfig() };
        } catch (error) {
            console.error('Error getting config:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-config', async (event, config) => {
        try {
            storage.setConfig(config);
            return { success: true };
        } catch (error) {
            console.error('Error setting config:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:update-config', async (event, key, value) => {
        try {
            storage.updateConfig(key, value);
            return { success: true };
        } catch (error) {
            console.error('Error updating config:', error);
            return { success: false, error: error.message };
        }
    });

    // ============ CREDENTIALS ============
    ipcMain.handle('storage:get-credentials', async () => {
        try {
            return { success: true, data: storage.getCredentials() };
        } catch (error) {
            console.error('Error getting credentials:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-credentials', async (event, credentials) => {
        try {
            storage.setCredentials(credentials);
            return { success: true };
        } catch (error) {
            console.error('Error setting credentials:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:get-api-key', async () => {
        try {
            return { success: true, data: storage.getApiKey() };
        } catch (error) {
            console.error('Error getting API key:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-api-key', async (event, apiKey) => {
        try {
            storage.setApiKey(apiKey);
            return { success: true };
        } catch (error) {
            console.error('Error setting API key:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:get-groq-api-key', async () => {
        try {
            return { success: true, data: storage.getGroqApiKey() };
        } catch (error) {
            console.error('Error getting Groq API key:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-groq-api-key', async (event, groqApiKey) => {
        try {
            storage.setGroqApiKey(groqApiKey);
            return { success: true };
        } catch (error) {
            console.error('Error setting Groq API key:', error);
            return { success: false, error: error.message };
        }
    });

    // ============ PREFERENCES ============
    ipcMain.handle('storage:get-preferences', async () => {
        try {
            return { success: true, data: storage.getPreferences() };
        } catch (error) {
            console.error('Error getting preferences:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-preferences', async (event, preferences) => {
        try {
            if (!storage.setPreferences(preferences)) throw new Error('Could not save preferences.');
            getReviewOverlay()?.setAppearance(reviewAppearanceFromPreferences(storage.getPreferences()));
            return { success: true };
        } catch (error) {
            console.error('Error setting preferences:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:update-preference', async (event, key, value) => {
        try {
            if (!storage.updatePreference(key, value)) throw new Error('Could not save preferences.');
            if (key === 'reviewMarkerColor' || key === 'reviewMarkerOpacity')
                getReviewOverlay()?.setAppearance(reviewAppearanceFromPreferences(storage.getPreferences()));
            return { success: true };
        } catch (error) {
            console.error('Error updating preference:', error);
            return { success: false, error: error.message };
        }
    });

    // ============ KEYBINDS ============
    ipcMain.handle('storage:get-keybinds', async () => {
        try {
            return { success: true, data: storage.getKeybinds() };
        } catch (error) {
            console.error('Error getting keybinds:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-keybinds', async (event, keybinds) => {
        try {
            const normalized = keybinds === null ? null : normalizeKeybinds(keybinds);
            if (!storage.setKeybinds(normalized)) throw new Error('Could not save keyboard shortcuts.');
            return { success: true };
        } catch (error) {
            console.error('Error setting keybinds:', error);
            return { success: false, error: error.message };
        }
    });

    // ============ HISTORY ============
    ipcMain.handle('storage:get-all-sessions', async () => {
        try {
            return { success: true, data: storage.getAllSessions() };
        } catch (error) {
            console.error('Error getting sessions:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:get-session', async (event, sessionId) => {
        try {
            return { success: true, data: storage.getSession(sessionId) };
        } catch (error) {
            console.error('Error getting session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:save-session', async (event, sessionId, data) => {
        try {
            storage.saveSession(sessionId, data);
            return { success: true };
        } catch (error) {
            console.error('Error saving session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:delete-session', async (event, sessionId) => {
        try {
            storage.deleteSession(sessionId);
            return { success: true };
        } catch (error) {
            console.error('Error deleting session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:delete-all-sessions', async () => {
        try {
            storage.deleteAllSessions();
            return { success: true };
        } catch (error) {
            console.error('Error deleting all sessions:', error);
            return { success: false, error: error.message };
        }
    });

    // ============ LIMITS ============
    ipcMain.handle('storage:get-today-limits', async () => {
        try {
            return { success: true, data: storage.getTodayLimits() };
        } catch (error) {
            console.error('Error getting today limits:', error);
            return { success: false, error: error.message };
        }
    });

    // ============ CLEAR ALL ============
    ipcMain.handle('storage:clear-all', async () => {
        try {
            storage.clearAllData();
            getReviewOverlay()?.setAppearance(reviewAppearanceFromPreferences(storage.getPreferences()));
            return { success: true };
        } catch (error) {
            console.error('Error clearing all data:', error);
            return { success: false, error: error.message };
        }
    });
}

function setupGeneralIpcHandlers() {
    ipcMain.handle('get-app-version', async () => {
        return app.getVersion();
    });

    ipcMain.handle('quit-application', async event => {
        try {
            app.quit();
            return { success: true };
        } catch (error) {
            console.error('Error quitting application:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('open-external', async (event, url) => {
        try {
            await shell.openExternal(url);
            return { success: true };
        } catch (error) {
            console.error('Error opening external URL:', error);
            return { success: false, error: error.message };
        }
    });

    const isMainWindowSender = event =>
        !quitController.isQuitting() && mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;

    ipcMain.handle('update-keybinds', (event, newKeybinds) => {
        if (!isMainWindowSender(event)) return { success: false, error: 'Invalid shortcut request.' };
        const previousKeybinds = getKeybindStatus().keybinds;
        const result = updateGlobalShortcuts(newKeybinds, mainWindow, sendToRenderer, geminiSessionRef);
        if (result.success && !storage.setKeybinds(result.keybinds)) {
            updateGlobalShortcuts(previousKeybinds, mainWindow, sendToRenderer, geminiSessionRef);
            return { success: false, error: 'Could not save keyboard shortcuts.', keybinds: previousKeybinds };
        }
        return result;
    });

    ipcMain.handle('get-keybind-status', event => {
        if (!isMainWindowSender(event)) return { success: false, error: 'Invalid shortcut request.' };
        return getKeybindStatus();
    });

    ipcMain.handle('set-shortcuts-paused', (event, paused) => {
        if (!isMainWindowSender(event) || typeof paused !== 'boolean') return { success: false, error: 'Invalid shortcut request.' };
        return setShortcutsPaused(paused);
    });

    // Debug logging from renderer
    ipcMain.on('log-message', (event, msg) => {
        console.log(msg);
    });
}
