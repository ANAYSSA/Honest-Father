// renderer.js
const { ipcRenderer } = require('electron');
const { createReviewFrameTracker } = require('./utils/reviewFrame');

let mediaStream = null;
let screenshotInterval = null;
let audioContext = null;
let audioProcessor = null;
let micAudioProcessor = null;
let micAudioContext = null;
let microphoneStream = null;
let captureGeneration = 0;
let captureScreenOnly = false;
let captureTestReview = false;
let audioBuffer = [];
const SAMPLE_RATE = 24000;
const AUDIO_CHUNK_DURATION = 0.1; // seconds
const BUFFER_SIZE = 4096; // Increased buffer size for smoother audio

let hiddenVideo = null;
let offscreenCanvas = null;
let offscreenContext = null;
let currentImageQuality = 'medium'; // Store current image quality for manual screenshots
let screenshotRequest = null;
let reviewFrameGuard = null;
let reviewWatchdog = null;
let reviewQuestionCache = [];
const REVIEW_CACHE_BYTES = 32 * 1024 * 1024;

const isLinux = process.platform === 'linux';
const isMacOS = process.platform === 'darwin';

// ============ STORAGE API ============
// Wrapper for IPC-based storage access
const storage = {
    // Config
    async getConfig() {
        const result = await ipcRenderer.invoke('storage:get-config');
        return result.success ? result.data : {};
    },
    async setConfig(config) {
        return ipcRenderer.invoke('storage:set-config', config);
    },
    async updateConfig(key, value) {
        return ipcRenderer.invoke('storage:update-config', key, value);
    },

    // Credentials
    async getCredentials() {
        const result = await ipcRenderer.invoke('storage:get-credentials');
        return result.success ? result.data : {};
    },
    async setCredentials(credentials) {
        return ipcRenderer.invoke('storage:set-credentials', credentials);
    },
    async getApiKey() {
        const result = await ipcRenderer.invoke('storage:get-api-key');
        return result.success ? result.data : '';
    },
    async setApiKey(apiKey) {
        return ipcRenderer.invoke('storage:set-api-key', apiKey);
    },
    async getGroqApiKey() {
        const result = await ipcRenderer.invoke('storage:get-groq-api-key');
        return result.success ? result.data : '';
    },
    async setGroqApiKey(groqApiKey) {
        return ipcRenderer.invoke('storage:set-groq-api-key', groqApiKey);
    },

    // Preferences
    async getPreferences() {
        const result = await ipcRenderer.invoke('storage:get-preferences');
        return result.success ? result.data : {};
    },
    async setPreferences(preferences) {
        return ipcRenderer.invoke('storage:set-preferences', preferences);
    },
    async updatePreference(key, value) {
        return ipcRenderer.invoke('storage:update-preference', key, value);
    },

    // Keybinds
    async getKeybinds() {
        const result = await ipcRenderer.invoke('storage:get-keybinds');
        return result.success ? result.data : null;
    },
    async setKeybinds(keybinds) {
        return ipcRenderer.invoke('storage:set-keybinds', keybinds);
    },

    // Sessions (History)
    async getAllSessions() {
        const result = await ipcRenderer.invoke('storage:get-all-sessions');
        return result.success ? result.data : [];
    },
    async getSession(sessionId) {
        const result = await ipcRenderer.invoke('storage:get-session', sessionId);
        return result.success ? result.data : null;
    },
    async saveSession(sessionId, data) {
        return ipcRenderer.invoke('storage:save-session', sessionId, data);
    },
    async deleteSession(sessionId) {
        return ipcRenderer.invoke('storage:delete-session', sessionId);
    },
    async deleteAllSessions() {
        return ipcRenderer.invoke('storage:delete-all-sessions');
    },

    // Clear all
    async clearAll() {
        return ipcRenderer.invoke('storage:clear-all');
    },

    // Limits
    async getTodayLimits() {
        const result = await ipcRenderer.invoke('storage:get-today-limits');
        return result.success ? result.data : { flash: { count: 0 }, flashLite: { count: 0 } };
    },
};

// Cache for preferences to avoid async calls in hot paths
let preferencesCache = null;

async function loadPreferencesCache() {
    preferencesCache = await storage.getPreferences();
    return preferencesCache;
}

// Initialize preferences cache
loadPreferencesCache();

function convertFloat32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        // Improved scaling to prevent clipping
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function initializeGemini(profile = 'interview', language = 'en-US') {
    const apiKey = await storage.getApiKey();
    if (!apiKey || !apiKey.trim()) {
        cheatingDaddy.setStatus('Error: Enter a Gemini API key in Home.');
        return false;
    }
    try {
        const prefs = await storage.getPreferences();
        const success = await ipcRenderer.invoke('initialize-gemini', apiKey.trim(), prefs.customPrompt || '', profile, language);
        if (success) cheatingDaddy.setStatus('Live');
        return Boolean(success);
    } catch (error) {
        cheatingDaddy.setStatus(`Error: Unable to start Gemini: ${error.message}`);
        return false;
    }
}

async function initializeLocal(profile = 'interview') {
    const prefs = await storage.getPreferences();
    const localLlmModel = prefs.localLlmModel || 'unsloth/Qwen3.5-4B-GGUF:Q4_K_M';
    const whisperModel = prefs.whisperModel || 'tiny.en';
    const customPrompt = prefs.customPrompt || '';

    const success = await ipcRenderer.invoke('initialize-local', localLlmModel, whisperModel, profile, customPrompt);
    if (success) {
        cheatingDaddy.setStatus('Local AI Live');
        return true;
    } else {
        cheatingDaddy.setStatus('error');
        return false;
    }
}

