const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { mapReviewAnswerToDisplay } = require('./testReview');

const UPDATE_CHANNEL = 'review-overlay:update';
const BOUNDS_ERROR = 'The review overlay could not cover the captured display. Start a new session.';

function copyDisplay(display) {
    if (
        !display ||
        !['string', 'number'].includes(typeof display.id) ||
        !display.bounds ||
        !['x', 'y', 'width', 'height'].every(key => typeof display.bounds[key] === 'number' && Number.isFinite(display.bounds[key])) ||
        display.bounds.width <= 0 ||
        display.bounds.height <= 0 ||
        typeof display.scaleFactor !== 'number' ||
        !Number.isFinite(display.scaleFactor) ||
        display.scaleFactor <= 0 ||
        typeof display.rotation !== 'number' ||
        !Number.isFinite(display.rotation)
    ) {
        throw new Error('The captured display is no longer available. Start a new review session.');
    }
    return {
        id: display.id,
        bounds: { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height },
        scaleFactor: display.scaleFactor,
        rotation: display.rotation,
    };
}

function displaySignature(display) {
    const value = copyDisplay(display);
    return JSON.stringify([
        String(value.id),
        value.bounds.x,
        value.bounds.y,
        value.bounds.width,
        value.bounds.height,
        value.scaleFactor,
        value.rotation,
    ]);
}

