// Launch the real Electron app with isolated storage and verify its rendered UI.
const { app, BrowserWindow } = require('electron');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const temporary = process.env.HONEST_FATHER_SMOKE_HOME;
assert.ok(temporary, 'Run this test through npm run test:smoke');
os.homedir = () => temporary;
app.setPath('userData', path.join(temporary, 'electron'));
const timeout = setTimeout(() => {
    console.error('Smoke test timed out.');
    app.exit(1);
}, 30000);
app.on('before-quit', () => console.log('Smoke lifecycle: before-quit'));
app.on('will-quit', () => console.log('Smoke lifecycle: will-quit'));
app.on('quit', (_event, code) => console.log('Smoke lifecycle: quit', code));
process.on('exit', code => {
    clearTimeout(timeout);
    console.log('Smoke lifecycle: process exit', code);
});
require('../src/index.js');
app.whenReady().then(async () => {
    try {
        assert.equal(typeof require('../src/utils/gemini').closeActiveSession, 'function', 'Session cleanup hook exists');
        const window = BrowserWindow.getAllWindows()[0];
        assert.ok(window, 'Main window exists');
        if (window.webContents.isLoadingMainFrame()) {
            await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
        }
        const errors = [];
        window.webContents.on('console-message', (...args) => {
            const message = args[1]?.message || args[2];
            if (typeof message === 'string' && /Uncaught|Failed to load module/i.test(message)) errors.push(message);
        });
        const result = await window.webContents.executeJavaScript(`(async () => {
            await customElements.whenDefined('cheating-daddy-app');
            const app = document.querySelector('cheating-daddy-app');
            await app.updateComplete;
            for (let i = 0; i < 100 && !app._storageLoaded; i++) await new Promise(resolve => setTimeout(resolve, 25));
            app.currentView = 'customize';
            await app.updateComplete;
            const settings = app.shadowRoot.querySelector('customize-view');
            await settings?.updateComplete;
            const quitVisible = settings?.shadowRoot.textContent.includes('Quit Application');
            app.currentView = 'main';
            const originalInitialize = window.cheatingDaddy.initializeGemini;
            const originalCapture = window.cheatingDaddy.startCapture;
            let captureCalls = 0;
            window.cheatingDaddy.initializeGemini = async () => false;
            window.cheatingDaddy.startCapture = async () => { captureCalls++; return true; };
            await app.handleStart();
            const rejectsFailedProvider = !app.sessionActive && captureCalls === 0;
            window.cheatingDaddy.initializeGemini = async () => true;
            window.cheatingDaddy.startCapture = async () => false;
            await app.handleStart();
            const rejectsFailedCapture = !app.sessionActive && app.currentView === 'main';
            captureCalls = 0;
            window.cheatingDaddy.initializeGemini = async () => { app.handleSessionEnded('Canceled during startup'); return true; };
            window.cheatingDaddy.startCapture = async () => { captureCalls++; return true; };
            await app.handleStart();
            const cancelsLateStartup = !app.sessionActive && captureCalls === 0;
            window.cheatingDaddy.initializeGemini = originalInitialize;
            const originalScreenshot = window.cheatingDaddy.captureManualScreenshot;
            let screenOnly = false;
            let screenshots = 0;
            await window.cheatingDaddy.storage.setApiKey('isolated-smoke-key');
            window.cheatingDaddy.startCapture = async (_interval, _quality, onlyScreen) => { screenOnly = onlyScreen; return true; };
            window.cheatingDaddy.captureManualScreenshot = async () => { screenshots++; return true; };
            await window.cheatingDaddy.handleShortcut('cmd+enter');
            const screenShortcutWorks = screenOnly && screenshots === 1 && app.sessionActive && app.currentView === 'assistant';
            await app.handleClose();
            window.cheatingDaddy.captureManualScreenshot = originalScreenshot;
            window.cheatingDaddy.startCapture = originalCapture;
            return {
                loaded: app._storageLoaded,
                title: document.title,
                settings: Boolean(settings),
                quitVisible, rejectsFailedProvider, rejectsFailedCapture, cancelsLateStartup, screenShortcutWorks,
                api: typeof window.cheatingDaddy.initializeGemini,
            };
        })()`);
        assert.equal(result.loaded, true);
        assert.match(result.title, /Honest Father/);
        assert.equal(result.api, 'function');
        assert.equal(result.settings, true);
        assert.equal(result.quitVisible, true);
        assert.equal(result.rejectsFailedProvider, true);
        assert.equal(result.rejectsFailedCapture, true);
        assert.equal(result.cancelsLateStartup, true);
        assert.equal(result.screenShortcutWorks, true);
        assert.deepEqual(errors, []);
        console.log('Honest Father Electron smoke passed:', JSON.stringify(result));
        app.quit();
    } catch (error) {
        console.error(error);
        clearTimeout(timeout);
        app.exit(1);
    }
});