async function cancelLocalInitialization() {
    return ipcRenderer.invoke('cancel-local-initialization');
}

async function initializeCloud(profile = 'interview') {
    const creds = await storage.getCredentials();
    const token = creds.cloudToken;
    if (!token || !token.trim()) {
        cheatingDaddy.setStatus('error');
        return false;
    }

    const prefs = await storage.getPreferences();
    const success = await ipcRenderer.invoke('initialize-cloud', token, profile, prefs.customPrompt || '');
    if (success) {
        cheatingDaddy.setStatus('Live');
        return true;
    } else {
        cheatingDaddy.setStatus('error');
        return false;
    }
}

// Listen for status updates
ipcRenderer.on('update-status', (event, status) => {
    console.log('Status update:', status);
    cheatingDaddy.setStatus(status);
});

function explainMacScreenCaptureFailure(error, diagnostics) {
    const invalidCapture = /^Invalid capture constraints\.?$/i.test(error?.message?.trim() || '');
    const captureFailure =
        invalidCapture || ['AbortError', 'NotAllowedError', 'PermissionDeniedError', 'NotReadableError', 'NotFoundError'].includes(error?.name);
    if (!captureFailure) return error;

    const permissionStatus = diagnostics?.permissionStatus;
    const failure = diagnostics?.failure;
    const failureAge = typeof failure?.at === 'number' ? Date.now() - failure.at : Infinity;
    const requestFailureCodes = ['invalid_request', 'capture_cancelled', 'source_selection_failed', 'capture_callback_failed'];
    const knownFailureCodes = ['source_enumeration_failed', 'no_screen_sources', ...requestFailureCodes];
    const sourceError =
        failureAge >= 0 && failureAge <= 10000 && knownFailureCodes.includes(failure?.code) && typeof failure?.error === 'string'
            ? failure.error
                  .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 512)
            : '';
    const failureStage = ['request', 'sources', 'source-selected', 'callback'].includes(failure?.stage) ? failure.stage : 'unknown';
    const sourceDetails = sourceError ? `Capture failure (code: ${failure.code}, stage: ${failureStage}): ${sourceError}. ` : '';
    const permissionHelp = 'Allow Honest Father in System Settings > Privacy & Security > Screen & System Audio Recording, then restart the app.';

    // A callback rejection also produces AbortError. Keep its actual request cause
    // even if macOS reports that this process currently lacks screen access.
    if (sourceError && requestFailureCodes.includes(failure.code)) {
        return new Error(`${sourceDetails}Quit Honest Father completely and reopen it before starting a new session.`);
    }
    if (['denied', 'restricted'].includes(permissionStatus)) {
        if (sourceError && failure.code === 'source_enumeration_failed') {
            return new Error(
                'macOS rejected screen capture for the running copy of Honest Father. ' +
                    sourceDetails +
                    'An enabled Honest Father entry in Settings may refer to an older copy. ' +
                    'In System Settings > Privacy & Security > Screen & System Audio Recording, remove the old Honest Father entry, ' +
                    'add the installed app again, then quit Honest Father completely and reopen it.'
            );
        }
        return new Error(sourceDetails + permissionHelp);
    }
    if (permissionStatus === 'granted' && (sourceError || error?.name === 'AbortError')) {
        return new Error(
            'macOS could not start screen capture even though Screen Recording permission is enabled. ' +
                sourceDetails +
                'Quit Honest Father completely and reopen it. If this continues, in System Settings > Privacy & Security > Screen & System Audio Recording, ' +
                'remove Honest Father, add the installed app again, then restart it.'
        );
    }
    if (sourceError) return new Error(`macOS could not provide the screen stream. ${sourceDetails}Restart the app and try again.`);
    if (permissionStatus !== 'granted' && ['NotAllowedError', 'PermissionDeniedError'].includes(error?.name)) return new Error(permissionHelp);
    if (invalidCapture) return new Error('macOS could not provide the screen stream. Restart Honest Father and try screen capture again.');
    return error;
}

