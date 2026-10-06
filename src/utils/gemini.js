const { GoogleGenAI, Modality } = require('@google/genai');
const { ipcMain, net } = require('electron');
const { spawn } = require('child_process');
const chatgpt = require('./chatgpt');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt, getScreenshotSystemPrompt } = require('./prompts');
const { REVIEW_SYSTEM_PROMPT, REVIEW_USER_PROMPT, parseReviewAnswer } = require('./testReview');
const { createGeminiModelResolver } = require('./geminiModels');
const { getAvailableModel, incrementLimitCount, getApiKey, getGroqApiKey, incrementCharUsage, getConfig, getPreferences } = require('../storage');
const {
    connectCloud,
    sendCloudAudio,
    sendCloudText,
    sendCloudImage,
    closeCloud,
    isCloudActive,
    setOnTurnComplete,
    setRendererWindow,
} = require('./cloud');
const { startTransportLog, logTransportEvent, closeTransportLog } = require('./transportLogger');
const {
    classifyGoogleError,
    googleErrorDiagnostics,
    createReconnectController,
    createRequestGate,
    createPcmActivityFilter,
    buildSessionContext,
    createSseLineBuffer,
} = require('./geminiReliability');

// Match renderer networking, including Electron's system proxy settings.
const googleHttpFetch = (input, init) => net.fetch(input, init);

// Lazy-loaded to avoid circular dependency (localai.js imports from gemini.js)
let _localai = null;
function getLocalAi() {
    if (!_localai) _localai = require('./localai');
    return _localai;
}

// Provider mode: 'byok', 'cloud', or 'local'
let currentProviderMode = 'byok';
let currentScreenMode = 'text';
let currentResponseProvider = 'gemini';
let chatgptOptions = null;
let chatgptController = null;
let pendingChatGPTTranscription = '';
let chatgptAutomaticPaused = false;
let chatgptPausedError = null;
let chatgptConversationHistory = [];
let rendererWindow = null;
let reviewOverlay = null;

function setMainWindow(window, overlay = null) {
    rendererWindow = window;
    reviewOverlay = overlay;
    setRendererWindow(window);
}

// Groq conversation history for context
let groqConversationHistory = [];

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = null;
let currentCustomPrompt = null;
let isInitializingSession = false;
let currentSystemPrompt = null;

function formatSpeakerResults(results) {
    let text = '';
    for (const result of results) {
        if (result.transcript && result.speakerId) {
            const speakerLabel = result.speakerId === 1 ? 'Interviewer' : 'Candidate';
            text += `[${speakerLabel}]: ${result.transcript}\n`;
        }
    }
    return text;
}

module.exports.formatSpeakerResults = formatSpeakerResults;

// Audio capture variables
let systemAudioProc = null;
let cancelAudioStartup = null;
let audioCaptureGeneration = 0;
let messageBuffer = '';
let groqRequestStartedForTurn = false;

const GROQ_MAX_COMPLETION_TOKENS = 16384;
const GROQ_EMPTY_RESPONSE_MESSAGE =
    'Groq reached the maximum completion-token limit before returning a final answer. Disable thinking in Home → AI responses and try again.';

// Reconnection variables
let isUserClosing = false;
let sessionParams = null;
let activeGeminiSession = null;
let pendingGeminiSession = null;
let sessionGeneration = 0;
let connectionSerial = 0;
let currentConnectionSerial = 0;
let pendingInitializationCancel = null;
let resumptionHandle = null;
let lastGeminiError = null;
let hadActiveSession = false;
let audioStreamOpen = false;
const audioInFlight = new Set();
const audioFilters = { system: createPcmActivityFilter(), mic: createPcmActivityFilter() };
const imageRequestGate = createRequestGate();
const modelResolver = createGeminiModelResolver();
let activeImageController = null;

const reconnectController = createReconnectController({
    reconnect: attemptReconnect,
    onRetry: (attempt, delay) => sendToRenderer('update-status', `Gemini reconnecting in ${Math.ceil(delay / 1000)}s (${attempt}/3)...`),
    onStopped: failure => {
        const notify = hadActiveSession;
        closeActiveSession();
        sendToRenderer('update-status', failure.message);
        if (notify) {
            sendToRenderer('provider-session-ended', { reason: failure.message, code: failure.code });
        }
    },
});

function sendToRenderer(channel, data) {
    if (rendererWindow && !rendererWindow.isDestroyed() && !rendererWindow.webContents.isDestroyed()) {
        rendererWindow.webContents.send(channel, data);
        if (channel === 'update-status' && reviewOverlay?.isActive()) reviewOverlay.status(data);
    }
}

// Build context message for session restoration
function buildContextMessage() {
    return buildSessionContext(conversationHistory);
}