function createReviewOverlay({
    BrowserWindow,
    screen,
    mainWindow,
    platform = process.platform,
    onEnd = () => {},
    onWindowCreated = () => {},
    createId = randomUUID,
    logger = console,
}) {
    let active = false;
    let selectedDisplay = null;
    let captureToken = null;
    let cachedAnswer = null;
    const answerHistory = [];
    let overlayWindow = null;
    let overlayReady = false;
    let desiredVisible = false;
    let userWantsAnswerVisible = false;
    let pendingUpdate = { kind: 'clear' };
    const lifecycleListeners = [];
    const overlayListeners = [];

    const failure = error => ({ success: false, error });
    const mainAvailable = () => !mainWindow.isDestroyed();
    const currentDisplay = () => screen.getAllDisplays().find(display => String(display.id) === String(selectedDisplay?.id));
    const listen = (target, event, listener, list) => {
        target.on(event, listener);
        list.push(() => target.removeListener(event, listener));
    };
    const removeListeners = list => {
        for (const remove of list.splice(0)) remove();
    };

    function restoreDisplayBounds() {
        if (!selectedDisplay || !overlayWindow || overlayWindow.isDestroyed()) return;
        const bounds = overlayWindow.getBounds();
        if (['x', 'y', 'width', 'height'].every(key => bounds[key] === selectedDisplay.bounds[key])) return;
        // Windows can fit constructor bounds to the work area, excluding the
        // taskbar. The annotation coordinate system covers the entire display.
        overlayWindow.setBounds({ ...selectedDisplay.bounds }, false);
        const restored = overlayWindow.getBounds();
        if (!['x', 'y', 'width', 'height'].every(key => restored[key] === selectedDisplay.bounds[key])) throw new Error(BOUNDS_ERROR);
    }

    function flushUpdate() {
        if (!overlayWindow || overlayWindow.isDestroyed() || !overlayReady) return true;
        if (desiredVisible) {
            try {
                restoreDisplayBounds();
            } catch (error) {
                endUnexpectedly(error.message);
                return false;
            }
        }
        overlayWindow.webContents.send(UPDATE_CHANNEL, pendingUpdate);
        if (desiredVisible) overlayWindow.showInactive();
        else overlayWindow.hide();
        return true;
    }

    function hideOverlay() {
        desiredVisible = false;
        pendingUpdate = { kind: 'clear' };
        if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
        flushUpdate();
    }

    function invalidateCapture() {
        captureToken = null;
        cachedAnswer = null;
        userWantsAnswerVisible = false;
        hideOverlay();
    }

    function end(reason) {
        const wasActive = active;
        active = false;
        invalidateCapture();
        selectedDisplay = null;
        answerHistory.length = 0;
        removeListeners(lifecycleListeners);
        removeListeners(overlayListeners);
        const oldOverlay = overlayWindow;
        overlayWindow = null;
        overlayReady = false;
        if (oldOverlay && !oldOverlay.isDestroyed()) oldOverlay.destroy();
        if (wasActive && mainAvailable()) mainWindow.showInactive();
        return { success: true, ...(reason ? { reason } : {}) };
    }

    function endUnexpectedly(reason) {
        if (!active) return;
        end(reason);
        try {
            onEnd({ reason });
        } catch (error) {
            logger.warn('Could not report the ended review session:', error.message);
        }
    }

    function ensureUnchangedDisplay() {
        try {
            const display = currentDisplay();
            if (!display || displaySignature(display) !== displaySignature(selectedDisplay)) {
                endUnexpectedly('The captured display changed. Start a new review session.');
                return false;
            }
            return true;
        } catch {
            endUnexpectedly('The captured display is no longer available. Start a new review session.');
            return false;
        }
    }

    function createOverlayWindow() {
        overlayWindow = new BrowserWindow({
            ...selectedDisplay.bounds,
            show: false,
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            hasShadow: false,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            closable: false,
            focusable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            webPreferences: {
                preload: path.join(__dirname, '../review-overlay-preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                allowRunningInsecureContent: false,
                backgroundThrottling: false,
            },
        });
        overlayWindow.setIgnoreMouseEvents(true, { forward: true });
        overlayWindow.setContentProtection(true);
        overlayWindow.setSkipTaskbar(true);
        overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        overlayWindow.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: true,
            ...(platform === 'darwin' ? { skipTransformProcessType: true } : {}),
        });
        if (platform === 'darwin') overlayWindow.setHiddenInMissionControl(true);
        overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        listen(overlayWindow.webContents, 'will-navigate', event => event.preventDefault(), overlayListeners);
        listen(
            overlayWindow.webContents,
            'did-finish-load',
            () => {
                if (!active || !overlayWindow || overlayWindow.isDestroyed()) return;
                overlayReady = true;
                try {
                    restoreDisplayBounds();
                } catch (error) {
                    endUnexpectedly(error.message);
                    return;
                }
                onWindowCreated(overlayWindow);
                flushUpdate();
            },
            overlayListeners
        );
        listen(
            overlayWindow.webContents,
            'render-process-gone',
            () => endUnexpectedly('The review overlay stopped. Start a new session.'),
            overlayListeners
        );
        listen(
            overlayWindow.webContents,
            'did-fail-load',
            () => endUnexpectedly('The review overlay could not load. Start a new session.'),
            overlayListeners
        );
        listen(overlayWindow, 'closed', () => endUnexpectedly('The review overlay closed. Start a new session.'), overlayListeners);
        const createdOverlay = overlayWindow;
        restoreDisplayBounds();
        onWindowCreated(createdOverlay);
        const load = overlayWindow.loadFile(path.join(__dirname, '../review-overlay.html'));
        if (load && typeof load.catch === 'function') {
            load.catch(() => {
                if (overlayWindow === createdOverlay) endUnexpectedly('The review overlay could not load. Start a new session.');
            });
        }
    }

    function recordSource(source) {
        try {
            const display = screen.getAllDisplays().find(item => String(item.id) === String(source?.display_id));
            if (!display) throw new Error('The screen capture source could not be matched to a display. Start a new session.');
            const nextDisplay = copyDisplay(display);
            if (active && displaySignature(nextDisplay) !== displaySignature(selectedDisplay)) {
                endUnexpectedly('The capture source changed. Start a new review session.');
                return failure('The capture source changed. Start a new review session.');
            }
            invalidateCapture();
            selectedDisplay = nextDisplay;
            return { success: true, display: copyDisplay(nextDisplay) };
        } catch (error) {
            if (active) endUnexpectedly(error.message);
            else selectedDisplay = null;
            return failure(error.message);
        }
    }

    function begin() {
        if (!mainAvailable()) return failure('The main window is no longer available.');
        if (!selectedDisplay) return failure('Start screen capture before starting test review.');
        if (active) return { success: true };
        if (!ensureUnchangedDisplay()) return failure('The captured display changed. Start screen capture again.');
        active = true;
        try {
            listen(
                screen,
                'display-removed',
                (_, display) => {
                    if (String(display?.id) === String(selectedDisplay?.id))
                        endUnexpectedly('The captured display was disconnected. Start a new session.');
                },
                lifecycleListeners
            );
            listen(
                screen,
                'display-metrics-changed',
                (_, display) => {
                    if (String(display?.id) === String(selectedDisplay?.id)) ensureUnchangedDisplay();
                },
                lifecycleListeners
            );
            listen(mainWindow, 'closed', () => endUnexpectedly('The main window closed.'), lifecycleListeners);
            listen(
                mainWindow.webContents,
                'render-process-gone',
                () => endUnexpectedly('The main window stopped. Start a new session.'),
                lifecycleListeners
            );
            createOverlayWindow();
            mainWindow.hide();
            return { success: true };
        } catch (error) {
            end();
            return failure(`The review overlay could not start: ${error.message}`);
        }
    }

    function prepareCapture() {
        if (!active || !mainAvailable()) return failure('Start a test review session first.');
        if (!ensureUnchangedDisplay()) return failure('The captured display changed. Start a new review session.');
        invalidateCapture();
        mainWindow.hide();
        captureToken = { captureId: createId(), requestId: createId(), display: copyDisplay(selectedDisplay) };
        return { ...captureToken, display: copyDisplay(captureToken.display) };
    }

    function matchesToken(token) {
        if (!token || !captureToken || typeof token.captureId !== 'string' || typeof token.requestId !== 'string') return false;
        if (token.captureId !== captureToken.captureId || token.requestId !== captureToken.requestId) return false;
        try {
            return displaySignature(token.display) === displaySignature(captureToken.display);
        } catch {
            return false;
        }
    }

    function validateCapture(token, dimensions) {
        if (!active || !matchesToken(token)) return failure('This review capture is no longer current. Capture the question again.');
        if (!ensureUnchangedDisplay()) return failure('The captured display changed. Start a new review session.');
        if (
            !dimensions ||
            !Number.isInteger(dimensions.imageWidth) ||
            !Number.isInteger(dimensions.imageHeight) ||
            dimensions.imageWidth <= 0 ||
            dimensions.imageHeight <= 0
        ) {
            return failure('The review screenshot has invalid dimensions. Capture the question again.');
        }
        const expectedAspect = selectedDisplay.bounds.width / selectedDisplay.bounds.height;
        const imageAspect = dimensions.imageWidth / dimensions.imageHeight;
        if (Math.abs(imageAspect / expectedAspect - 1) > 0.02) {
            return failure('The screenshot does not match the captured display. Start a new review session.');
        }
        return { success: true, display: copyDisplay(selectedDisplay) };
    }

    function cacheAnswer(token, answer, dimensions) {
        const validation = validateCapture(token, dimensions);
        if (!validation.success) return validation;
        try {
            const mapped = mapReviewAnswerToDisplay(answer, selectedDisplay.bounds);
            const normalizedAnswer = {
                questionBox: [...answer.questionBox],
                answers: answer.answers.map(choice => ({ label: choice.label, box: [...choice.box] })),
                confidence: answer.confidence,
            };
            cachedAnswer = {
                token: { ...captureToken, display: copyDisplay(captureToken.display) },
                mapped,
                normalizedAnswer,
                dimensions: { ...dimensions },
                locationValid: false,
            };
            userWantsAnswerVisible = true;
            rememberAnswer(cachedAnswer);
            return { success: true };
        } catch (error) {
            return failure(error.message);
        }
    }

    function rememberAnswer(answer) {
        const index = answerHistory.findIndex(
            item => item.token.captureId === answer.token.captureId && item.token.requestId === answer.token.requestId
        );
        if (index >= 0) answerHistory.splice(index, 1);
        answerHistory.push(answer);
        while (answerHistory.length > 3) answerHistory.shift();
    }

    function shiftAnswer(answer, offset) {
        if (!offset || !['x', 'y'].every(key => typeof offset[key] === 'number' && Number.isFinite(offset[key]) && Math.abs(offset[key]) <= 1000)) {
            throw new Error('The review control moved outside the captured question.');
        }
        const shiftBox = box => [box[0] + offset.y, box[1] + offset.x, box[2] + offset.y, box[3] + offset.x];
        return {
            questionBox: shiftBox(answer.questionBox),
            answers: answer.answers.map(choice => ({ label: choice.label, box: shiftBox(choice.box) })),
            confidence: answer.confidence,
        };
    }

    function reuseAnswer(token, sourceToken, offset) {
        const sourceIndex = answerHistory.findIndex(
            item => item.token.captureId === sourceToken?.captureId && item.token.requestId === sourceToken?.requestId
        );
        if (sourceIndex < 0) return failure('There is no saved review answer for this question.');
        const source = answerHistory[sourceIndex];
        const validation = validateCapture(token, source.dimensions);
        if (!validation.success) return validation;
        try {
            if (
                displaySignature(sourceToken.display) !== displaySignature(selectedDisplay) ||
                displaySignature(source.token.display) !== displaySignature(selectedDisplay)
            ) {
                return failure('The saved answer belongs to a different display.');
            }
            const shifted = shiftAnswer(source.normalizedAnswer, offset);
            mapReviewAnswerToDisplay(shifted, selectedDisplay.bounds);
            answerHistory.splice(sourceIndex, 1);
            const result = cacheAnswer(token, shifted, source.dimensions);
            if (!result.success) return result;
            return {
                success: true,
                reviewAnswer: {
                    questionBox: [...shifted.questionBox],
                    answers: shifted.answers.map(choice => ({ label: choice.label, box: [...choice.box] })),
                    confidence: shifted.confidence,
                },
            };
        } catch (error) {
            return failure(error.message);
        }
    }

    function showAnswer(token, offset) {
        if (!cachedAnswer || !matchesToken(token)) return failure('There is no current review answer to show. Capture a question first.');
        const validation = validateCapture(token, cachedAnswer.dimensions);
        if (!validation.success) return validation;
        if (offset !== undefined) {
            const moved = moveAnswer(token, offset);
            if (!moved.success) return moved;
        }
        if (!cachedAnswer.locationValid) return failure('The question is no longer visible. Scroll back or capture it again.');
        pendingUpdate = { kind: 'answer', ...cachedAnswer.mapped };
        userWantsAnswerVisible = true;
        desiredVisible = true;
        if (!flushUpdate()) return failure(BOUNDS_ERROR);
        return { success: true, visible: true };
    }

    function hideAnswer(token) {
        if (!cachedAnswer || !matchesToken(token)) return failure('This review capture is no longer current.');
        cachedAnswer.locationValid = false;
        hideOverlay();
        return { success: true };
    }

    function moveAnswer(token, offset) {
        if (!cachedAnswer || !matchesToken(token)) return failure('This review capture is no longer current.');
        const validation = validateCapture(token, cachedAnswer.dimensions);
        if (!validation.success) return validation;
        try {
            const shifted = shiftAnswer(cachedAnswer.normalizedAnswer, offset);
            cachedAnswer.mapped = mapReviewAnswerToDisplay(shifted, selectedDisplay.bounds);
            cachedAnswer.locationValid = true;
            pendingUpdate = { kind: 'answer', ...cachedAnswer.mapped };
            desiredVisible = userWantsAnswerVisible;
            if (!flushUpdate()) return failure(BOUNDS_ERROR);
            return { success: true, visible: desiredVisible };
        } catch (error) {
            hideAnswer(token);
            return failure(error.message);
        }
    }

    function clear(token) {
        if (!matchesToken(token)) return failure('This review capture is no longer current.');
        invalidateCapture();
        return { success: true };
    }

    function status(text) {
        if (!active || !ensureUnchangedDisplay()) return failure('There is no active review session.');
        if (text === '') {
            if (pendingUpdate.kind === 'status') hideOverlay();
            return { success: true };
        }
        if (typeof text !== 'string' || !text.trim() || text.length > 500) return failure('The review notice is invalid.');
        pendingUpdate = { kind: 'status', text: text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() };
        desiredVisible = true;
        if (!flushUpdate()) return failure(BOUNDS_ERROR);
        return { success: true };
    }

    function toggle() {
        if (!active || !mainAvailable() || !ensureUnchangedDisplay()) return failure('There is no active review session.');
        if (!cachedAnswer) {
            if (mainWindow.isVisible()) {
                mainWindow.hide();
                const shortcut = platform === 'darwin' ? 'Cmd + Enter' : 'Ctrl + Enter';
                status(`Capture a practice question with ${shortcut}. Use the show/hide shortcut again to open settings or end the session.`);
            } else {
                hideOverlay();
                mainWindow.showInactive();
            }
            return { success: true, visible: mainWindow.isVisible() };
        }
        mainWindow.hide();
        userWantsAnswerVisible = !userWantsAnswerVisible;
        if (!cachedAnswer.locationValid || !userWantsAnswerVisible) {
            hideOverlay();
            return { success: true, visible: false };
        }
        return showAnswer(cachedAnswer.token);
    }

    return {
        recordSource,
        begin,
        prepareCapture,
        validateCapture,
        cacheAnswer,
        reuseAnswer,
        showAnswer,
        hideAnswer,
        moveAnswer,
        clear,
        toggle,
        status,
        end,
        isActive: () => active,
    };
}

module.exports = { createReviewOverlay };