async function startCapture(screenshotIntervalSeconds = 5, imageQuality = 'medium', screenOnly = false, testReview = false) {
    stopCapture();
    const generation = captureGeneration;
    screenOnly = screenOnly || testReview;
    captureScreenOnly = screenOnly;
    captureTestReview = testReview;
    currentImageQuality = imageQuality;
    try {
        await loadPreferencesCache();
        if (generation !== captureGeneration) return false;
        const audioMode = preferencesCache.audioMode || 'speaker_only';
        const captureSystem = !screenOnly && audioMode !== 'mic_only';
        const captureMic = !screenOnly && (audioMode === 'mic_only' || audioMode === 'both');

        let stream;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio:
                    captureSystem && !isMacOS
                        ? {
                              sampleRate: SAMPLE_RATE,
                              channelCount: 1,
                              echoCancellation: false,
                              noiseSuppression: false,
                              autoGainControl: false,
                          }
                        : false,
            });
        } catch (error) {
            if (isMacOS) {
                let diagnostics;
                try {
                    diagnostics = await ipcRenderer.invoke('screen-capture:diagnostics');
                } catch (diagnosticError) {
                    console.warn('Screen capture diagnostics were unavailable:', diagnosticError?.message || String(diagnosticError));
                }
                if (generation !== captureGeneration) return false;
                throw explainMacScreenCaptureFailure(error, diagnostics);
            }
            throw error;
        }
        if (generation !== captureGeneration) {
            stream.getTracks().forEach(track => track.stop());
            return false;
        }
        mediaStream = stream;
        mediaStream.getVideoTracks().forEach(track =>
            track.addEventListener('ended', () => {
                if (generation === captureGeneration) {
                    stopCapture();
                    ipcRenderer.invoke('close-session', { silent: true }).catch(console.error);
                    cheatingDaddyApp.handleSessionEnded('Screen capture stopped. Start a new session to continue.');
                }
            })
        );

        // Native capture chooses the full display dimensions. Rate tuning is optional
        // and happens afterward so unsupported constraints cannot block screen sharing.
        const desiredFrameRate = testReview ? 5 : 1;
        for (const track of stream.getVideoTracks()) {
            if (generation !== captureGeneration) {
                stream.getTracks().forEach(item => item.stop());
                return false;
            }
            if (typeof track.applyConstraints !== 'function') {
                console.warn('The shared screen does not support frame-rate constraints; using its native rate.');
                continue;
            }
            try {
                await track.applyConstraints({ frameRate: { ideal: desiredFrameRate, max: desiredFrameRate } });
            } catch (error) {
                if (generation === captureGeneration) {
                    console.warn(
                        'The shared screen could not apply the preferred frame rate; using its native rate:',
                        error?.message || String(error)
                    );
                }
            }
            if (generation !== captureGeneration) {
                stream.getTracks().forEach(track => track.stop());
                return false;
            }
        }
        if (generation !== captureGeneration) {
            stream.getTracks().forEach(track => track.stop());
            return false;
        }

        if (captureSystem && isMacOS) {
            const result = await ipcRenderer.invoke('start-macos-audio');
            if (result.skipped) {
                if (result.code === 'busy') cheatingDaddy.setStatus('A previous request is finishing. Try the shortcut again shortly.');
                return false;
            }
            if (!result.success) throw new Error(`System audio could not start: ${result.error}`);
        } else if (captureSystem) {
            if (mediaStream.getAudioTracks().length === 0) {
                throw new Error('No system audio was shared. Enable audio sharing or select Microphone only in settings.');
            }
            setupSystemAudioProcessing();
        }
        if (generation !== captureGeneration) return false;

        if (captureMic) {
            const micStream = await navigator.mediaDevices.getUserMedia({
                audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false,
            });
            if (generation !== captureGeneration) {
                micStream.getTracks().forEach(track => track.stop());
                return false;
            }
            microphoneStream = micStream;
            setupMicrophoneProcessing(micStream);
        }
        if (testReview) {
            const result = await ipcRenderer.invoke('review:begin');
            if (generation !== captureGeneration) return false;
            if (result?.success === false) throw new Error(result.error || 'Test Review could not start. Try again.');
        }
        // Screenshots remain manual to avoid repeated image requests.
        return true;
    } catch (error) {
        if (generation !== captureGeneration) return false;
        stopCapture();
        cheatingDaddy.setStatus(`Error: Capture could not start: ${error.message}`);
        return false;
    }
}

function createAudioProcessor(context, stream, channel) {
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1);
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;
    let samples = [];
    let sending = false;
    const generation = captureGeneration;
    processor.onaudioprocess = async event => {
        if (generation !== captureGeneration) return;
        samples.push(...event.inputBuffer.getChannelData(0));
        // Keep at most one second; a slow provider must not build an unbounded queue.
        if (samples.length > SAMPLE_RATE) samples = samples.slice(-SAMPLE_RATE);
        if (sending) return;
        sending = true;
        try {
            while (samples.length >= samplesPerChunk && generation === captureGeneration) {
                const pcm = convertFloat32ToInt16(samples.splice(0, samplesPerChunk));
                await ipcRenderer.invoke(channel, { data: arrayBufferToBase64(pcm.buffer), mimeType: 'audio/pcm;rate=24000' });
            }
        } catch (error) {
            console.warn('Audio transport failed:', error.message);
        } finally {
            sending = false;
        }
    };
    source.connect(processor);
    processor.connect(context.destination);
    return processor;
}

function setupMicrophoneProcessing(stream) {
    micAudioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    micAudioProcessor = createAudioProcessor(micAudioContext, stream, 'send-mic-audio-content');
}

function setupSystemAudioProcessing() {
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    audioProcessor = createAudioProcessor(audioContext, mediaStream, 'send-audio-content');
}

const MANUAL_SCREENSHOT_PROMPT = `Read the practice question on this screenshot and give the answer first, followed by a brief explanation.
For coding exercises, provide complete code, then briefly explain the approach and complexity. For multiple-choice questions, start with the correct option.
Focus on the question visible on screen. If essential text is unreadable or missing, say exactly what is needed instead of guessing.`;