// Conversation management functions
function initializeNewSession(profile = null, customPrompt = null) {
    currentSessionId = Date.now().toString();
    startTransportLog(currentSessionId);
    currentTranscription = '';
    groqRequestStartedForTurn = false;
    conversationHistory = [];
    screenAnalysisHistory = [];
    groqConversationHistory = [];
    currentProfile = profile;
    currentCustomPrompt = customPrompt;
    console.log('New conversation session started:', currentSessionId, 'profile:', profile);

    // Save initial session with profile context
    if (profile) {
        sendToRenderer('save-session-context', {
            sessionId: currentSessionId,
            profile: profile,
            customPrompt: customPrompt || '',
        });
    }
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved conversation turn:', conversationTurn);

    // Send to renderer to save in IndexedDB
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function saveScreenAnalysis(prompt, response, model) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: response.trim(),
        model: model,
    };

    screenAnalysisHistory.push(analysisEntry);
    console.log('Saved screen analysis:', analysisEntry);

    // Send to renderer to save
    sendToRenderer('save-screen-analysis', {
        sessionId: currentSessionId,
        analysis: analysisEntry,
        fullHistory: screenAnalysisHistory,
        profile: currentProfile,
        customPrompt: currentCustomPrompt,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

async function getEnabledTools() {
    const tools = [];

    // Read the same persisted preference as Home; avoid enabling a paid tool by default.
    const googleSearchEnabled = getPreferences().googleSearchEnabled;
    console.log('Google Search enabled:', googleSearchEnabled);

    if (googleSearchEnabled === true || googleSearchEnabled === 'true') {
        tools.push({ googleSearch: {} });
        console.log('Added Google Search tool');
    } else {
        console.log('Google Search tool disabled');
    }

    return tools;
}

async function getStoredSetting(key, defaultValue) {
    try {
        const window = rendererWindow;
        if (window && !window.isDestroyed()) {
            // Wait a bit for the renderer to be ready
            await new Promise(resolve => setTimeout(resolve, 100));

            // Try to get setting from renderer process localStorage
            const value = await window.webContents.executeJavaScript(`
                (function() {
                    try {
                        if (typeof localStorage === 'undefined') {
                            console.log('localStorage not available yet for ${key}');
                            return '${defaultValue}';
                        }
                        const stored = localStorage.getItem('${key}');
                        console.log('Retrieved setting ${key}:', stored);
                        return stored || '${defaultValue}';
                    } catch (e) {
                        console.error('Error accessing localStorage for ${key}:', e);
                        return '${defaultValue}';
                    }
                })()
            `);
            return value;
        }
    } catch (error) {
        console.error('Error getting stored setting for', key, ':', error.message);
    }
    console.log('Using default value for', key, ':', defaultValue);
    return defaultValue;
}

// helper to check if groq has been configured
function hasGroqKey() {
    const key = getGroqApiKey();
    return key && key.trim() != '';
}

function isChatGPTSession() {
    return currentProviderMode === 'byok' && currentScreenMode !== 'test-review' && currentResponseProvider === 'chatgpt';
}

function sendFinalTranscriptionToChatGPT() {
    if (!isChatGPTSession() || chatgptAutomaticPaused || groqRequestStartedForTurn || !currentTranscription.trim()) return;
    groqRequestStartedForTurn = true;
    if (chatgptController) {
        pendingChatGPTTranscription = [pendingChatGPTTranscription, currentTranscription.trim()].filter(Boolean).join('\n').slice(-32000);
        return;
    }
    void sendToChatGPT(currentTranscription.trim());
}

async function sendToChatGPT(prompt, imageBase64) {
    if (!isChatGPTSession() || !chatgptOptions) return { success: false, error: 'Start a ChatGPT session first.' };
    if (chatgptPausedError) return { ...chatgptPausedError };
    if (chatgptController) return { success: false, code: 'busy', error: 'ChatGPT is still answering. Wait for the current response.' };
    const controller = new AbortController();
    chatgptController = controller;
    const generation = sessionGeneration;
    const isCurrent = () => generation === sessionGeneration && !controller.signal.aborted;
    let first = true;
    try {
        const history = chatgptConversationHistory.slice(-8);
        const text = await chatgpt.respond({
            ...chatgptOptions,
            prompt,
            imageBase64,
            mimeType: 'image/jpeg',
            history,
            instructions: imageBase64
                ? getScreenshotSystemPrompt(currentProfile || 'interview', currentCustomPrompt || '')
                : currentSystemPrompt || 'Answer clearly and concisely.',
            signal: controller.signal,
            onText(text) {
                if (!isCurrent()) return;
                sendToRenderer(first ? 'new-response' : 'update-response', text);
                first = false;
            },
        });
        if (!isCurrent()) return { success: true, skipped: true, code: 'cancelled' };
        if (imageBase64) saveScreenAnalysis(prompt, text, chatgptOptions.model);
        else saveConversationTurn(prompt, text);
        chatgptConversationHistory.push({ role: 'user', content: prompt.slice(-6000) }, { role: 'assistant', content: text.slice(-6000) });
        chatgptConversationHistory = chatgptConversationHistory.slice(-8);
        chatgptAutomaticPaused = false;
        sendToRenderer('update-status', 'Ready');
        return { success: true, completed: true, text, model: chatgptOptions.model };
    } catch (error) {
        if (!isCurrent()) return { success: true, skipped: true, code: 'cancelled' };
        const message = error.message || 'ChatGPT request failed. Try again.';
        chatgptAutomaticPaused = true;
        pendingChatGPTTranscription = '';
        const result = { success: false, error: message, code: error.code };
        if (
            [401, 403, 429].includes(error.status) ||
            [
                'subscription_sharing_usage_limit_exceeded',
                'subscription_sharing_user_not_eligible',
                'subscription_sharing_unsupported_capability',
                'model_unavailable',
                'unsupported_pro',
                'sign_in_required',
                'plan_permission_required',
            ].includes(error.code)
        )
            chatgptPausedError = result;
        sendToRenderer('update-status', message);
        return result;
    } finally {
        if (chatgptController === controller) chatgptController = null;
        if (isCurrent() && !chatgptAutomaticPaused && pendingChatGPTTranscription) {
            const pending = pendingChatGPTTranscription;
            pendingChatGPTTranscription = '';
            void sendToChatGPT(pending);
        }
    }
}

function trimConversationHistoryForGemma(history, maxChars = 42000) {
    if (!history || history.length === 0) return [];
    let totalChars = 0;
    const trimmed = [];

    for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i];
        const turnChars = (turn.content || '').length;

        if (totalChars + turnChars > maxChars) break;
        totalChars += turnChars;
        trimmed.unshift(turn);
    }
    return trimmed;
}

function stripThinkingTags(text) {
    const trimmedStart = text.trimStart();
    if ('<think>'.startsWith(trimmedStart)) {
        return '';
    }

    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
}

function getGroqReasoningOptions(model, disableThinking) {
    if (model.includes('qwen3')) {
        const options = {
            reasoning_format: 'hidden',
        };

        if (disableThinking) {
            options.reasoning_effort = 'none';
        }

        return options;
    }

    if (model.startsWith('openai/gpt-oss-')) {
        return {
            include_reasoning: false,
        };
    }

    return {};
}

