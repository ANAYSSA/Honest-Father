// Launch the real Electron app with isolated storage and verify its rendered UI.
const { app, BrowserWindow, screen, session } = require('electron');
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
        if (process.platform === 'darwin') {
            for (let attempt = 0; attempt < 100 && app.dock.isVisible(); attempt++) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(window.isVisible(), true, 'Hiding the Dock keeps the startup window visible');
            assert.equal(app.dock.isVisible(), false, 'macOS Dock icon stays hidden while the window is open');
            window.hide();
            window.showInactive();
            assert.equal(window.isVisible(), true, 'The window can still be shown without a Dock icon');
            assert.equal(app.dock.isVisible(), false, 'Showing the window does not restore its Dock icon');
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
            await app.updateComplete;
            const home = app.shadowRoot.querySelector('main-view');
            await home?.updateComplete;
            const reviewButtonVisible = home?.shadowRoot.textContent.includes('Start Test Review');
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
            let reviewCapture = false;
            window.cheatingDaddy.startCapture = async (_interval, _quality, onlyScreen, review) => { reviewCapture = onlyScreen && review; return true; };
            await app.handleScreenStart(true);
            const reviewStartWorks = reviewCapture && app.sessionActive && app.testReview && app.currentView === 'assistant';
            await app.handleClose();
            window.cheatingDaddy.captureManualScreenshot = originalScreenshot;
            window.cheatingDaddy.startCapture = originalCapture;
            return {
                loaded: app._storageLoaded,
                title: document.title,
                settings: Boolean(settings),
                quitVisible, rejectsFailedProvider, rejectsFailedCapture, cancelsLateStartup, screenShortcutWorks, reviewButtonVisible, reviewStartWorks,
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
        assert.equal(result.reviewButtonVisible, true);
        assert.equal(result.reviewStartWorks, true);
        // Capture a separate static synthetic tab, so hiding the Review renderer
        // does not also stop its source. No desktop pixels, audio, OS capture
        // permission, external browser, or provider are used.
        const manager = require('../src/utils/window').getReviewOverlay();
        const display = screen.getPrimaryDisplay();
        const mediaSource = new BrowserWindow({
            width: 800,
            height: 600,
            show: false,
            webPreferences: { backgroundThrottling: false },
        });
        await mediaSource.loadURL(
            `data:text/html,${encodeURIComponent('<!doctype html><body style="background:white;color:#111;font:24px Arial"><h1>Static practice fixture</h1><p>For n = 37, find n modulo 5.</p><p>○ A: zero</p><p>○ B: two</p><p>○ C: three</p><p>○ D: four</p></body>')}`
        );
        mediaSource.showInactive();
        let nativeRequests = 0;
        session.defaultSession.setDisplayMediaRequestHandler(
            (request, callback) => {
                nativeRequests++;
                assert.equal(request.frame, window.webContents.mainFrame);
                assert.equal(request.videoRequested, true);
                assert.equal(request.audioRequested, false);
                callback({ video: mediaSource.webContents.mainFrame });
            },
            { useSystemPicker: false }
        );
        for (const review of [false, true]) {
            if (review) assert.equal(manager.recordSource({ display_id: String(display.id) }).success, true);
            const capture = await window.webContents.executeJavaScript(`(async () => {
                const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
                let stream;
                let requested;
                navigator.mediaDevices.getDisplayMedia = async options => {
                    requested = options;
                    stream = await original(options);
                    return stream;
                };
                try {
                    const success = await window.cheatingDaddy.startCapture(5, 'medium', true, ${review});
                    const settings = stream?.getVideoTracks()[0].getSettings();
                    let rawFrames = null;
                    if (success && ${review}) {
                        if (typeof ImageCapture !== 'function') throw new Error('Native ImageCapture is unavailable');
                        const request = { generation: captureGeneration };
                        const dimensions = [];
                        const canvas = document.createElement('canvas');
                        const context = canvas.getContext('2d', { willReadFrequently: true });
                        for (let read = 0; read < 2; read++) {
                            // The real hidden Test Review renderer reads the existing
                            // static tab track before and after a simulated AI wait.
                            // No HTMLVideoElement/compositor callbacks are involved.
                            const bitmap = await grabReviewBitmap(stream, request, true);
                            if (!bitmap) throw new Error('Native static frame read was canceled');
                            try {
                                canvas.width = bitmap.width;
                                canvas.height = bitmap.height;
                                context.drawImage(bitmap, 0, 0);
                                const pixels = context.getImageData(0, 0, 1, 1);
                                dimensions.push({ width: bitmap.width, height: bitmap.height, readable: pixels.data.length === 4 });
                            } finally {
                                bitmap.close();
                            }
                            if (read === 0) await new Promise(resolve => setTimeout(resolve, 250));
                        }
                        rawFrames = { dimensions, detachedVideo: hiddenVideo !== null };
                    }
                    return {success, requested, width:settings?.width,height:settings?.height,frameRate:settings?.frameRate,rawFrames};
                } finally {
                    window.cheatingDaddy.stopCapture();
                    await require('electron').ipcRenderer.invoke('review:end');
                    navigator.mediaDevices.getDisplayMedia = original;
                }
            })()`);
            assert.equal(capture.success, true, 'Real getDisplayMedia negotiation succeeds');
            assert.equal(capture.requested.video, true, 'Initial media capture has no forced resolution or FPS constraints');
            assert.equal(capture.requested.audio, false);
            assert.ok(capture.width > 0 && capture.height > 0);
            assert.ok(capture.frameRate <= (review ? 5 : 1));
            if (review) {
                assert.equal(window.isVisible(), true, 'Smoke cleanup restores the main window');
                assert.equal(capture.rawFrames.detachedVideo, false, 'Native Review snapshots bypass the detached video compositor');
                assert.equal(capture.rawFrames.dimensions.length, 2);
                for (const frame of capture.rawFrames.dimensions) {
                    assert.ok(frame.width > 0 && frame.height > 0, 'A hidden static source delivers a native ImageCapture bitmap');
                    assert.equal(frame.readable, true);
                }
            }
            console.log('Native synthetic media negotiation passed:', JSON.stringify({ review, ...capture }));
        }
        assert.equal(nativeRequests, 2, 'Each start acquires one stream without retrying');
        if (process.platform === 'darwin') {
            session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback(null), { useSystemPicker: false });
            const denial = await window.webContents.executeJavaScript(`(async () => {
                const success=await window.cheatingDaddy.startCapture(5,'medium',true);
                const app=document.querySelector('cheating-daddy-app');
                return {success,status:app.statusText};
            })()`);
            assert.equal(denial.success, false);
            assert.doesNotMatch(denial.status, /Invalid capture constraints/);
            assert.match(denial.status, /macOS|Screen & System Audio Recording/);
        }
        mediaSource.destroy();
        const tracking = await window.webContents.executeJavaScript(`(() => {
            const { createReviewFrameTracker } = require('./utils/reviewFrame');
            const canvas = document.createElement('canvas');
            canvas.width = 1000; canvas.height = 800;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const draw = (dy = 0, changed = false) => {
                ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1000, 800);
                ctx.fillStyle = '#111'; ctx.font = '24px Arial';
                ctx.fillText(changed ? 'Which integral matches this expression?' : 'Which remainder matches this expression?', 130, 130 + dy);
                ctx.fillText('For n = 37, find n modulo 5.', 130, 170 + dy);
                ['A: exactly zero', 'B: remainder two', 'C: remainder three', 'D: remainder four'].forEach((text, i) => {
                    const y = 270 + i * 60 + dy;
                    ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.arc(140, y - 8, 10, 0, 2 * Math.PI); ctx.stroke();
                    ctx.fillText(text, 170, y);
                });
                return ctx.getImageData(0, 0, 1000, 800);
            };
            const answer = { questionBox: [100, 100, 650, 900], answers: [{ label: 'B', box: [390, 128, 418, 152] }], confidence: .95 };
            const base = draw();
            const moved = draw(61);
            const tracker = createReviewFrameTracker(base, answer);
            const initial = tracker.locate(draw());
            const start = performance.now();
            const scroll = tracker.locate(moved);
            const elapsed = performance.now() - start;
            const changed = tracker.locate(draw(61, true));
            const restored = tracker.locate(draw());
            const clipped = tracker.locate(draw(400));
            return { initial: initial.state, scroll: scroll.state, reason: scroll.reason, offset: scroll.offset, changed: changed.state, restored: restored.state, clipped: clipped.state, elapsed };
        })()`);
        assert.equal(tracking.initial, 'matched', 'Real browser-rendered text can be tracked');
        assert.equal(tracking.scroll, 'matched', 'Local tracking follows browser-rendered text during scrolling');
        assert.ok(Math.abs(tracking.offset.y - 76.25) < 1.5);
        assert.equal(tracking.changed, 'hidden', 'Changed question text hides a cached choice');
        assert.equal(tracking.restored, 'matched');
        assert.equal(tracking.clipped, 'hidden');
        assert.ok(tracking.elapsed < 2000, 'Local tracking has bounded processing time');
        console.log('Synthetic browser text tracking passed:', JSON.stringify(tracking));
        // Exercise the real isolated overlay without capturing a screen or calling any provider.
        assert.equal(manager.recordSource({ display_id: String(display.id) }).success, true);
        assert.equal(manager.begin().success, true);
        assert.equal(window.isVisible(), false);
        const token = manager.prepareCapture();
        const answer = { questionBox: [100, 100, 800, 800], answers: [{ label: 'B', box: [350, 120, 375, 145] }], confidence: 0.95 };
        const dimensions = { imageWidth: display.bounds.width, imageHeight: display.bounds.height };
        assert.equal(manager.cacheAnswer(token, answer, dimensions).success, true);
        assert.equal(manager.showAnswer(token, { x: 0, y: 20 }).success, true);
        const overlay = BrowserWindow.getAllWindows().find(candidate => candidate !== window);
        assert.ok(overlay, 'Review uses a separate overlay window');
        assert.deepEqual(overlay.getBounds(), display.bounds, 'Overlay covers the complete captured display in DIP');
        if (overlay.webContents.isLoadingMainFrame()) await new Promise(resolve => overlay.webContents.once('did-finish-load', resolve));
        const rendered = await overlay.webContents.executeJavaScript(`({
            rings: document.querySelectorAll('.answer-ring').length,
            cy: Number(document.querySelector('.answer-ring')?.getAttribute('cy')),
            nodeDisabled: typeof window.require === 'undefined',
            secureListener: typeof window.reviewOverlay?.onUpdate === 'function'
        })`);
        assert.equal(rendered.rings, 1);
        assert.ok(Math.abs(rendered.cy - 0.3825 * display.bounds.height) < 0.01);
        assert.equal(rendered.nodeDisabled, true);
        assert.equal(rendered.secureListener, true);
        assert.equal(overlay.isVisible(), true);
        assert.equal(overlay.isFocusable(), false);
        assert.equal(manager.toggle().visible, false);
        assert.equal(manager.moveAnswer(token, { x: 0, y: -20 }).visible, false, 'Local scrolling respects a hidden mark');
        assert.equal(manager.toggle().visible, true);
        assert.equal(manager.toggle().visible, false);
        assert.equal(manager.status('Error: Synthetic provider failure.').success, true);
        assert.equal(overlay.isVisible(), false, 'A review error never auto-reveals the hidden overlay');
        assert.equal(window.isVisible(), false, 'A review error never auto-reveals the main window');
        assert.equal(manager.toggle().visible, true, 'The visibility shortcut deliberately reveals a stored error');
        const notice = await overlay.webContents.executeJavaScript(`({
            text: document.getElementById('notice').textContent,
            hidden: document.getElementById('notice').hidden,
            rings: document.querySelectorAll('.answer-ring').length
        })`);
        assert.equal(notice.text, 'Error: Synthetic provider failure.');
        assert.equal(notice.hidden, false);
        assert.equal(notice.rings, 0, 'An error removes previous answer rings');
        assert.equal(manager.toggle().visible, false, 'The next visibility shortcut hides the stored error');
        assert.equal(manager.moveAnswer(token, { x: 0, y: 0 }).visible, false, 'Late tracking cannot replace or reveal an error');
        const afterTracking = await overlay.webContents.executeJavaScript(`({
            text: document.getElementById('notice').textContent,
            rings: document.querySelectorAll('.answer-ring').length
        })`);
        assert.equal(afterTracking.text, 'Error: Synthetic provider failure.');
        assert.equal(afterTracking.rings, 0);
        assert.equal(overlay.isVisible(), false);
        assert.equal(window.isVisible(), false);
        if (process.platform === 'darwin') assert.equal(app.dock.isVisible(), false, 'Overlay never restores the Dock icon');
        manager.end();
        assert.equal(BrowserWindow.getAllWindows().length, 1, 'Ending review destroys its overlay');
        assert.deepEqual(errors, []);
        console.log('Honest Father Electron smoke passed:', JSON.stringify(result));
        app.quit();
    } catch (error) {
        console.error(error);
        clearTimeout(timeout);
        app.exit(1);
    }
});