function waitForVideoFrame(video, request, fresh = false) {
    return new Promise((resolve, reject) => {
        let frameCallback = null;
        let settled = false;
        let lastFrameTime = video.currentTime;
        let advancingFrames = 0;
        const hasFrameClock = typeof performance !== 'undefined' && typeof performance.now === 'function';
        const frameClock = () => (hasFrameClock ? performance.now() : Date.now());
        const startedAt = frameClock();
        const cleanup = () => {
            settled = true;
            clearTimeout(timeout);
            if (frameCallback !== null) video.cancelVideoFrameCallback?.(frameCallback);
            video.removeEventListener('loadeddata', ready);
            video.removeEventListener('loadeddata', timeAdvanced);
            video.removeEventListener('timeupdate', timeAdvanced);
            video.removeEventListener('error', failed);
            if (request.cancelFrameWait === cancel) request.cancelFrameWait = null;
        };
        const ready = () => {
            cleanup();
            resolve(true);
        };
        const advanced = (now = frameClock(), metadata = null) => {
            if (settled || video.readyState < 2) return false;
            if (!fresh) {
                ready();
                return true;
            }
            const frameTime = metadata?.mediaTime ?? video.currentTime;
            if (!Number.isFinite(frameTime) || frameTime <= lastFrameTime) return false;
            lastFrameTime = frameTime;
            if (hasFrameClock && Number.isFinite(metadata?.captureTime) && metadata.captureTime <= startedAt) return false;
            advancingFrames += 1;
            if (advancingFrames < 2 || now - startedAt < 150) return false;
            ready();
            return true;
        };
        const timeAdvanced = () => advanced();
        const framePresented = (now, metadata) => {
            if (settled) return;
            frameCallback = null;
            if (!advanced(Number.isFinite(now) ? now : frameClock(), metadata) && !settled) {
                frameCallback = video.requestVideoFrameCallback(framePresented);
            }
        };
        const failed = () => {
            cleanup();
            reject(new Error('The shared screen has no fresh readable video frame. Share it again.'));
        };
        const cancel = () => {
            cleanup();
            resolve(false);
        };
        const timeout = setTimeout(failed, 5000);
        request.cancelFrameWait = cancel;
        video.addEventListener('error', failed, { once: true });
        if (fresh && typeof video.requestVideoFrameCallback === 'function') {
            frameCallback = video.requestVideoFrameCallback(framePresented);
        } else {
            if (video.readyState < 2) video.addEventListener('loadeddata', fresh ? timeAdvanced : ready, { once: true });
            video.addEventListener('timeupdate', timeAdvanced);
            if (!fresh && video.readyState >= 2) ready();
        }
    });
}

function stopReviewWatchdog() {
    if (reviewWatchdog) clearInterval(reviewWatchdog);
    reviewWatchdog = null;
    reviewFrameGuard = null;
}

function setReviewStatus(text, generation) {
    if (generation !== captureGeneration || !captureTestReview) return;
    cheatingDaddy.setStatus(text);
    ipcRenderer.invoke('review:status', text).catch(console.error);
}

function cacheReviewQuestion(guard, replacedEntry) {
    const entry = {
        tracker: guard.tracker,
        token: guard.token,
        sourceWidth: guard.sourceWidth,
        sourceHeight: guard.sourceHeight,
        bytes: guard.tracker.retainedBytes ?? guard.snapshotBytes,
    };
    reviewQuestionCache = reviewQuestionCache.filter(cached => cached !== replacedEntry);
    if (entry.bytes > REVIEW_CACHE_BYTES) return;
    reviewQuestionCache.push(entry);
    while (reviewQuestionCache.length > 3 || reviewQuestionCache.reduce((total, cached) => total + cached.bytes, 0) > REVIEW_CACHE_BYTES) {
        reviewQuestionCache.shift();
    }
}

function readReviewFrame(guard) {
    if (guard.video.videoWidth !== guard.sourceWidth || guard.video.videoHeight !== guard.sourceHeight || guard.video.readyState < 2) {
        return null;
    }
    guard.context.drawImage(guard.video, 0, 0, guard.frameWidth, guard.frameHeight);
    return guard.context.getImageData(0, 0, guard.frameWidth, guard.frameHeight);
}

function startReviewWatchdog(guard) {
    stopReviewWatchdog();
    reviewFrameGuard = guard;
    reviewWatchdog = setInterval(() => {
        if (reviewFrameGuard !== guard || guard.generation !== captureGeneration || guard.stream !== mediaStream) return;
        let location;
        try {
            const frame = readReviewFrame(guard);
            location = frame ? guard.tracker.locate(frame) : { state: 'hidden' };
        } catch (error) {
            console.warn('Test Review screen check failed:', error.message);
            location = { state: 'hidden' };
        }
        if (location.state === 'matched') {
            if (guard.hidden || guard.offset?.x !== location.offset.x || guard.offset?.y !== location.offset.y) {
                guard.hidden = false;
                guard.offset = location.offset;
                ipcRenderer.invoke('review:move-answer', guard.token, location.offset).catch(console.error);
                cheatingDaddy.setStatus('Test Review ready');
            }
        } else if (!guard.hidden) {
            guard.hidden = true;
            ipcRenderer.invoke('review:hide-answer', guard.token).catch(console.error);
            cheatingDaddy.setStatus('Question is off screen or no longer matches. Scroll back or capture a new question.');
        }
    }, 500);
}