async function sendToGroq(transcription) {
    const generation = sessionGeneration;
    const sessionId = currentSessionId;
    const isCurrent = () => generation === sessionGeneration && sessionId === currentSessionId;
    const groqApiKey = getGroqApiKey();
    if (!groqApiKey) {
        console.log('No Groq API key configured, skipping Groq response');
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Groq');
        return;
    }

    const config = getConfig();
    const modelToUse = config.groqModel;

    console.log(`Sending to Groq (${modelToUse}):`, transcription.substring(0, 100) + '...');
    logTransportEvent('groq.text.request', {
        model: modelToUse,
        transcription,
    });

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (groqConversationHistory.length > 20) {
        groqConversationHistory = groqConversationHistory.slice(-20);
    }

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: modelToUse,
                messages: [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...groqConversationHistory],
                stream: true,
                temperature: 0.7,
                max_completion_tokens: GROQ_MAX_COMPLETION_TOKENS,
                ...getGroqReasoningOptions(modelToUse, config.disableGroqThinking),
            }),
        });
        if (!isCurrent()) return;

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Groq API error:', response.status, errorText);
            logTransportEvent('groq.text.http_error', {
                status: response.status,
                body: errorText,
            });
            sendToRenderer('update-status', `Groq error: ${response.status}`);
            return;
        }

        logTransportEvent('groq.text.http_response', {
            status: response.status,
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parseLines = createSseLineBuffer();
        let fullText = '';
        let isFirst = true;
        let finishReason = null;

        while (true) {
            const { done, value } = await reader.read();
            if (!isCurrent()) return;

            const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
            logTransportEvent('groq.text.stream_chunk', { chunk });
            const lines = parseLines(chunk, done);

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const json = JSON.parse(data);
                        logTransportEvent('groq.text.stream_event', json);
                        finishReason = json.choices?.[0]?.finish_reason || finishReason;
                        const token = json.choices?.[0]?.delta?.content || '';
                        if (token) {
                            fullText += token;
                            const displayText = stripThinkingTags(fullText);
                            if (displayText) {
                                sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                                isFirst = false;
                            }
                        }
                    } catch (parseError) {
                        logTransportEvent('groq.text.stream_parse_error', {
                            data,
                            error: parseError.message,
                        });
                    }
                }
            }
            if (done) break;
        }

        const cleanedResponse = stripThinkingTags(fullText);
        const modelKey = modelToUse.split('/').pop();

        const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
        const historyChars = groqConversationHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
        const inputChars = systemPromptChars + historyChars;
        const outputChars = cleanedResponse.length;

        incrementCharUsage('groq', modelKey, inputChars + outputChars);

        if (cleanedResponse) {
            groqConversationHistory.push({
                role: 'assistant',
                content: cleanedResponse,
            });

            saveConversationTurn(transcription, cleanedResponse);
        } else {
            console.warn(`Groq returned no final answer (${modelToUse})`);
            logTransportEvent('groq.text.empty_response', {
                model: modelToUse,
                fullText,
                finishReason,
            });
            sendToRenderer('new-response', GROQ_EMPTY_RESPONSE_MESSAGE);
            sendToRenderer('update-status', 'Groq reached the completion-token limit');
            return;
        }

        logTransportEvent('groq.text.completed', {
            model: modelToUse,
            response: cleanedResponse,
        });
        console.log(`Groq response completed (${modelToUse})`);
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        if (!isCurrent()) return;
        console.error('Error calling Groq API:', error);
        logTransportEvent('groq.text.error', {
            error: error.message,
            stack: error.stack,
        });
        sendToRenderer('update-status', 'Groq error: ' + error.message);
    }
}