async function captureScreenshot(imageQuality = 'medium', isManual = false, prompt = null) {
    const generation = captureGeneration;
    const stream = mediaStream;
    if (!stream) {
        cheatingDaddy.setStatus('Error: Screen capture is not active. Share a screen and try again.');
        return false;
    }
    if (screenshotRequest?.generation === generation) {
        const status = 'A screenshot is already being processed. Wait for the response.';
        cheatingDaddy.setStatus(status);
        if (screenshotRequest.reviewSnapshotReady) setReviewStatus(status, generation);
        return false;
    }
    const request = { generation };
    screenshotRequest = request;
    const testReview = captureTestReview;
    let reviewCapture = null;
    if (testReview) stopReviewWatchdog();
    const isCurrent = () => generation === captureGeneration && stream === mediaStream;
    try {
        cheatingDaddy.setStatus('Reading screen...');
        // Keep local references across async work: ending a session clears the shared references.
        let video = hiddenVideo;
        if (!video) {
            video = document.createElement('video');
            video.srcObject = stream;
            video.muted = true;
            video.playsInline = true;
            hiddenVideo = video;
            await video.play();
        }
        if (!isCurrent()) return false;
        if (video.readyState < 2 && !(await waitForVideoFrame(video, request))) return false;
        if (!isCurrent()) return false;
        if (testReview) {
            reviewCapture = await ipcRenderer.invoke('review:prepare-capture');
            if (!isCurrent()) return false;
            if (reviewCapture?.success === false) throw new Error(reviewCapture.error || 'Test Review is not ready. Start it again.');
            if (!reviewCapture?.captureId || !reviewCapture.requestId || !reviewCapture.display) {
                throw new Error('Test Review could not identify the shared display. Start it again.');
            }
            if (!(await waitForVideoFrame(video, request, true)) || !isCurrent()) return false;
        }
        if (!video.videoWidth || !video.videoHeight) throw new Error('The shared screen is empty. Share it again.');

        // Keep small text legible; lower quality remains available for slow connections.
        const maxWidths = { high: 2560, medium: 1920, low: 1280 };
        const maxWidth = maxWidths[imageQuality] ?? maxWidths.medium;
        const width = Math.min(video.videoWidth, maxWidth);
        const height = Math.round((video.videoHeight * width) / video.videoWidth);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', testReview ? { willReadFrequently: true } : undefined);
        if (!context) throw new Error('Unable to read the shared screen. Share it again.');
        offscreenCanvas = canvas;
        offscreenContext = context;
        context.drawImage(video, 0, 0, width, height);
        const reviewSnapshot = testReview ? context.getImageData(0, 0, width, height) : null;
        if (testReview) request.reviewSnapshotReady = true;
        const sourceWidth = video.videoWidth;
        const sourceHeight = video.videoHeight;
        let result = null;
        let matchedCacheEntry = null;
        if (testReview) {
            for (const entry of [...reviewQuestionCache].reverse()) {
                if (entry.sourceWidth !== sourceWidth || entry.sourceHeight !== sourceHeight) continue;
                const location = entry.tracker.locate(reviewSnapshot);
                if (location.state !== 'matched') continue;
                matchedCacheEntry = entry;
                const cached = await ipcRenderer.invoke('review:reuse-answer', reviewCapture, entry.token, location.offset);
                if (!isCurrent()) return false;
                if (cached?.success && cached.reviewAnswer) result = cached;
                break;
            }
        }
        if (!result) {
            const qualityValues = { high: 0.95, medium: 0.88, low: 0.7 };
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', qualityValues[imageQuality] ?? qualityValues.medium));
            if (!isCurrent()) return false;
            if (!blob) throw new Error('Unable to encode the screenshot. Try again.');

            const base64data = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result.split(',')[1] : '');
                reader.onerror = () => reject(new Error('Unable to read the screenshot. Try again.'));
                reader.onabort = () => reject(new Error('Screenshot reading was interrupted. Try again.'));
                reader.readAsDataURL(blob);
            });
            if (!isCurrent()) return false;
            if (!base64data || base64data.length < 100) throw new Error('The screenshot contains no usable image. Share your screen again.');

            const payload = { data: base64data };
            if (testReview) {
                payload.reviewCapture = reviewCapture;
                payload.imageWidth = width;
                payload.imageHeight = height;
            } else if (isManual) {
                payload.prompt = prompt || MANUAL_SCREENSHOT_PROMPT;
                // A requested answer should appear immediately even while browsing older responses.
                const app = cheatingDaddy.element();
                app.currentResponseIndex = app.responses.length - 1;
                app.requestUpdate?.();
            }
            cheatingDaddy.setStatus('Waiting for AI response...');
            result = await ipcRenderer.invoke('send-image-content', payload);
        }
        if (!isCurrent()) return false;
        if (result.skipped) {
            const status =
                result.code === 'busy'
                    ? 'A previous request is finishing. Try the shortcut again shortly.'
                    : 'Screenshot request was canceled. Try the shortcut again.';
            if (testReview) setReviewStatus(status, generation);
            else cheatingDaddy.setStatus(status);
            return false;
        }
        if (!result.success) throw new Error(result.error || 'The AI provider could not answer. Try again.');
        if (testReview) {
            if (!result.reviewAnswer) throw new Error('Test Review returned no usable answer markers. Try again.');
            await ipcRenderer.invoke('review:status', '');
            if (!isCurrent()) return false;
            if (!(await waitForVideoFrame(video, request, true)) || !isCurrent()) return false;
            const guard = {
                generation,
                stream,
                video,
                context,
                frameWidth: width,
                frameHeight: height,
                snapshotBytes: reviewSnapshot.data.byteLength,
                answer: result.reviewAnswer,
                token: reviewCapture,
                sourceWidth,
                sourceHeight,
                tracker: createReviewFrameTracker(reviewSnapshot, result.reviewAnswer),
            };
            const currentFrame = readReviewFrame(guard);
            const location = currentFrame ? guard.tracker.locate(currentFrame) : { state: 'hidden' };
            guard.hidden = location.state !== 'matched';
            guard.offset = location.offset;
            const shown = guard.hidden
                ? await ipcRenderer.invoke('review:hide-answer', reviewCapture)
                : await ipcRenderer.invoke('review:show-answer', reviewCapture, location.offset);
            if (!isCurrent()) return false;
            if (shown?.success === false) throw new Error(shown.error || 'Answer markers could not be shown. Capture the screen again.');
            cacheReviewQuestion(guard, matchedCacheEntry);
            startReviewWatchdog(guard);
        }
        cheatingDaddy.setStatus(
            testReview
                ? reviewFrameGuard?.hidden
                    ? 'Question is off screen or no longer matches. Scroll back or capture a new question.'
                    : 'Test Review ready'
                : captureScreenOnly
                  ? 'Screen ready'
                  : 'Listening...'
        );
        console.log(`Screenshot response completed (${width}x${height})`);
        return true;
    } catch (error) {
        if (isCurrent()) {
            console.error('Screenshot failed:', error);
            if (testReview && reviewCapture) ipcRenderer.invoke('review:clear', reviewCapture).catch(console.error);
            const status = `Error: Screenshot could not be processed: ${error.message}`;
            if (testReview) setReviewStatus(status, generation);
            else cheatingDaddy.setStatus(status);
            if (isManual && !testReview) cheatingDaddy.addNewResponse(`Error: ${error.message}`);
        }
        return false;
    } finally {
        // A canceled request must not release a newer session's request gate.
        if (screenshotRequest === request) screenshotRequest = null;
    }
}

async function captureManualScreenshot(imageQuality = null) {
    return captureScreenshot(imageQuality || currentImageQuality, true);
}

// Expose functions to global scope for external access
window.captureManualScreenshot = captureManualScreenshot;

function stopCapture() {
    captureGeneration += 1;
    screenshotRequest?.cancelFrameWait?.();
    stopReviewWatchdog();
    reviewQuestionCache = [];
    if (captureTestReview) ipcRenderer.invoke('review:end').catch(console.error);
    captureTestReview = false;
    captureScreenOnly = false;
    if (screenshotInterval) {
        clearInterval(screenshotInterval);
        screenshotInterval = null;
    }

    if (audioProcessor) {
        audioProcessor.onaudioprocess = null;
        audioProcessor.disconnect();
        audioProcessor = null;
    }

    // Clean up microphone audio processor (Linux only)
    if (micAudioProcessor) {
        micAudioProcessor.onaudioprocess = null;
        micAudioProcessor.disconnect();
        micAudioProcessor = null;
    }

    if (audioContext) {
        audioContext.close().catch(console.error);
        audioContext = null;
    }

    if (micAudioContext) {
        micAudioContext.close().catch(console.error);
        micAudioContext = null;
    }
    if (microphoneStream) {
        microphoneStream.getTracks().forEach(track => track.stop());
        microphoneStream = null;
    }

    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    // Stop macOS audio capture if running
    if (isMacOS) {
        ipcRenderer.invoke('stop-macos-audio').catch(err => {
            console.error('Error stopping macOS audio:', err);
        });
    }

    // Clean up hidden elements
    if (hiddenVideo) {
        hiddenVideo.pause();
        hiddenVideo.srcObject = null;
        hiddenVideo = null;
    }
    offscreenCanvas = null;
    offscreenContext = null;
}

ipcRenderer.on('provider-session-ended', (event, data) => {
    if (captureScreenOnly && !(captureTestReview && data?.code === 'test_review')) return;
    stopCapture();
    cheatingDaddyApp.handleSessionEnded(data?.reason || 'Session ended. Start a new session to continue.');
});
window.addEventListener('beforeunload', stopCapture);

// Send text message to Gemini
async function sendTextMessage(text) {
    if (!text || text.trim().length === 0) {
        console.warn('Cannot send empty text message');
        return { success: false, error: 'Empty message' };
    }

    if (captureScreenOnly) {
        const success = await captureScreenshot(currentImageQuality, true, text.trim());
        return { success, completed: success, error: success ? undefined : 'Screen request failed. Check the session status and try again.' };
    }
    try {
        const result = await ipcRenderer.invoke('send-text-message', text);
        if (result.success) {
            console.log('Text message sent successfully');
        } else {
            console.error('Failed to send text message:', result.error);
        }
        return result;
    } catch (error) {
        console.error('Error sending text message:', error);
        return { success: false, error: error.message };
    }
}

// Listen for conversation data from main process and save to storage
ipcRenderer.on('save-conversation-turn', async (event, data) => {
    try {
        await storage.saveSession(data.sessionId, { conversationHistory: data.fullHistory });
        console.log('Conversation session saved:', data.sessionId);
    } catch (error) {
        console.error('Error saving conversation session:', error);
    }
});

// Listen for session context (profile info) when session starts
ipcRenderer.on('save-session-context', async (event, data) => {
    try {
        await storage.saveSession(data.sessionId, {
            profile: data.profile,
            customPrompt: data.customPrompt,
        });
        console.log('Session context saved:', data.sessionId, 'profile:', data.profile);
    } catch (error) {
        console.error('Error saving session context:', error);
    }
});

// Listen for screen analysis responses (from ctrl+enter)
ipcRenderer.on('save-screen-analysis', async (event, data) => {
    try {
        await storage.saveSession(data.sessionId, {
            screenAnalysisHistory: data.fullHistory,
            profile: data.profile,
            customPrompt: data.customPrompt,
        });
        console.log('Screen analysis saved:', data.sessionId);
    } catch (error) {
        console.error('Error saving screen analysis:', error);
    }
});

// Listen for emergency erase command from main process
ipcRenderer.on('clear-sensitive-data', async () => {
    console.log('Clearing all data...');
    await storage.clearAll();
});

// Handle shortcuts based on current view
function handleShortcut(shortcutKey) {
    const currentView = cheatingDaddy.getCurrentView();

    if (shortcutKey === 'ctrl+enter' || shortcutKey === 'cmd+enter') {
        if (currentView === 'main') {
            return cheatingDaddy.element().handleScreenStart();
        } else if (!mediaStream && currentView !== 'onboarding') {
            return cheatingDaddy.element().handleScreenStart();
        } else {
            return captureManualScreenshot();
        }
    }
}

// Create reference to the main app element
const cheatingDaddyApp = document.querySelector('cheating-daddy-app');