async function sendImageToGroq(base64Data, prompt, { testReview = false } = {}) {
    const groqApiKey = getGroqApiKey();
    const config = getConfig();
    const model = config.groqImageModel;
    const gated = imageRequestGate.begin(JSON.stringify(['groq', model, groqApiKey]));
    if (gated)
        return gated.error ? { ...gated, error: gated.error.replaceAll('Gemini', 'Groq').replaceAll('Google AI Studio', 'Groq Console') } : gated;
    const generation = sessionGeneration;
    const sessionId = currentSessionId;
    const controller = new AbortController();
    activeImageController = controller;
    const isCurrent = () => generation === sessionGeneration && (sessionId === null || sessionId === currentSessionId) && !controller.signal.aborted;
    let failure = null;
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, 45000);

    logTransportEvent('groq.image.request', {
        model,
        prompt,
        imageBytes: Buffer.byteLength(base64Data, 'base64'),
    });

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                messages: [
                    {
                        role: 'system',
                        content: testReview
                            ? REVIEW_SYSTEM_PROMPT
                            : getScreenshotSystemPrompt(currentProfile || 'interview', currentCustomPrompt || ''),
                    },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64Data}`,
                                },
                            },
                        ],
                    },
                ],
                stream: true,
                temperature: testReview ? 0.1 : 0.7,
                max_completion_tokens: testReview ? 4096 : GROQ_MAX_COMPLETION_TOKENS,
                ...getGroqReasoningOptions(model, testReview || config.disableGroqThinking),
            }),
        });
        if (!isCurrent()) return { success: true, skipped: true, code: 'cancelled' };

        if (!response.ok) {
            const errorText = await response.text();
            throw { status: response.status, message: errorText };
        }

        logTransportEvent('groq.image.http_response', {
            status: response.status,
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parseLines = createSseLineBuffer();
        let fullText = '';
        let isFirst = true;
        let finishReason = null;

        while (true) {
            const { done, value } = await reader.read();
            if (!isCurrent()) return { success: true, skipped: true, code: 'cancelled' };

            const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
            logTransportEvent('groq.image.stream_chunk', { chunk });
            const lines = parseLines(chunk, done);

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;

                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const json = JSON.parse(data);
                    logTransportEvent('groq.image.stream_event', json);
                    finishReason = json.choices?.[0]?.finish_reason || finishReason;
                    const token = json.choices?.[0]?.delta?.content || '';
                    if (!token) continue;

                    fullText += token;
                    const displayText = stripThinkingTags(fullText);
                    if (displayText && !testReview) {
                        sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                        isFirst = false;
                    }
                } catch (parseError) {
                    logTransportEvent('groq.image.stream_parse_error', {
                        data,
                        error: parseError.message,
                    });
                }
            }
            if (done) break;
        }

        const cleanedResponse = stripThinkingTags(fullText);
        if (!isCurrent()) return { success: true, skipped: true, code: 'cancelled' };
        if (!cleanedResponse) {
            logTransportEvent('groq.image.empty_response', {
                model,
                fullText,
                finishReason,
            });
            return { success: false, error: GROQ_EMPTY_RESPONSE_MESSAGE };
        }

        if (!testReview) saveScreenAnalysis(prompt, cleanedResponse, model);
        logTransportEvent('groq.image.completed', {
            model,
            response: cleanedResponse,
        });
        return { success: true, text: cleanedResponse, model };
    } catch (error) {
        if (!isCurrent() && !timedOut) return { success: true, skipped: true, code: 'cancelled' };
        failure = timedOut ? new Error('Groq image request timed out') : error;
        const classified = classifyGoogleError(failure);
        const message = classified.message.replaceAll('Gemini', 'Groq').replaceAll('Google AI Studio', 'Groq Console');
        logTransportEvent('groq.image.error', { code: classified.code });
        sendToRenderer('update-status', message);
        return {
            success: false,
            error: message,
            code: classified.code,
            retryAfterMs: Number.isFinite(classified.cooldownMs) ? classified.cooldownMs : null,
        };
    } finally {
        clearTimeout(timeout);
        if (activeImageController === controller) activeImageController = null;
        imageRequestGate.finish(failure);
    }
}

async function sendToGemma(transcription) {
    const rawApiKey = getApiKey();
    const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : '';
    if (!apiKey) {
        console.log('No Gemini API key configured');
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Gemma');
        return;
    }

    console.log('Sending to Gemma:', transcription.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    const trimmedHistory = trimConversationHistoryForGemma(groqConversationHistory, 42000);

    try {
        const ai = new GoogleGenAI({
            apiKey: apiKey,
            httpOptions: { apiVersion: 'v1beta', timeout: 45000, retryOptions: { attempts: 1 }, fetch: googleHttpFetch },
        });
        const selectedModel = getAvailableModel();
        const model = await modelResolver.resolve({ apiKey, client: ai, selected: selectedModel, kind: 'text' });

        const messages = trimmedHistory.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
        }));

        const systemPrompt = currentSystemPrompt || 'You are a helpful assistant.';
        const messagesWithSystem = [
            { role: 'user', parts: [{ text: systemPrompt }] },
            { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
            ...messages,
        ];

        const response = await ai.models.generateContentStream({
            model,
            contents: messagesWithSystem,
        });

        let fullText = '';
        let isFirst = true;

        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
        const historyChars = trimmedHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
        const inputChars = systemPromptChars + historyChars;
        const outputChars = fullText.length;

        incrementCharUsage('gemini', model, inputChars + outputChars);

        if (fullText.trim()) {
            modelResolver.remember(apiKey, selectedModel, model, 'text');
            groqConversationHistory.push({
                role: 'assistant',
                content: fullText.trim(),
            });

            if (groqConversationHistory.length > 40) {
                groqConversationHistory = groqConversationHistory.slice(-40);
            }

            saveConversationTurn(transcription, fullText);
        }

        console.log('Gemma response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('Error calling Gemma API:', error);
        sendToRenderer('update-status', 'Gemma error: ' + error.message);
    }
}

async function initializeGeminiSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US', isReconnect = false) {
    if (isInitializingSession) {
        return null;
    }
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 512) {
        sendToRenderer('update-status', 'Enter a valid Gemini API key in Home before starting.');
        return null;
    }
    if (typeof customPrompt !== 'string' || customPrompt.length > 32000 || typeof profile !== 'string' || typeof language !== 'string') {
        sendToRenderer('update-status', 'Invalid Gemini session settings.');
        return null;
    }
    if (!isReconnect) {
        closeActiveSession();
        const preparingGeneration = sessionGeneration;
        currentResponseProvider = getConfig().normalResponseProvider === 'chatgpt' ? 'chatgpt' : 'gemini';
        if (isChatGPTSession()) {
            try {
                const prepared = await chatgpt.prepareChatGPT();
                if (preparingGeneration !== sessionGeneration) return null;
                chatgptOptions = prepared;
            } catch (error) {
                if (preparingGeneration === sessionGeneration) sendToRenderer('update-status', error.message);
                return null;
            }
        }
        isUserClosing = false;
        sessionParams = { apiKey: apiKey.trim(), customPrompt, profile, language };
        reconnectController.reset();
        sendToRenderer('session-initializing', true);
    }
    isInitializingSession = true;
    lastGeminiError = null;
    const generation = sessionGeneration;
    const serial = ++connectionSerial;
    currentConnectionSerial = serial;
    const isCurrent = () => generation === sessionGeneration && serial === currentConnectionSerial && !isUserClosing;
    const requestedHandle = isReconnect ? resumptionHandle : null;
    let candidate = null;
    let ready = false;
    let closed = false;
    let goAwayPending = false;
    let resolveReady;
    let rejectReady;
    let connectTimer;
    const modelDiscoveryController = new AbortController();
    const readyPromise = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    // A server error can arrive before the SDK resolves its connect promise.
    readyPromise.catch(() => {});
    const timeoutPromise = new Promise((resolve, reject) => {
        pendingInitializationCancel = () => {
            modelDiscoveryController.abort();
            reject(new Error('Session cancelled'));
        };
        connectTimer = setTimeout(() => reject(new Error('Gemini connection timed out')), 15000);
    });
    timeoutPromise.catch(() => {});

    function connectionFailed(error) {
        if (!isCurrent()) return;
        if (closed && classifyGoogleError(error).retryable) return;
        lastGeminiError = error;
        closed = true;
        logTransportEvent('gemini.live.failed', { code: classifyGoogleError(error).code });
        if (!ready || isInitializingSession) {
            rejectReady(error);
            return;
        }
        if (global.geminiSessionRef?.current === candidate) global.geminiSessionRef.current = null;
        if (activeGeminiSession === candidate) activeGeminiSession = null;
        reconnectController.request(error);
        closeConnection(candidate);
    }

    try {
        const client = new GoogleGenAI({ apiKey: apiKey.trim(), httpOptions: { apiVersion: 'v1beta', fetch: googleHttpFetch } });
        const selectedLiveModel = getConfig().geminiLiveModel || 'auto';
        const liveModel = await Promise.race([
            modelResolver.resolve({
                apiKey: apiKey.trim(),
                client,
                selected: selectedLiveModel,
                kind: 'live',
                signal: modelDiscoveryController.signal,
            }),
            timeoutPromise,
        ]);
        if (!isCurrent()) return null;
        const enabledTools = await getEnabledTools();
        const systemPrompt = `${getSystemPrompt(
            profile,
            customPrompt,
            enabledTools.some(tool => tool.googleSearch)
        )}\n\nRespond in the selected language: ${language}.`;
        currentSystemPrompt = systemPrompt;
        if (!isReconnect) initializeNewSession(profile, customPrompt);
        if (!isCurrent()) return null;

        const connectPromise = client.live
            .connect({
                model: liveModel,
                callbacks: {
                    onopen: function () {
                        if (!isCurrent()) return;
                        logTransportEvent('gemini.live.opened', {});
                        sendToRenderer('update-status', 'Connecting to Gemini...');
                    },
                    onmessage: function (message) {
                        if (!isCurrent() || closed) return;
                        if (message.setupComplete) {
                            ready = true;
                            resolveReady();
                        }
                        const update = message.sessionResumptionUpdate;
                        if (update?.resumable && update.newHandle) resumptionHandle = update.newHandle;
                        if (message.goAway) {
                            goAwayPending = true;
                            sendToRenderer('update-status', 'Gemini is renewing the connection...');
                        }
                        // Transport diagnostics omit audio, prompts, transcripts, and resumption tokens.
                        logTransportEvent('gemini.live.message', {
                            setupComplete: Boolean(message.setupComplete),
                            turnComplete: Boolean(message.serverContent?.turnComplete),
                            interrupted: Boolean(message.serverContent?.interrupted),
                            resumable: update?.resumable,
                            usageMetadata: message.usageMetadata,
                        });

                        // Handle input transcription (what was spoken)
                        if (message.serverContent?.inputTranscription?.results) {
                            currentTranscription += formatSpeakerResults(message.serverContent.inputTranscription.results);
                        } else if (message.serverContent?.inputTranscription?.text) {
                            const text = message.serverContent.inputTranscription.text;
                            if (text.trim() !== '') {
                                currentTranscription += text;
                            }
                        }

                        if (message.serverContent?.inputTranscription?.finished) {
                            sendFinalTranscriptionToChatGPT();
                        }

                        if (!isChatGPTSession() && message.serverContent?.outputTranscription?.text) {
                            const isFirstChunk = messageBuffer === '';
                            messageBuffer += message.serverContent.outputTranscription.text;
                            sendToRenderer(isFirstChunk ? 'new-response' : 'update-response', messageBuffer);
                        }

                        if (message.serverContent?.interrupted) {
                            messageBuffer = '';
                        }
                        if (message.serverContent?.turnComplete) {
                            sendFinalTranscriptionToChatGPT();
                            if (!isChatGPTSession() && currentTranscription.trim() && messageBuffer.trim()) {
                                saveConversationTurn(currentTranscription, messageBuffer);
                            }
                            currentTranscription = '';
                            messageBuffer = '';
                            groqRequestStartedForTurn = false;
                            if (!isChatGPTSession() || (!chatgptAutomaticPaused && !chatgptController))
                                sendToRenderer('update-status', 'Listening...');
                            if (goAwayPending) connectionFailed({ code: 1000, message: 'Scheduled Gemini connection renewal' });
                        }
                    },
                    onerror: function (e) {
                        connectionFailed(e.message ? e : { code: 1006, message: 'Gemini WebSocket connection failed' });
                    },
                    onclose: function (e) {
                        connectionFailed(e);
                    },
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    outputAudioTranscription: {},
                    tools: enabledTools,
                    inputAudioTranscription: {},
                    contextWindowCompression: { triggerTokens: 24000, slidingWindow: { targetTokens: 12000 } },
                    sessionResumption: requestedHandle ? { handle: requestedHandle } : {},
                    maxOutputTokens: 2048,
                    systemInstruction: {
                        parts: [{ text: systemPrompt }],
                    },
                },
            })
            .then(session => {
                candidate = session;
                if (isCurrent() && !closed) pendingGeminiSession = session;
                else closeConnection(session);
                return session;
            });
        await Promise.race([connectPromise, readyPromise.then(() => connectPromise), timeoutPromise]);
        await Promise.race([readyPromise, timeoutPromise]);
        if (!isCurrent() || closed) {
            closeConnection(candidate);
            if (closed && isCurrent()) throw lastGeminiError || new Error('Gemini connection closed');
            return null;
        }
        activeGeminiSession = candidate;
        pendingGeminiSession = null;
        if (global.geminiSessionRef) global.geminiSessionRef.current = candidate;
        hadActiveSession = true;
        modelResolver.remember(apiKey.trim(), selectedLiveModel, liveModel, 'live');
        messageBuffer = '';
        currentTranscription = '';
        audioStreamOpen = false;
        audioFilters.system.reset();
        audioFilters.mic.reset();
        reconnectController.markConnected();

        // Resume server-side context when possible; use a small local fallback otherwise.
        if (isReconnect && !requestedHandle) {
            const contextMessage = buildContextMessage();
            if (contextMessage) candidate.sendClientContent({ turns: [{ role: 'user', parts: [{ text: contextMessage }] }], turnComplete: false });
        }
        sendToRenderer('update-status', isReconnect ? 'Reconnected! Listening...' : 'Listening...');
        return candidate;
    } catch (error) {
        closed = true;
        closeConnection(candidate);
        if (!isCurrent()) return null;
        if (global.geminiSessionRef?.current === candidate) global.geminiSessionRef.current = null;
        if (activeGeminiSession === candidate) activeGeminiSession = null;
        lastGeminiError = error;
        if (isReconnect && requestedHandle && /resum|session.*(?:expired|invalid|not found)/i.test(error.reason || error.message || '')) {
            resumptionHandle = null;
            lastGeminiError = { code: 1006, message: 'Gemini session resumption unavailable; retrying with saved context' };
        }
        const failure = classifyGoogleError(lastGeminiError);
        logTransportEvent('gemini.live.initialization_failed', { code: failure.code });
        sendToRenderer('update-status', failure.message);
        if (!isReconnect) {
            sessionParams = null;
            reconnectController.cancel();
            closeTransportLog();
        }
        return null;
    } finally {
        modelDiscoveryController.abort();
        clearTimeout(connectTimer);
        if (generation === sessionGeneration && serial === currentConnectionSerial) {
            isInitializingSession = false;
            pendingInitializationCancel = null;
            pendingGeminiSession = null;
            if (!isReconnect) sendToRenderer('session-initializing', false);
        }
    }
}

async function attemptReconnect() {
    if (!sessionParams || isUserClosing) return { code: 1008, message: 'Session cancelled' };
    const params = sessionParams;
    const session = await initializeGeminiSession(params.apiKey, params.customPrompt, params.profile, params.language, true);
    return session ? true : lastGeminiError || { code: 1006 };
}

function closeConnection(session) {
    if (!session) return;
    try {
        const result = session.close();
        if (result?.catch) result.catch(() => {});
    } catch {
        // The socket may already be closed by the server.
    }
}

// Synchronous shutdown hook used by End and Electron before-quit.
function closeActiveSession(geminiSessionRef = global.geminiSessionRef) {
    currentScreenMode = 'text';
    currentResponseProvider = 'gemini';
    chatgptOptions = null;
    chatgptController?.abort();
    chatgptController = null;
    pendingChatGPTTranscription = '';
    chatgptAutomaticPaused = false;
    chatgptPausedError = null;
    chatgptConversationHistory = [];
    reviewOverlay?.end(undefined, false);
    isUserClosing = true;
    sessionGeneration++;
    reconnectController.cancel();
    sessionParams = null;
    resumptionHandle = null;
    hadActiveSession = false;
    if (activeImageController) activeImageController.abort();
    activeImageController = null;
    if (pendingInitializationCancel) pendingInitializationCancel();
    pendingInitializationCancel = null;
    isInitializingSession = false;
    const sessions = new Set([activeGeminiSession, pendingGeminiSession, geminiSessionRef?.current]);
    activeGeminiSession = null;
    pendingGeminiSession = null;
    if (geminiSessionRef) geminiSessionRef.current = null;
    audioInFlight.clear();
    audioStreamOpen = false;
    audioFilters.system.reset();
    audioFilters.mic.reset();
    for (const session of sessions) closeConnection(session);
    closeTransportLog();
}

function killExistingSystemAudioDump() {
    // Stop only this application's child; never terminate another running app's helper.
    stopMacOSAudioCapture();
    return Promise.resolve();
}

async function startMacOSAudioCapture(geminiSessionRef) {
    if (process.platform !== 'darwin') return false;

    // Kill any existing SystemAudioDump processes first
    const stopPreviousCapture = killExistingSystemAudioDump();
    const captureGeneration = audioCaptureGeneration;
    await stopPreviousCapture;
    if (captureGeneration !== audioCaptureGeneration) return false;

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
        },
    };

    const captureProcess = spawn(systemAudioPath, [], spawnOptions);
    systemAudioProc = captureProcess;
    let ready = false;
    let intentionalStop = false;
    let settled = false;
    let readyTimer;
    let diagnostic = '';
    let resolveStartup;
    const startup = new Promise(resolve => {
        resolveStartup = resolve;
    });
    function settleStartup(success) {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        if (cancelAudioStartup === cancelStartup) cancelAudioStartup = null;
        resolveStartup(success);
    }
    function cancelStartup() {
        intentionalStop = true;
        settleStartup(false);
    }
    function failCapture(reason) {
        if (intentionalStop || systemAudioProc !== captureProcess) return;
        intentionalStop = true;
        settleStartup(false);
        systemAudioProc = null;
        captureProcess.kill('SIGTERM');
        if (currentProviderMode === 'cloud') closeCloud();
        else if (currentProviderMode === 'local') getLocalAi().closeLocalSession();
        else closeActiveSession(geminiSessionRef);
        sendToRenderer('update-status', reason);
        sendToRenderer('provider-session-ended', { reason, code: 'audio_capture' });
    }
    // A successful spawn is insufficient: ScreenCaptureKit can refuse permission asynchronously.
    cancelAudioStartup = cancelStartup;
    readyTimer = setTimeout(
        () => failCapture('System audio did not start. Check Screen Recording permission for Honest Father in macOS Settings.'),
        15000
    );

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);

    captureProcess.stdout.on('data', data => {
        if (intentionalStop || systemAudioProc !== captureProcess || !ready) return;
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;

            if (currentProviderMode === 'cloud') {
                sendCloudAudio(monoChunk);
            } else if (currentProviderMode === 'local') {
                getLocalAi().processLocalAudio(monoChunk);
            } else {
                const base64Data = monoChunk.toString('base64');
                sendAudioToGemini(base64Data, geminiSessionRef);
            }

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    captureProcess.stderr.on('data', data => {
        diagnostic = (diagnostic + data.toString()).slice(-4000);
        if (diagnostic.includes('System audio capture started:')) {
            ready = true;
            settleStartup(true);
        }
    });

    captureProcess.on('close', code => {
        if (intentionalStop || systemAudioProc !== captureProcess) return;
        const detail = diagnostic.trim().split('\n').pop()?.slice(0, 240);
        failCapture(
            `System audio stopped${code !== null ? ` (code ${code})` : ''}. ${detail || 'Check Screen Recording permission and restart the session.'}`
        );
    });

    captureProcess.on('error', err => {
        failCapture(`System audio helper could not start (${err.code || 'unknown error'}). Check the macOS app installation.`);
    });

    return startup;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    audioCaptureGeneration++;
    if (cancelAudioStartup) cancelAudioStartup();
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        const captureProcess = systemAudioProc;
        systemAudioProc = null;
        captureProcess.kill('SIGTERM');
    }
}

async function sendAudioToGemini(base64Data, geminiSessionRef) {
    return sendGeminiAudio(base64Data, 'audio/pcm;rate=24000', geminiSessionRef, 'system');
}

async function sendGeminiAudio(data, mimeType, geminiSessionRef, source) {
    const session = geminiSessionRef?.current;
    if (!session || isUserClosing) return { success: true, skipped: true, code: 'disconnected' };
    if (typeof data !== 'string' || data.length > 350000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || !/^audio\/pcm;rate=\d{4,5}$/.test(mimeType)) {
        return { success: false, error: 'Invalid PCM audio data or sample rate' };
    }
    if (audioInFlight.has(source)) return { success: true, skipped: true, code: 'busy' };
    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length || buffer.length % 2) return { success: false, error: 'Audio must contain 16-bit PCM samples' };
    const activity = getConfig().audioSilenceFilter === false ? { send: true, ended: false } : audioFilters[source].inspect(buffer);
    if (!activity.send && !(activity.ended && audioStreamOpen && !audioFilters.system.isOpen && !audioFilters.mic.isOpen)) {
        return { success: true, skipped: true, code: 'silence' };
    }
    audioInFlight.add(source);
    try {
        if (activity.send) {
            await session.sendRealtimeInput({ audio: { data, mimeType } });
            audioStreamOpen = true;
        } else {
            await session.sendRealtimeInput({ audioStreamEnd: true });
            audioStreamOpen = false;
        }
        return { success: true };
    } catch (error) {
        if (geminiSessionRef.current === session) {
            geminiSessionRef.current = null;
            activeGeminiSession = null;
            reconnectController.request(error);
            closeConnection(session);
        }
        const failure = classifyGoogleError(error);
        return { success: false, error: failure.message, code: failure.code };
    } finally {
        audioInFlight.delete(source);
    }
}

async function sendImageToGeminiHttp(base64Data, prompt, { testReview = false } = {}) {
    const selectedModel = getAvailableModel();
    const kind = testReview ? 'review' : 'image';
    let model = selectedModel;

    const rawApiKey = getApiKey();
    const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : '';
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }
    const gated = imageRequestGate.begin(JSON.stringify([selectedModel, apiKey]));
    if (gated) return gated;
    const generation = sessionGeneration;
    const sessionId = currentSessionId;
    const controller = new AbortController();
    activeImageController = controller;
    const isCurrent = () => generation === sessionGeneration && (sessionId === null || sessionId === currentSessionId) && !controller.signal.aborted;
    let failure = null;

    try {
        // Disable SDK retries; only an explicit model rejection before any response
        // may switch to one catalogue-supported alternative.
        // SDK defaults otherwise retry quota failures five times before surfacing them.
        const ai = new GoogleGenAI({
            apiKey: apiKey,
            httpOptions: { apiVersion: 'v1beta', timeout: 45000, retryOptions: { attempts: 1 }, fetch: googleHttpFetch },
        });
        model = await modelResolver.resolve({ apiKey, client: ai, selected: selectedModel, kind, signal: controller.signal });
        if (!isCurrent()) return { success: true, skipped: true, code: 'cancelled' };

        const contents = [
            {
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: base64Data,
                },
            },
            { text: prompt },
        ];

        let fullText = '';
        let responseStarted = false;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                console.log(`Sending image to ${model} (streaming)...`);
                const response = await ai.models.generateContentStream({
                    model,
                    contents,
                    config: {
                        maxOutputTokens: 4096,
                        systemInstruction: testReview
                            ? REVIEW_SYSTEM_PROMPT
                            : getScreenshotSystemPrompt(currentProfile || 'interview', currentCustomPrompt || ''),
                        ...(testReview ? { responseMimeType: 'application/json', temperature: 0.1 } : {}),
                        abortSignal: controller.signal,
                    },
                });
                if (!isCurrent()) return { success: true, skipped: true, code: 'cancelled' };
                let isFirst = true;
                for await (const chunk of response) {
                    if (!isCurrent()) return { success: true, skipped: true, code: 'cancelled' };
                    // Even a metadata/thought-only chunk means generation already began.
                    responseStarted = true;
                    const chunkText = chunk.text;
                    if (chunkText) {
                        fullText += chunkText;
                        if (!testReview) sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                        isFirst = false;
                    }
                }
                break;
            } catch (error) {
                if (!isCurrent()) return { success: true, skipped: true, code: 'cancelled' };
                if (attempt !== 0 || responseStarted || classifyGoogleError(error).code !== 'model') throw error;
                modelResolver.reject(apiKey, model, kind);
                model = await modelResolver.resolve({
                    apiKey,
                    client: ai,
                    selected: selectedModel,
                    kind,
                    signal: controller.signal,
                    fallback: true,
                    exclude: [model],
                });
                if (!isCurrent()) return { success: true, skipped: true, code: 'cancelled' };
                sendToRenderer('update-status', 'Selected model unavailable; using a compatible Gemini model...');
            }
        }

        if (!isCurrent()) return { success: true, skipped: true, code: 'cancelled' };
        console.log(`Image response completed from ${model}`);

        if (!fullText.trim()) {
            return {
                success: false,
                error: 'Gemini returned no text. The request may have been blocked; revise the prompt and try again.',
                code: 'empty_response',
            };
        }
        incrementLimitCount(model);
        modelResolver.remember(apiKey, selectedModel, model, kind);
        if (!testReview) saveScreenAnalysis(prompt, fullText, model);

        return { success: true, text: fullText, model: model };
    } catch (error) {
        if (!isCurrent()) return { success: true, skipped: true, code: 'cancelled' };
        failure = error;
        const classified = classifyGoogleError(error);
        logTransportEvent('gemini.image.failed', { model, code: classified.code, transport: 'chromium', ...googleErrorDiagnostics(error) });
        sendToRenderer('update-status', classified.message);
        return {
            success: false,
            error: classified.message,
            code: classified.code,
            retryAfterMs: Number.isFinite(classified.cooldownMs) ? classified.cooldownMs : null,
        };
    } finally {
        if (activeImageController === controller) activeImageController = null;
        imageRequestGate.finish(failure);
    }
}

function setupGeminiIpcHandlers(geminiSessionRef) {
    // Store the geminiSessionRef globally for reconnection access
    global.geminiSessionRef = geminiSessionRef;
    const trustedSender = event =>
        rendererWindow &&
        !rendererWindow.isDestroyed() &&
        event.sender === rendererWindow.webContents &&
        event.senderFrame === rendererWindow.webContents.mainFrame;

    ipcMain.handle('initialize-screen-session', async (event, profile = 'interview', customPrompt = '', mode = 'text') => {
        if (
            typeof profile !== 'string' ||
            typeof customPrompt !== 'string' ||
            customPrompt.length > 32000 ||
            !['text', 'test-review'].includes(mode)
        ) {
            sendToRenderer('update-status', 'Invalid screen session settings.');
            return false;
        }
        if (!trustedSender(event)) return false;
        const useChatGPT = mode !== 'test-review' && getConfig().normalResponseProvider === 'chatgpt';
        if (!useChatGPT && !getApiKey()?.trim() && !(mode === 'test-review' && hasGroqKey())) {
            sendToRenderer('update-status', 'Enter a Gemini API key in Home before starting.');
            return false;
        }
        closeActiveSession(geminiSessionRef);
        stopMacOSAudioCapture();
        if (currentProviderMode === 'local') getLocalAi().closeLocalSession();
        if (currentProviderMode === 'cloud') closeCloud();
        currentProviderMode = 'byok';
        currentScreenMode = mode;
        currentResponseProvider = useChatGPT ? 'chatgpt' : 'gemini';
        if (useChatGPT) {
            const preparingGeneration = sessionGeneration;
            try {
                const prepared = await chatgpt.prepareChatGPT();
                if (preparingGeneration !== sessionGeneration) return false;
                chatgptOptions = prepared;
            } catch (error) {
                if (preparingGeneration === sessionGeneration) sendToRenderer('update-status', error.message);
                return false;
            }
        }
        initializeNewSession(profile, customPrompt);
        currentSystemPrompt = getScreenshotSystemPrompt(profile, customPrompt);
        sendToRenderer('update-status', 'Screen ready');
        return true;
    });

    ipcMain.handle('initialize-cloud', async (event, token, profile, userContext) => {
        try {
            closeActiveSession(geminiSessionRef);
            currentProviderMode = 'cloud';
            initializeNewSession(profile);
            setOnTurnComplete((transcription, response) => {
                saveConversationTurn(transcription, response);
            });
            sendToRenderer('session-initializing', true);
            await connectCloud(token, profile, userContext);
            sendToRenderer('session-initializing', false);
            return true;
        } catch (err) {
            console.error('[Cloud] Init error:', err);
            currentProviderMode = 'byok';
            sendToRenderer('session-initializing', false);
            return false;
        }
    });

    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        if (!trustedSender(event)) return false;
        currentProviderMode = 'byok';
        const session = await initializeGeminiSession(apiKey, customPrompt, profile, language);
        if (session) {
            geminiSessionRef.current = session;
            return true;
        }
        return false;
    });

    ipcMain.handle('initialize-local', async (event, localLlmModel, whisperModel, profile, customPrompt) => {
        closeActiveSession(geminiSessionRef);
        currentProviderMode = 'local';
        const success = await getLocalAi().initializeLocalSession(localLlmModel, whisperModel, profile, customPrompt);
        if (!success) {
            currentProviderMode = 'byok';
        }
        return success;
    });

    ipcMain.handle('cancel-local-initialization', async () => {
        const cancelled = await getLocalAi().cancelLocalInitialization();
        if (cancelled) {
            currentProviderMode = 'byok';
        }
        return cancelled;
    });

    ipcMain.handle('send-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local audio:', error);
                return { success: false, error: error.message };
            }
        }
        return sendGeminiAudio(data, mimeType, geminiSessionRef, 'system');
    });

    // Handle microphone audio on a separate channel
    ipcMain.handle('send-mic-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        return sendGeminiAudio(data, mimeType, geminiSessionRef, 'mic');
    });

    ipcMain.handle('send-image-content', async (event, payload = {}) => {
        try {
            if (isChatGPTSession() && !trustedSender(event)) return { success: false, error: 'Untrusted ChatGPT request.' };
            const { data, reviewCapture, imageWidth, imageHeight } = payload;
            const testReview = currentScreenMode === 'test-review';
            const prompt = testReview ? REVIEW_USER_PROMPT : payload.prompt;
            if (testReview || reviewCapture) {
                if (
                    !testReview ||
                    !reviewOverlay?.isActive() ||
                    !rendererWindow ||
                    event.sender !== rendererWindow.webContents ||
                    event.senderFrame !== rendererWindow.webContents.mainFrame
                ) {
                    return { success: false, error: 'Invalid test review request.' };
                }
                const valid = reviewOverlay.validateCapture(reviewCapture, { imageWidth, imageHeight });
                if (!valid.success) return valid;
            }
            if (!data || typeof data !== 'string' || data.length > 14000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) return { success: false, error: 'Invalid image prompt' };
            const buffer = Buffer.from(data, 'base64');

            if (buffer.length < 1000) {
                console.error(`Image buffer too small: ${buffer.length} bytes`);
                return { success: false, error: 'Image buffer too small' };
            }

            process.stdout.write('!');

            if (currentProviderMode === 'cloud') {
                const sent = sendCloudImage(data);
                if (!sent) {
                    return { success: false, error: 'Cloud connection not active' };
                }
                return { success: true, model: 'cloud' };
            }

            if (currentProviderMode === 'local') {
                const result = await getLocalAi().sendLocalImage(data, prompt);
                return result;
            }

            const result = isChatGPTSession()
                ? await sendToChatGPT(prompt, data)
                : testReview && hasGroqKey()
                  ? await sendImageToGroq(data, prompt, { testReview })
                  : await sendImageToGeminiHttp(data, prompt, { testReview });
            if (testReview && result.success && !result.skipped) {
                const answer = parseReviewAnswer(result.text);
                const cached = reviewOverlay.cacheAnswer(reviewCapture, answer, { imageWidth, imageHeight });
                if (!cached.success) return cached;
                return { success: true, reviewAnswer: answer, model: result.model };
            }
            return result;
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (isChatGPTSession() && !trustedSender(event)) return { success: false, error: 'Untrusted ChatGPT request.' };
        if (!text || typeof text !== 'string' || text.trim().length === 0 || text.length > 32000) {
            return { success: false, error: 'Invalid text message' };
        }

        if (currentProviderMode === 'cloud') {
            try {
                console.log('Sending text to cloud:', text);
                sendCloudText(text.trim());
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud text:', error);
                return { success: false, error: error.message };
            }
        }

        if (currentProviderMode === 'local') {
            try {
                console.log('Sending text to local Llama:', text);
                return await getLocalAi().sendLocalText(text.trim());
            } catch (error) {
                console.error('Error sending local text:', error);
                return { success: false, error: error.message };
            }
        }

        if (isChatGPTSession()) return sendToChatGPT(text.trim());
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };

        try {
            console.log('Sending text message:', text);

            currentTranscription = text.trim();
            await geminiSessionRef.current.sendClientContent({ turns: [{ role: 'user', parts: [{ text: text.trim() }] }], turnComplete: true });
            return { success: true };
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture(geminiSessionRef);
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async (event, options = {}) => {
        try {
            stopMacOSAudioCapture();

            if (currentProviderMode === 'cloud') {
                closeCloud();
                currentProviderMode = 'byok';
                closeTransportLog();
                return { success: true };
            }

            if (currentProviderMode === 'local') {
                getLocalAi().closeLocalSession();
                currentProviderMode = 'byok';
                closeTransportLog();
                return { success: true };
            }

            closeActiveSession(geminiSessionRef);
            if (options?.silent !== true) sendToRenderer('update-status', 'Session closed');
            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    // Conversation history IPC handlers
    ipcMain.handle('get-current-session', async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-google-search-setting', async (event, enabled) => {
        try {
            console.log('Google Search setting updated to:', enabled);
            // The setting is already saved in localStorage by the renderer
            // This is just for logging/confirmation
            return { success: true };
        } catch (error) {
            console.error('Error updating Google Search setting:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    setMainWindow,
    initializeGeminiSession,
    isChatGPTSession,
    getEnabledTools,
    getStoredSetting,
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
    closeActiveSession,
    sendAudioToGemini,
    sendImageToGeminiHttp,
    setupGeminiIpcHandlers,
    formatSpeakerResults,
};