// ============ THEME SYSTEM ============
const theme = {
    themes: {
        dark: {
            background: '#101010',
            text: '#e0e0e0',
            textSecondary: '#a0a0a0',
            textMuted: '#6b6b6b',
            border: '#2a2a2a',
            accent: '#ffffff',
            btnPrimaryBg: '#ffffff',
            btnPrimaryText: '#000000',
            btnPrimaryHover: '#e0e0e0',
            tooltipBg: '#1a1a1a',
            tooltipText: '#ffffff',
            keyBg: 'rgba(255,255,255,0.1)',
        },
        light: {
            background: '#ffffff',
            text: '#1a1a1a',
            textSecondary: '#555555',
            textMuted: '#888888',
            border: '#e0e0e0',
            accent: '#000000',
            btnPrimaryBg: '#1a1a1a',
            btnPrimaryText: '#ffffff',
            btnPrimaryHover: '#333333',
            tooltipBg: '#1a1a1a',
            tooltipText: '#ffffff',
            keyBg: 'rgba(0,0,0,0.1)',
        },
        midnight: {
            background: '#0d1117',
            text: '#c9d1d9',
            textSecondary: '#8b949e',
            textMuted: '#6e7681',
            border: '#30363d',
            accent: '#58a6ff',
            btnPrimaryBg: '#58a6ff',
            btnPrimaryText: '#0d1117',
            btnPrimaryHover: '#79b8ff',
            tooltipBg: '#161b22',
            tooltipText: '#c9d1d9',
            keyBg: 'rgba(88,166,255,0.15)',
        },
        sepia: {
            background: '#f4ecd8',
            text: '#5c4b37',
            textSecondary: '#7a6a56',
            textMuted: '#998875',
            border: '#d4c8b0',
            accent: '#8b4513',
            btnPrimaryBg: '#5c4b37',
            btnPrimaryText: '#f4ecd8',
            btnPrimaryHover: '#7a6a56',
            tooltipBg: '#5c4b37',
            tooltipText: '#f4ecd8',
            keyBg: 'rgba(92,75,55,0.15)',
        },
        catppuccin: {
            background: '#1e1e2e',
            text: '#cdd6f4',
            textSecondary: '#a6adc8',
            textMuted: '#585b70',
            border: '#313244',
            accent: '#cba6f7',
            btnPrimaryBg: '#cba6f7',
            btnPrimaryText: '#1e1e2e',
            btnPrimaryHover: '#b4befe',
            tooltipBg: '#313244',
            tooltipText: '#cdd6f4',
            keyBg: 'rgba(203,166,247,0.12)',
        },
        gruvbox: {
            background: '#1d2021',
            text: '#ebdbb2',
            textSecondary: '#a89984',
            textMuted: '#665c54',
            border: '#3c3836',
            accent: '#fe8019',
            btnPrimaryBg: '#fe8019',
            btnPrimaryText: '#1d2021',
            btnPrimaryHover: '#fabd2f',
            tooltipBg: '#3c3836',
            tooltipText: '#ebdbb2',
            keyBg: 'rgba(254,128,25,0.12)',
        },
        rosepine: {
            background: '#191724',
            text: '#e0def4',
            textSecondary: '#908caa',
            textMuted: '#6e6a86',
            border: '#26233a',
            accent: '#ebbcba',
            btnPrimaryBg: '#ebbcba',
            btnPrimaryText: '#191724',
            btnPrimaryHover: '#f6c177',
            tooltipBg: '#26233a',
            tooltipText: '#e0def4',
            keyBg: 'rgba(235,188,186,0.12)',
        },
        solarized: {
            background: '#002b36',
            text: '#93a1a1',
            textSecondary: '#839496',
            textMuted: '#586e75',
            border: '#073642',
            accent: '#2aa198',
            btnPrimaryBg: '#2aa198',
            btnPrimaryText: '#002b36',
            btnPrimaryHover: '#268bd2',
            tooltipBg: '#073642',
            tooltipText: '#93a1a1',
            keyBg: 'rgba(42,161,152,0.12)',
        },
        tokyonight: {
            background: '#1a1b26',
            text: '#c0caf5',
            textSecondary: '#9aa5ce',
            textMuted: '#565f89',
            border: '#292e42',
            accent: '#7aa2f7',
            btnPrimaryBg: '#7aa2f7',
            btnPrimaryText: '#1a1b26',
            btnPrimaryHover: '#bb9af7',
            tooltipBg: '#292e42',
            tooltipText: '#c0caf5',
            keyBg: 'rgba(122,162,247,0.12)',
        },
    },

    current: 'dark',

    get(name) {
        return this.themes[name] || this.themes.dark;
    },

    getAll() {
        const names = {
            dark: 'Dark',
            light: 'Light',
            midnight: 'Midnight Blue',
            sepia: 'Sepia',
            catppuccin: 'Catppuccin Mocha',
            gruvbox: 'Gruvbox Dark',
            rosepine: 'Ros\u00e9 Pine',
            solarized: 'Solarized Dark',
            tokyonight: 'Tokyo Night',
        };
        return Object.keys(this.themes).map(key => ({
            value: key,
            name: names[key] || key,
            colors: this.themes[key],
        }));
    },

    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result
            ? {
                  r: parseInt(result[1], 16),
                  g: parseInt(result[2], 16),
                  b: parseInt(result[3], 16),
              }
            : { r: 30, g: 30, b: 30 };
    },

    lightenColor(rgb, amount) {
        return {
            r: Math.min(255, rgb.r + amount),
            g: Math.min(255, rgb.g + amount),
            b: Math.min(255, rgb.b + amount),
        };
    },

    darkenColor(rgb, amount) {
        return {
            r: Math.max(0, rgb.r - amount),
            g: Math.max(0, rgb.g - amount),
            b: Math.max(0, rgb.b - amount),
        };
    },

    applyBackgrounds(backgroundColor, alpha = 0.8) {
        const root = document.documentElement;
        const baseRgb = this.hexToRgb(backgroundColor);

        // For light themes, darken; for dark themes, lighten
        const isLight = (baseRgb.r + baseRgb.g + baseRgb.b) / 3 > 128;
        const adjust = isLight ? this.darkenColor.bind(this) : this.lightenColor.bind(this);

        const secondary = adjust(baseRgb, 10);
        const tertiary = adjust(baseRgb, 22);
        const hover = adjust(baseRgb, 28);

        const bgBase = `rgba(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}, ${alpha})`;
        const bgSurface = `rgba(${secondary.r}, ${secondary.g}, ${secondary.b}, ${alpha})`;
        const bgElevated = `rgba(${tertiary.r}, ${tertiary.g}, ${tertiary.b}, ${alpha})`;
        const bgHover = `rgba(${hover.r}, ${hover.g}, ${hover.b}, ${alpha})`;

        // New design tokens (used by components)
        root.style.setProperty('--bg-app', bgBase);
        root.style.setProperty('--bg-surface', bgSurface);
        root.style.setProperty('--bg-elevated', bgElevated);
        root.style.setProperty('--bg-hover', bgHover);

        // Legacy aliases
        root.style.setProperty('--header-background', bgBase);
        root.style.setProperty('--main-content-background', bgBase);
        root.style.setProperty('--bg-primary', bgBase);
        root.style.setProperty('--bg-secondary', bgSurface);
        root.style.setProperty('--bg-tertiary', bgElevated);
        root.style.setProperty('--input-background', bgElevated);
        root.style.setProperty('--input-focus-background', bgElevated);
        root.style.setProperty('--hover-background', bgHover);
        root.style.setProperty('--scrollbar-background', bgBase);
    },

    apply(themeName, alpha = 0.8) {
        const colors = this.get(themeName);
        this.current = themeName;
        const root = document.documentElement;

        // New design tokens (used by components)
        root.style.setProperty('--text-primary', colors.text);
        root.style.setProperty('--text-secondary', colors.textSecondary);
        root.style.setProperty('--text-muted', colors.textMuted);
        root.style.setProperty('--border', colors.border);
        root.style.setProperty('--border-strong', colors.accent);
        root.style.setProperty('--accent', colors.btnPrimaryBg);
        root.style.setProperty('--accent-hover', colors.btnPrimaryHover);

        // Legacy aliases
        root.style.setProperty('--text-color', colors.text);
        root.style.setProperty('--border-color', colors.border);
        root.style.setProperty('--border-default', colors.accent);
        root.style.setProperty('--placeholder-color', colors.textMuted);
        root.style.setProperty('--scrollbar-thumb', colors.border);
        root.style.setProperty('--scrollbar-thumb-hover', colors.textMuted);
        root.style.setProperty('--key-background', colors.keyBg);
        // Primary button
        root.style.setProperty('--btn-primary-bg', colors.btnPrimaryBg);
        root.style.setProperty('--btn-primary-text', colors.btnPrimaryText);
        root.style.setProperty('--btn-primary-hover', colors.btnPrimaryHover);
        // Start button (same as primary)
        root.style.setProperty('--start-button-background', colors.btnPrimaryBg);
        root.style.setProperty('--start-button-color', colors.btnPrimaryText);
        root.style.setProperty('--start-button-hover-background', colors.btnPrimaryHover);
        // Tooltip
        root.style.setProperty('--tooltip-bg', colors.tooltipBg);
        root.style.setProperty('--tooltip-text', colors.tooltipText);
        // Error color (stays constant)
        root.style.setProperty('--error-color', '#f14c4c');
        root.style.setProperty('--success-color', '#4caf50');

        // Also apply background colors from theme
        this.applyBackgrounds(colors.background, alpha);
    },

    async load() {
        try {
            const prefs = await storage.getPreferences();
            const themeName = prefs.theme || 'dark';
            const alpha = prefs.backgroundTransparency ?? 0.8;
            this.apply(themeName, alpha);
            return themeName;
        } catch (err) {
            this.apply('dark');
            return 'dark';
        }
    },

    async save(themeName) {
        await storage.updatePreference('theme', themeName);
        this.apply(themeName);
    },
};

async function initializeScreenSession(profile = 'interview', testReview = false) {
    const prefs = await storage.getPreferences();
    return ipcRenderer.invoke('initialize-screen-session', profile, prefs.customPrompt || '', testReview ? 'test-review' : 'text');
}

// Consolidated cheatingDaddy object - all functions in one place
const cheatingDaddy = {
    // App version
    getVersion: async () => ipcRenderer.invoke('get-app-version'),

    // Element access
    element: () => cheatingDaddyApp,
    e: () => cheatingDaddyApp,

    // App state functions - access properties directly from the app element
    getCurrentView: () => cheatingDaddyApp.currentView,
    getLayoutMode: () => cheatingDaddyApp.layoutMode,

    // Status and response functions
    setStatus: text => cheatingDaddyApp.setStatus(text),
    addNewResponse: response => cheatingDaddyApp.addNewResponse(response),
    updateCurrentResponse: response => cheatingDaddyApp.updateCurrentResponse(response),

    // Core functionality
    initializeGemini,
    initializeScreenSession,
    initializeCloud,
    initializeLocal,
    cancelLocalInitialization,
    startCapture,
    stopCapture,
    captureManualScreenshot,
    sendTextMessage,
    handleShortcut,

    // Storage API
    storage,

    // Theme API
    theme,

    // Refresh preferences cache (call after updating preferences)
    refreshPreferencesCache: loadPreferencesCache,

    // Platform detection
    isLinux: isLinux,
    isMacOS: isMacOS,
};

// Make it globally available
window.cheatingDaddy = cheatingDaddy;

// Load theme after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => theme.load());
} else {
    theme.load();
}
