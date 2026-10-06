import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

const LOCAL_LLM_PRESETS = [
    { value: 'unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M', label: 'Qwen 3.5 0.8B Q4 — 0.74 GB · Fastest' },
    { value: 'unsloth/Qwen3.5-0.8B-GGUF:Q8_0', label: 'Qwen 3.5 0.8B Q8 — 1.02 GB' },
    { value: 'unsloth/Qwen3.5-2B-GGUF:Q4_K_M', label: 'Qwen 3.5 2B Q4 — 1.95 GB' },
    { value: 'unsloth/Qwen3.5-2B-GGUF:Q8_0', label: 'Qwen 3.5 2B Q8 — 2.68 GB' },
    { value: 'unsloth/Qwen3.5-4B-GGUF:Q4_K_M', label: 'Qwen 3.5 4B Q4 — 3.42 GB · Recommended' },
    { value: 'unsloth/Qwen3.5-4B-GGUF:Q8_0', label: 'Qwen 3.5 4B Q8 — 5.16 GB' },
    { value: 'unsloth/Qwen3.5-9B-GGUF:Q4_K_M', label: 'Qwen 3.5 9B Q4 — 6.60 GB' },
    { value: 'unsloth/Qwen3.5-9B-GGUF:Q8_0', label: 'Qwen 3.5 9B Q8 — 10.45 GB' },
    { value: 'unsloth/Qwen3.5-27B-GGUF:Q4_K_M', label: 'Qwen 3.5 27B Q4 — 17.67 GB' },
    { value: 'unsloth/Qwen3.5-35B-A3B-GGUF:Q4_K_M', label: 'Qwen 3.5 35B-A3B Q4 — 22.92 GB · Largest' },
];

export class MainView extends LitElement {
    static styles = css`
        * {
            font-family: var(--font);
            cursor: default;
            user-select: none;
            box-sizing: border-box;
        }

        :host {
            height: 100%;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: var(--space-xl) var(--space-lg);
        }

        .form-wrapper {
            width: 100%;
            max-width: 420px;
            display: flex;
            flex-direction: column;
            gap: var(--space-md);
        }

        .page-title {
            font-size: var(--font-size-xl);
            font-weight: var(--font-weight-semibold);
            color: var(--text-primary);
            margin-bottom: var(--space-xs);
        }

        .page-title .mode-suffix {
            opacity: 0.5;
        }

        .page-subtitle {
            font-size: var(--font-size-sm);
            color: var(--text-muted);
            margin-bottom: var(--space-md);
        }

        /* ── Cloud promo card ── */

        .cloud-promo {
            position: relative;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding: 14px 16px;
            border-radius: var(--radius-md);
            border: 1px solid rgba(59, 130, 246, 0.45);
            background: linear-gradient(135deg, rgba(59, 130, 246, 0.12) 0%, rgba(139, 92, 246, 0.09) 100%);
            cursor: pointer;
            transition:
                border-color 0.2s,
                background 0.2s;
        }

        .cloud-promo:hover {
            border-color: rgba(59, 130, 246, 0.65);
            background: linear-gradient(135deg, rgba(59, 130, 246, 0.16) 0%, rgba(139, 92, 246, 0.12) 100%);
            box-shadow:
                0 0 20px rgba(59, 130, 246, 0.15),
                0 0 40px rgba(139, 92, 246, 0.08);
        }

        .cloud-promo-glow {
            position: absolute;
            top: -40%;
            right: -20%;
            width: 120px;
            height: 120px;
            background: radial-gradient(circle, rgba(59, 130, 246, 0.15) 0%, transparent 70%);
            pointer-events: none;
        }

        .cloud-promo-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .cloud-promo-title {
            font-size: var(--font-size-sm);
            font-weight: var(--font-weight-semibold);
            color: var(--text-primary);
        }

        .cloud-promo-arrow {
            color: var(--accent);
            font-size: 16px;
            transition: transform 0.2s;
        }

        .cloud-promo:hover .cloud-promo-arrow {
            transform: translateX(2px);
        }

        .cloud-promo-desc {
            font-size: var(--font-size-xs);
            color: var(--text-secondary);
            line-height: var(--line-height);
        }

        /* ── Form controls ── */

        .form-group {
            display: flex;
            flex-direction: column;
            gap: var(--space-xs);
        }

        .config-section {
            border: 1px solid var(--border);
            border-radius: var(--radius-md);
            background: var(--bg-surface);
            overflow: hidden;
        }

        .config-summary {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: var(--space-md);
            padding: 12px 14px;
            cursor: pointer;
            list-style: none;
        }

        .config-summary::-webkit-details-marker {
            display: none;
        }

        .config-summary-text {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .config-summary-title {
            font-size: var(--font-size-sm);
            font-weight: var(--font-weight-medium);
            color: var(--text-primary);
        }

        .config-summary-description {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
        }

        .config-chevron {
            width: 16px;
            height: 16px;
            color: var(--text-muted);
            transition: transform var(--transition);
        }

        .config-section[open] .config-chevron {
            transform: rotate(180deg);
        }

        .config-content {
            display: flex;
            flex-direction: column;
            gap: var(--space-md);
            padding: 14px;
            border-top: 1px solid var(--border);
        }

        .config-note {
            padding: 10px 12px;
            border: 1px solid rgba(212, 160, 23, 0.28);
            border-radius: var(--radius-sm);
            background: rgba(212, 160, 23, 0.08);
            color: var(--text-secondary);
            font-size: var(--font-size-xs);
            line-height: var(--line-height);
        }

        .config-checkbox {
            display: flex;
            align-items: flex-start;
            gap: var(--space-sm);
            cursor: pointer;
        }

        .config-checkbox input {
            width: 16px;
            height: 16px;
            margin-top: 2px;
            padding: 0;
            accent-color: var(--accent);
            cursor: pointer;
        }

        .config-checkbox-text {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .form-label {
            font-size: var(--font-size-xs);
            font-weight: var(--font-weight-medium);
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        input,
        select,
        textarea {
            background: var(--bg-elevated);
            color: var(--text-primary);
            border: 1px solid var(--border);
            padding: 10px 12px;
            width: 100%;
            border-radius: var(--radius-sm);
            font-size: var(--font-size-sm);
            font-family: var(--font);
            transition:
                border-color var(--transition),
                box-shadow var(--transition);
        }

        input:hover:not(:focus),
        select:hover:not(:focus),
        textarea:hover:not(:focus) {
            border-color: var(--text-muted);
        }

        input:focus,
        select:focus,
        textarea:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 1px var(--accent);
        }

        input::placeholder,
        textarea::placeholder {
            color: var(--text-muted);
        }

        input.error {
            border-color: var(--danger, #ef4444);
        }

        select {
            cursor: pointer;
            appearance: none;
            background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%23999' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e");
            background-position: right 8px center;
            background-repeat: no-repeat;
            background-size: 14px;
            padding-right: 28px;
        }

        textarea {
            resize: vertical;
            min-height: 80px;
            line-height: var(--line-height);
        }

        .form-hint {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
        }

        .form-hint a,
        .form-hint span.link {
            color: var(--accent);
            text-decoration: none;
            cursor: pointer;
        }

        .form-hint span.link:hover {
            text-decoration: underline;
        }

        .whisper-label-row {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .whisper-spinner {
            width: 12px;
            height: 12px;
            border: 2px solid var(--border);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: whisper-spin 0.8s linear infinite;
        }

        @keyframes whisper-spin {
            to {
                transform: rotate(360deg);
            }
        }

        /* ── Start button ── */

        .start-button {
            position: relative;
            overflow: hidden;
            background: #e8e8e8;
            color: #111111;
            border: none;
            padding: 12px var(--space-md);
            border-radius: var(--radius-sm);
            font-size: var(--font-size-base);
            font-weight: var(--font-weight-semibold);
            cursor: pointer;
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: var(--space-sm);
        }

        .start-button canvas.btn-aurora {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            z-index: 0;
        }

        .start-button canvas.btn-dither {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            z-index: 1;
            opacity: 0.1;
            mix-blend-mode: overlay;
            pointer-events: none;
            image-rendering: pixelated;
        }

        .start-button .btn-label {
            position: relative;
            z-index: 2;
            display: flex;
            align-items: center;
            gap: var(--space-sm);
        }

        .start-button:hover {
            opacity: 0.9;
        }

        .start-button.disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .start-button.disabled:hover {
            opacity: 0.5;
        }

        .download-progress-fill {
            position: absolute;
            inset: 0 auto 0 0;
            z-index: 2;
            width: 0;
            background: rgba(17, 17, 17, 0.16);
            transition: width 0.2s ease;
            pointer-events: none;
        }

        .download-progress-fill.indeterminate {
            width: 38%;
            animation: download-progress-slide 1.2s ease-in-out infinite;
        }

        .download-controls {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: var(--space-md);
            margin-top: var(--space-xs);
            font-size: var(--font-size-xs);
            color: var(--text-muted);
        }

        .download-cancel {
            flex: none;
            padding: 0;
            border: none;
            background: none;
            color: var(--danger, #ef4444);
            font: inherit;
            cursor: pointer;
        }

        .download-cancel:hover {
            text-decoration: underline;
        }

        @keyframes download-progress-slide {
            from {
                transform: translateX(-105%);
            }
            to {
                transform: translateX(270%);
            }
        }

        .shortcut-hint {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            opacity: 0.5;
            font-family: var(--font-mono);
        }

        /* ── Divider ── */

        .divider {
            display: flex;
            align-items: center;
            gap: var(--space-md);
            margin: var(--space-sm) 0;
        }

        .divider-line {
            flex: 1;
            height: 1px;
            background: var(--border);
        }

        .divider-text {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
            text-transform: lowercase;
        }

        /* ── Mode switch links ── */

        .mode-links {
            display: flex;
            justify-content: center;
            gap: var(--space-lg);
        }

        .mode-link {
            font-size: var(--font-size-sm);
            color: var(--text-secondary);
            cursor: pointer;
            background: none;
            border: none;
            padding: 0;
            transition: color var(--transition);
        }

        .mode-link:hover {
            color: var(--text-primary);
        }

        .chatgpt-sign-in {
            background: #fff;
            color: #111;
            border: 1px solid #ddd;
            border-radius: var(--radius-sm);
            padding: 11px 14px;
            font-size: var(--font-size-sm);
            font-weight: var(--font-weight-medium);
            cursor: pointer;
        }

        .account-actions {
            display: flex;
            flex-wrap: wrap;
            gap: var(--space-md);
        }

        .account-actions .mode-link {
            font-size: var(--font-size-xs);
        }

        .chatgpt-sign-in:disabled,
        .account-actions button:disabled {
            opacity: 0.5;
            cursor: default;
        }

        /* ── Mode option cards ── */

        .mode-cards {
            display: flex;
            gap: var(--space-sm);
        }

        .mode-card {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 12px 14px;
            border-radius: var(--radius-md);
            border: 1px solid var(--border);
            background: var(--bg-elevated);
            cursor: pointer;
            transition:
                border-color 0.2s,
                background 0.2s;
        }

        .mode-card:hover {
            border-color: var(--text-muted);
            background: var(--bg-hover);
        }

        .mode-card-title {
            font-size: var(--font-size-sm);
            font-weight: var(--font-weight-semibold);
            color: var(--text-primary);
        }

        .mode-card-desc {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
            line-height: var(--line-height);
        }

        /* ── Title row with help ── */

        .title-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: var(--space-xs);
        }

        .title-row .page-title {
            margin-bottom: 0;
        }

        .help-btn {
            background: none;
            border: none;
            color: var(--text-muted);
            cursor: pointer;
            padding: 4px;
            border-radius: var(--radius-sm);
            transition: color 0.2s;
            display: flex;
            align-items: center;
        }

        .help-btn:hover {
            color: var(--text-secondary);
        }

        .help-btn * {
            pointer-events: none;
        }

        .help-dialog-backdrop {
            position: fixed;
            inset: 0;
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: var(--space-lg);
            background: rgba(0, 0, 0, 0.62);
        }

        .help-dialog {
            width: min(680px, 100%);
            max-height: calc(100vh - 48px);
            display: flex;
            flex-direction: column;
            gap: var(--space-md);
            padding: var(--space-lg);
            overflow: hidden;
            background: var(--bg-surface);
            border: 1px solid var(--border-strong);
            border-radius: var(--radius-lg);
            color: var(--text-primary);
        }

        .help-dialog-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: var(--space-md);
        }

        .help-dialog-title {
            font-size: var(--font-size-lg);
            font-weight: var(--font-weight-semibold);
        }

        /* ── Help content ── */

        .help-content {
            display: flex;
            flex-direction: column;
            gap: var(--space-md);
            overflow-y: auto;
        }

        .help-section {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .help-section-title {
            font-size: var(--font-size-xs);
            font-weight: var(--font-weight-semibold);
            color: var(--text-primary);
        }

        .help-section-text {
            font-size: var(--font-size-xs);
            color: var(--text-secondary);
            line-height: var(--line-height);
        }

        .help-code {
            font-family: var(--font-mono);
            font-size: 11px;
            background: var(--bg-hover);
            padding: 6px 8px;
            border-radius: var(--radius-sm);
            color: var(--text-primary);
            display: block;
        }

        .help-link {
            color: var(--accent);
            cursor: pointer;
            text-decoration: none;
        }

        .help-link:hover {
            text-decoration: underline;
        }

        .help-models {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .help-model {
            font-size: var(--font-size-xs);
            color: var(--text-secondary);
            display: flex;
            justify-content: space-between;
        }

        .help-model-name {
            font-family: var(--font-mono);
            font-size: 11px;
            color: var(--text-primary);
        }

        .help-divider {
            border: none;
            border-top: 1px solid var(--border);
            margin: 0;
        }

        .help-cloud-btn {
            background: #e8e8e8;
            color: #111111;
            border: none;
            padding: 10px var(--space-md);
            border-radius: var(--radius-sm);
            font-size: var(--font-size-sm);
            font-family: var(--font);
            font-weight: var(--font-weight-semibold);
            cursor: pointer;
            width: 100%;
            transition: opacity 0.15s;
        }

        .help-cloud-btn:hover {
            opacity: 0.9;
        }

        .help-warn {
            font-size: var(--font-size-xs);
            color: var(--warning);
            line-height: var(--line-height);
        }
    `;

    static properties = {
        onStart: { type: Function },
        onStartReview: { type: Function },
        statusText: { type: String },
        onExternalLink: { type: Function },
        selectedProfile: { type: String },
        onProfileChange: { type: Function },
        isInitializing: { type: Boolean },
        whisperDownloading: { type: Boolean },
        downloadProgress: { type: Object },
        onCancelDownload: { type: Function },
        // Internal state
        _mode: { state: true },
        _token: { state: true },
        _geminiKey: { state: true },
        _openaiKey: { state: true },
        _geminiLiveModel: { state: true },
        _geminiImageModel: { state: true },
        _normalResponseProvider: { state: true },
        _chatgptStatus: { state: true },
        _chatgptModels: { state: true },
        _chatgptModel: { state: true },
        _chatgptReasoningMode: { state: true },
        _chatgptUseTranscription: { state: true },
        _chatgptBusy: { state: true },
        _chatgptModelsLoading: { state: true },
        _chatgptError: { state: true },
        _providerSaving: { state: true },
        _showChatGPTPlanNotice: { state: true },
        _tokenError: { state: true },
        _keyError: { state: true },
        // Local AI state
        _localLlmModel: { state: true },
        _useCustomLocalLlmModel: { state: true },
        _whisperModel: { state: true },
        _showLocalHelp: { state: true },
    };

    constructor() {
        super();
        this.onStart = () => {};
        this.onStartReview = () => {};
        this.statusText = '';
        this.onExternalLink = () => {};
        this.selectedProfile = 'interview';
        this.onProfileChange = () => {};
        this.isInitializing = false;
        this.whisperDownloading = false;
        this.downloadProgress = { active: false, label: '', percentage: null };
        this.onCancelDownload = () => {};

        this._mode = 'byok';
        this._token = '';
        this._geminiKey = '';
        this._openaiKey = '';
        this._geminiLiveModel = 'auto';
        this._geminiImageModel = 'auto';
        this._normalResponseProvider = 'gemini';
        this._chatgptStatus = { connected: false, planEnabled: false, connecting: false };
        this._chatgptModels = [];
        this._chatgptModel = '';
        this._chatgptReasoningMode = 'standard';
        this._chatgptUseTranscription = false;
        this._chatgptBusy = false;
        this._chatgptModelsLoading = false;
        this._chatgptError = '';
        this._providerSaving = false;
        this._chatgptModelsGeneration = 0;
        this._chatgptPlanNoticeDismissed = false;
        this._showChatGPTPlanNotice = false;
        this._storageLoaded = false;
        this._tokenError = false;
        this._keyError = false;
        this._showLocalHelp = false;
        this._localLlmModel = 'unsloth/Qwen3.5-4B-GGUF:Q4_K_M';
        this._useCustomLocalLlmModel = false;
        this._whisperModel = 'tiny.en';

        this._animId = null;
        this._time = 0;
        this._mouseX = -1;
        this._mouseY = -1;

        this.boundKeydownHandler = this._handleKeydown.bind(this);
        this._storageLoad = this._loadFromStorage();
    }

    async _loadFromStorage() {
        try {
            const [config, prefs, creds] = await Promise.all([
                cheatingDaddy.storage.getConfig(),
                cheatingDaddy.storage.getPreferences(),
                cheatingDaddy.storage.getCredentials().catch(() => ({})),
            ]);

            const storedMode = prefs.providerMode || 'byok';
            this._mode = storedMode === 'cloud' ? 'byok' : storedMode;

            if (storedMode === 'cloud') {
                await cheatingDaddy.storage.updatePreference('providerMode', this._mode);
            }

            // Load keys
            this._token = creds.cloudToken || '';
            this._geminiKey = (await cheatingDaddy.storage.getApiKey().catch(() => '')) || '';
            this._openaiKey = creds.openaiKey || '';
            this._geminiLiveModel = config.geminiLiveModel || 'auto';
            this._geminiImageModel = config.geminiImageModel || 'auto';
            this._normalResponseProvider = config.normalResponseProvider === 'chatgpt' ? 'chatgpt' : 'gemini';
            this._chatgptModel = config.chatgptModel || '';
            this._chatgptReasoningMode = config.chatgptReasoningMode === 'pro' ? 'pro' : 'standard';
            this._chatgptUseTranscription = config.chatgptUseTranscription === true;
            this._chatgptPlanNoticeDismissed = config.chatgptPlanNoticeDismissed === true;

            // Load local AI settings
            this._localLlmModel = prefs.localLlmModel || 'unsloth/Qwen3.5-4B-GGUF:Q4_K_M';
            this._useCustomLocalLlmModel = !LOCAL_LLM_PRESETS.some(preset => preset.value === this._localLlmModel);
            this._whisperModel = prefs.whisperModel || 'tiny.en';

            this.requestUpdate();
        } catch (e) {
            console.error('Error loading MainView storage:', e);
        } finally {
            this._storageLoaded = true;
        }
    }

    connectedCallback() {
        super.connectedCallback();
        document.addEventListener('keydown', this.boundKeydownHandler);
        this._chatgptIpc = window.require('electron').ipcRenderer;
        this._chatgptStatusListener = (_event, status) => this._applyChatGPTStatus(status);
        this._chatgptIpc.on('chatgpt-status-changed', this._chatgptStatusListener);
        this._storageLoad.then(() => this._refreshChatGPTStatus());
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        document.removeEventListener('keydown', this.boundKeydownHandler);
        this._chatgptIpc?.removeListener('chatgpt-status-changed', this._chatgptStatusListener);
        this._chatgptModelsGeneration += 1;
        if (this._animId) cancelAnimationFrame(this._animId);
    }

    updated(changedProperties) {
        super.updated(changedProperties);
        if (changedProperties.has('_mode')) {
            // Stop old animation when switching modes
            if (this._animId) {
                cancelAnimationFrame(this._animId);
                this._animId = null;
            }
        }
    }

    _initButtonAurora() {
        const btn = this.shadowRoot.querySelector('.start-button');
        const aurora = this.shadowRoot.querySelector('canvas.btn-aurora');
        const dither = this.shadowRoot.querySelector('canvas.btn-dither');
        if (!aurora || !dither || !btn) return;

        // Mouse tracking
        this._mouseX = -1;
        this._mouseY = -1;
        btn.addEventListener('mousemove', e => {
            const rect = btn.getBoundingClientRect();
            this._mouseX = (e.clientX - rect.left) / rect.width;
            this._mouseY = (e.clientY - rect.top) / rect.height;
        });
        btn.addEventListener('mouseleave', () => {
            this._mouseX = -1;
            this._mouseY = -1;
        });

        // Dither
        const blockSize = 8;
        const cols = Math.ceil(aurora.offsetWidth / blockSize);
        const rows = Math.ceil(aurora.offsetHeight / blockSize);
        dither.width = cols;
        dither.height = rows;
        const dCtx = dither.getContext('2d');
        const img = dCtx.createImageData(cols, rows);
        for (let i = 0; i < img.data.length; i += 4) {
            const v = Math.random() > 0.5 ? 255 : 0;
            img.data[i] = v;
            img.data[i + 1] = v;
            img.data[i + 2] = v;
            img.data[i + 3] = 255;
        }
        dCtx.putImageData(img, 0, 0);

        // Aurora
        const ctx = aurora.getContext('2d');
        const scale = 0.4;
        aurora.width = Math.floor(aurora.offsetWidth * scale);
        aurora.height = Math.floor(aurora.offsetHeight * scale);

        const blobs = [
            { color: [120, 160, 230], x: 0.1, y: 0.3, vx: 0.25, vy: 0.2, phase: 0 },
            { color: [150, 120, 220], x: 0.8, y: 0.5, vx: -0.2, vy: 0.25, phase: 1.5 },
            { color: [200, 140, 210], x: 0.5, y: 0.6, vx: 0.18, vy: -0.22, phase: 3.0 },
            { color: [100, 190, 190], x: 0.3, y: 0.7, vx: 0.3, vy: 0.15, phase: 4.5 },
            { color: [220, 170, 130], x: 0.7, y: 0.4, vx: -0.22, vy: -0.25, phase: 6.0 },
        ];

        const draw = () => {
            this._time += 0.008;
            const w = aurora.width;
            const h = aurora.height;
            const maxDim = Math.max(w, h);

            ctx.fillStyle = '#f0f0f0';
            ctx.fillRect(0, 0, w, h);

            const hovering = this._mouseX >= 0;

            for (const blob of blobs) {
                const t = this._time;
                const cx = (blob.x + Math.sin(t * blob.vx + blob.phase) * 0.4) * w;
                const cy = (blob.y + Math.cos(t * blob.vy + blob.phase * 0.7) * 0.4) * h;
                const r = maxDim * 0.45;

                let boost = 1;
                if (hovering) {
                    const dx = cx / w - this._mouseX;
                    const dy = cy / h - this._mouseY;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    boost = 1 + 2.5 * Math.max(0, 1 - dist / 0.6);
                }

                const a0 = Math.min(1, 0.18 * boost);
                const a1 = Math.min(1, 0.08 * boost);
                const a2 = Math.min(1, 0.02 * boost);

                const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
                grad.addColorStop(0, `rgba(${blob.color[0]}, ${blob.color[1]}, ${blob.color[2]}, ${a0})`);
                grad.addColorStop(0.3, `rgba(${blob.color[0]}, ${blob.color[1]}, ${blob.color[2]}, ${a1})`);
                grad.addColorStop(0.6, `rgba(${blob.color[0]}, ${blob.color[1]}, ${blob.color[2]}, ${a2})`);
                grad.addColorStop(1, `rgba(${blob.color[0]}, ${blob.color[1]}, ${blob.color[2]}, 0)`);
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, w, h);
            }

            this._animId = requestAnimationFrame(draw);
        };

        draw();
    }

    _handleKeydown(e) {
        if (e.key === 'Escape' && this._showLocalHelp) {
            this._closeLocalHelp();
            return;
        }

        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            cheatingDaddy.handleShortcut(isMac ? 'cmd+enter' : 'ctrl+enter');
        }
    }

    // ── Persistence ──

    async _saveMode(mode) {
        this._mode = mode;
        this._tokenError = false;
        this._keyError = false;
        await cheatingDaddy.storage.updatePreference('providerMode', mode);
        this.requestUpdate();
    }

    async _saveToken(val) {
        this._token = val;
        this._tokenError = false;
        try {
            const creds = await cheatingDaddy.storage.getCredentials().catch(() => ({}));
            await cheatingDaddy.storage.setCredentials({ ...creds, cloudToken: val });
        } catch (e) {}
        this.requestUpdate();
    }

    async _saveGeminiKey(val) {
        this._geminiKey = val;
        this._keyError = false;
        await cheatingDaddy.storage.setApiKey(val);
        this.requestUpdate();
    }

    async _saveGeminiLiveModel(val) {
        this._geminiLiveModel = val;
        await cheatingDaddy.storage.updateConfig('geminiLiveModel', val);
        this.requestUpdate();
    }

    async _saveGeminiImageModel(val) {
        this._geminiImageModel = val;
        await cheatingDaddy.storage.updateConfig('geminiImageModel', val);
        this.requestUpdate();
    }

    async _saveNormalResponseProvider(provider) {
        if (this._providerSaving || !['gemini', 'chatgpt'].includes(provider)) return;
        this._providerSaving = true;
        this._chatgptError = '';
        try {
            await cheatingDaddy.storage.updateConfig('normalResponseProvider', provider);
            this._normalResponseProvider = provider;
            this._keyError = false;
            if (provider === 'chatgpt') await this._refreshChatGPTStatus();
        } catch {
            this._chatgptError = 'Could not save the AI provider. Try again.';
        } finally {
            this._providerSaving = false;
        }
    }

    _applyChatGPTStatus(status) {
        if (!status || typeof status !== 'object') return;
        const previous = this._chatgptStatus;
        this._chatgptStatus = {
            connected: status.connected === true,
            planEnabled: status.planEnabled === true,
            connecting: status.connecting === true,
            email: typeof status.email === 'string' ? status.email : '',
            activeAccountId: typeof status.activeAccountId === 'string' ? status.activeAccountId : '',
        };
        if (status.error) this._chatgptError = status.error;
        const identityChanged = previous.activeAccountId !== this._chatgptStatus.activeAccountId || previous.email !== this._chatgptStatus.email;
        if (!this._chatgptStatus.connected || !this._chatgptStatus.planEnabled || identityChanged) {
            this._chatgptModelsGeneration += 1;
            this._chatgptModels = [];
            this._chatgptModelsLoading = false;
            this._chatgptModelsPromise = null;
        }
        if (this._storageLoaded && this._chatgptStatus.connected && this._chatgptStatus.planEnabled) {
            this._showChatGPTPlanNotice = !this._chatgptPlanNoticeDismissed;
            if (identityChanged || !previous.connected || !previous.planEnabled) this._loadChatGPTModels();
        } else if (!this._chatgptStatus.connected) {
            this._showChatGPTPlanNotice = false;
        }
    }

    async _refreshChatGPTStatus() {
        try {
            const status = await this._chatgptIpc.invoke('chatgpt-status');
            if (status?.success === false) throw new Error(status.error || 'ChatGPT is unavailable.');
            this._applyChatGPTStatus(status);
            if (this._chatgptStatus.connected && this._chatgptStatus.planEnabled && !this._chatgptModels.length) {
                await this._loadChatGPTModels();
            }
        } catch (error) {
            this._chatgptError = error.message || 'Could not check the ChatGPT connection. Try again.';
        }
    }

    async _loadChatGPTModels(force = false) {
        if (this._chatgptModelsPromise) return this._chatgptModelsPromise;
        if (!this._chatgptStatus.connected || !this._chatgptStatus.planEnabled) return;
        const generation = ++this._chatgptModelsGeneration;
        this._chatgptModelsLoading = true;
        this._chatgptError = '';
        const operation = async () => {
            try {
                const result = await this._chatgptIpc.invoke('chatgpt-models', { force });
                if (generation !== this._chatgptModelsGeneration) return;
                if (!result?.success) throw new Error(result?.error || 'Could not load ChatGPT models.');
                this._chatgptModels = (Array.isArray(result.models) ? result.models : []).filter(
                    model => typeof model.id === 'string' && typeof model.name === 'string'
                );
                const selected = this._chatgptModels.find(model => model.id === (result.selectedModel || this._chatgptModel));
                this._chatgptModel = selected?.id || '';
                if (!selected) this._chatgptError = 'No ChatGPT models are available for this account. Manage usage or try another account.';
                if (this._chatgptReasoningMode === 'pro' && !selected?.supportsPro) {
                    this._chatgptReasoningMode = 'standard';
                    await cheatingDaddy.storage.updateConfig('chatgptReasoningMode', 'standard');
                }
            } catch (error) {
                if (generation === this._chatgptModelsGeneration) this._chatgptError = error.message || 'Could not load ChatGPT models.';
            } finally {
                if (generation === this._chatgptModelsGeneration) {
                    this._chatgptModelsLoading = false;
                    this._chatgptModelsPromise = null;
                }
            }
        };
        this._chatgptModelsPromise = operation();
        return this._chatgptModelsPromise;
    }

    async _signInChatGPT(newAccount = false) {
        if (this._chatgptBusy || this._chatgptStatus.connecting) return;
        this._chatgptBusy = true;
        this._chatgptError = '';
        try {
            const result = await this._chatgptIpc.invoke('chatgpt-sign-in', { newAccount });
            if (!result?.success) throw new Error(result?.error || 'ChatGPT sign-in did not finish. Try again.');
            await this._refreshChatGPTStatus();
        } catch (error) {
            this._chatgptError = error.message || 'ChatGPT sign-in did not finish. Try again.';
        } finally {
            this._chatgptBusy = false;
        }
    }

    async _signOutChatGPT() {
        if (this._chatgptBusy) return;
        this._chatgptBusy = true;
        this._chatgptError = '';
        try {
            const result = await this._chatgptIpc.invoke('chatgpt-sign-out');
            if (!result?.success) throw new Error(result?.error || 'Could not sign out. Try again.');
            this._applyChatGPTStatus({ connected: false });
            if (result.warning) this._chatgptError = result.warning;
        } catch (error) {
            this._chatgptError = error.message || 'Could not sign out. Try again.';
        } finally {
            this._chatgptBusy = false;
        }
    }

    async _saveChatGPTModel(id) {
        const model = this._chatgptModels.find(item => item.id === id);
        if (!model || this._providerSaving || this._chatgptModelsLoading) return;
        this._providerSaving = true;
        this._chatgptError = '';
        try {
            if (!model.supportsPro && this._chatgptReasoningMode === 'pro') {
                await cheatingDaddy.storage.updateConfig('chatgptReasoningMode', 'standard');
                this._chatgptReasoningMode = 'standard';
            }
            await cheatingDaddy.storage.updateConfig('chatgptModel', id);
            this._chatgptModel = id;
        } catch {
            this._chatgptError = 'Could not save the ChatGPT model. Try again.';
        } finally {
            this._providerSaving = false;
        }
    }

    async _saveChatGPTReasoningMode(mode) {
        if (this._providerSaving || !['standard', 'pro'].includes(mode)) return;
        const model = this._chatgptModels.find(item => item.id === this._chatgptModel);
        if (mode === 'pro' && !model?.supportsPro) return;
        this._providerSaving = true;
        this._chatgptError = '';
        try {
            await cheatingDaddy.storage.updateConfig('chatgptReasoningMode', mode);
            this._chatgptReasoningMode = mode;
        } catch {
            this._chatgptError = 'Could not save the response mode. Try again.';
        } finally {
            this._providerSaving = false;
        }
    }

    async _saveChatGPTUseTranscription(enabled) {
        if (this._providerSaving) return;
        this._providerSaving = true;
        this._chatgptError = '';
        try {
            await cheatingDaddy.storage.updateConfig('chatgptUseTranscription', enabled === true);
            this._chatgptUseTranscription = enabled === true;
        } catch {
            this._chatgptError = 'Could not save the transcription setting. Try again.';
        } finally {
            this._providerSaving = false;
        }
    }

    async _dismissChatGPTPlanNotice() {
        try {
            await cheatingDaddy.storage.updateConfig('chatgptPlanNoticeDismissed', true);
            this._chatgptPlanNoticeDismissed = true;
            this._showChatGPTPlanNotice = false;
        } catch {
            this._chatgptError = 'Could not save this setting. Try again.';
            this._showChatGPTPlanNotice = false;
        }
    }

    async _saveOpenaiKey(val) {
        this._openaiKey = val;
        try {
            const creds = await cheatingDaddy.storage.getCredentials().catch(() => ({}));
            await cheatingDaddy.storage.setCredentials({ ...creds, openaiKey: val });
        } catch (e) {}
        this.requestUpdate();
    }

    async _saveLocalLlmModel(val) {
        this._localLlmModel = val;
        await cheatingDaddy.storage.updatePreference('localLlmModel', val);
        this.requestUpdate();
    }

    async _selectLocalLlmModel(value) {
        if (value === 'custom') {
            this._useCustomLocalLlmModel = true;
            this.requestUpdate();
            return;
        }

        this._useCustomLocalLlmModel = false;
        await this._saveLocalLlmModel(value);
    }

    async _saveWhisperModel(val) {
        this._whisperModel = val;
        await cheatingDaddy.storage.updatePreference('whisperModel', val);
        this.requestUpdate();
    }

    _handleProfileChange(e) {
        this.onProfileChange(e.target.value);
    }

    _openLocalHelp() {
        this._showLocalHelp = true;
    }

    _closeLocalHelp() {
        this._showLocalHelp = false;
    }

    _handleHelpDialogClick(e) {
        e.stopPropagation();
    }

    // ── Start ──

    _handleStart() {
        if (this.isInitializing || this.downloadProgress.active || this._providerSaving) return;

        if (this._mode === 'byok' && this._normalResponseProvider === 'chatgpt') {
            if (this._chatgptBusy || this._chatgptStatus.connecting || this._chatgptModelsLoading) return;
            if (!this._chatgptStatus.connected || !this._chatgptStatus.planEnabled) {
                this._chatgptError = 'Continue with ChatGPT and allow plan usage before starting.';
                return;
            }
            if (!this._chatgptModels.some(model => model.id === this._chatgptModel)) {
                this._chatgptError = 'Refresh models and choose an available ChatGPT model.';
                return;
            }
            if (this._chatgptUseTranscription && !this._geminiKey.trim()) {
                this._keyError = true;
                this._chatgptError = 'Add a Gemini API key for voice transcription, or turn off Gemini voice transcription.';
                return;
            }
        } else if (this._mode === 'byok') {
            if (!this._geminiKey.trim()) {
                this._keyError = true;
                this.requestUpdate();
                return;
            }
        } else if (this._mode === 'local') {
            if (!this._localLlmModel.trim()) {
                return;
            }
        }

        this.onStart();
    }

    _handleStartReview() {
        if (this.isInitializing || this.downloadProgress.active) return;
        this.onStartReview();
    }

    triggerApiKeyError() {
        this._keyError = this._mode !== 'local';
        this.requestUpdate();
        setTimeout(() => {
            this._tokenError = false;
            this._keyError = false;
            this.requestUpdate();
        }, 2000);
    }

    // ── Render helpers ──

    _renderStartButton() {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const isDownloading = this._mode === 'local' && this.downloadProgress.active;
        const normalBusy =
            this.isInitializing ||
            isDownloading ||
            this._providerSaving ||
            (this._mode === 'byok' &&
                this._normalResponseProvider === 'chatgpt' &&
                (this._chatgptBusy || this._chatgptStatus.connecting || this._chatgptModelsLoading));
        const percentage = this.downloadProgress.percentage;
        const hasPercentage = Number.isFinite(percentage);

        const cmdIcon = html`<svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <path
                d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"
            />
        </svg>`;
        const ctrlIcon = html`<svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <path d="M6 15l6-6 6 6" />
        </svg>`;
        const enterIcon = html`<svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <path d="M9 10l-5 5 5 5" />
            <path d="M20 4v7a4 4 0 0 1-4 4H4" />
        </svg>`;

        return html`
            <button class="start-button ${normalBusy ? 'disabled' : ''}" ?disabled=${normalBusy} @click=${() => this._handleStart()}>
                <canvas class="btn-aurora"></canvas>
                <canvas class="btn-dither"></canvas>
                ${
                    isDownloading
                        ? html`<span
                              class="download-progress-fill ${hasPercentage ? '' : 'indeterminate'}"
                              style=${hasPercentage ? `width: ${percentage}%` : ''}
                          ></span>`
                        : ''
                }
                <span class="btn-label">
                    ${isDownloading ? (hasPercentage ? `${percentage}%` : 'Preparing...') : 'Start Session'}
                    ${isDownloading ? '' : html`<span class="shortcut-hint">${isMac ? cmdIcon : ctrlIcon}${enterIcon}</span>`}
                </span>
            </button>
            <button
                class="start-button ${this.isInitializing || isDownloading ? 'disabled' : ''}"
                ?disabled=${this.isInitializing || isDownloading}
                @click=${() => this._handleStartReview()}
            >
                <span class="btn-label">Start Test Review</span>
            </button>
            <div class="form-hint">
                Circle the answer on your practice test. ${isMac ? '⌘' : 'Ctrl'} + Enter checks a new question; ${isMac ? '⌘' : 'Ctrl'} + Shift + \\
                toggles the marks; ${isMac ? '⌘' : 'Ctrl'} + \\ shows or hides the app window.
            </div>
            ${
                isDownloading
                    ? html`
                          <div class="download-controls">
                              <span>Downloading: ${this.downloadProgress.label || 'Local AI files'}</span>
                              <button class="download-cancel" @click=${() => this.onCancelDownload()}>Cancel</button>
                          </div>
                      `
                    : ''
            }
        `;
    }

    _renderDivider() {
        return html`
            <div class="divider">
                <div class="divider-line"></div>
                <span class="divider-text">or</span>
                <div class="divider-line"></div>
            </div>
        `;
    }

    // ── Cloud mode ──
    // Cloud UI intentionally disabled. Backend cloud wiring is still present in
    // the codebase, but the renderer no longer exposes this setup path.

    // ── BYOK mode ──

    _renderConfigChevron() {
        return html`
            <svg class="config-chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="m5 7.5 5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
        `;
    }

    _renderByokMode() {
        return html`
            <details class="config-section">
                <summary class="config-summary">
                    <span class="config-summary-text">
                        <span class="config-summary-title">Transcription</span>
                        <span class="config-summary-description">Gemini Live connection</span>
                    </span>
                    ${this._renderConfigChevron()}
                </summary>
                <div class="config-content">
                    <div class="form-group">
                        <label class="form-label" for="gemini-key">Gemini API Key</label>
                        <input
                            id="gemini-key"
                            type="password"
                            placeholder=${this._normalResponseProvider === 'chatgpt' ? 'Optional for voice' : 'Required'}
                            .value=${this._geminiKey}
                            @input=${e => this._saveGeminiKey(e.target.value)}
                            class=${this._keyError ? 'error' : ''}
                        />
                        <div class="form-hint">
                            <span class="link" @click=${() => this.onExternalLink('https://aistudio.google.com/apikey')}>Get Gemini key</span>
                            · Used for voice transcription and Test Review.
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="gemini-live-model">Gemini Live Model</label>
                        <input
                            id="gemini-live-model"
                            type="text"
                            .value=${this._geminiLiveModel}
                            @input=${e => this._saveGeminiLiveModel(e.target.value)}
                        />
                        <div class="form-hint">Use auto to choose an available Live model, or enter a model ID.</div>
                    </div>
                </div>
            </details>

            <details class="config-section">
                <summary class="config-summary">
                    <span class="config-summary-text">
                        <span class="config-summary-title">AI responses</span>
                        <span class="config-summary-description">Gemini API model</span>
                    </span>
                    ${this._renderConfigChevron()}
                </summary>
                <div class="config-content">
                    <div class="form-group">
                        <label class="form-label" for="gemini-image-model">Gemini Screenshot Model</label>
                        <input
                            id="gemini-image-model"
                            type="text"
                            .value=${this._geminiImageModel}
                            @input=${e => this._saveGeminiImageModel(e.target.value)}
                        />
                        <div class="form-hint">Use auto to choose an available screenshot model, or enter a model ID.</div>
                    </div>
                </div>
            </details>

            ${this._renderChatGPTAccount()}
            <div class="form-group">
                <label class="form-label" for="normal-response-provider">AI for Start Session</label>
                <select
                    id="normal-response-provider"
                    .value=${this._normalResponseProvider}
                    ?disabled=${this.isInitializing || this._providerSaving}
                    @change=${event => this._saveNormalResponseProvider(event.target.value)}
                >
                    <option value="gemini">Gemini API</option>
                    <option value="chatgpt">ChatGPT account</option>
                </select>
                <div class="form-hint">
                    ${
                        this._normalResponseProvider === 'chatgpt'
                            ? 'Screenshots and text work directly with ChatGPT. Enable Gemini voice transcription to also use speech.'
                            : 'Gemini answers screenshots and transcribes speech.'
                    }
                    Test Review keeps its existing provider settings.
                </div>
            </div>
            ${this._chatgptError ? html`<div class="form-hint" role="alert">${this._chatgptError}</div>` : ''} ${this._renderStartButton()}
            ${this._renderDivider()}
            <div class="mode-links">
                <button class="mode-link" @click=${() => this._saveMode('local')}>Use local AI</button>
            </div>
        `;
    }

    _renderChatGPTAccount() {
        const status = this._chatgptStatus;
        const busy = this._chatgptBusy || status.connecting;
        const selected = this._chatgptModels.find(model => model.id === this._chatgptModel);
        return html`
            <details class="config-section" ?open=${this._normalResponseProvider === 'chatgpt'}>
                <summary class="config-summary">
                    <span class="config-summary-text">
                        <span class="config-summary-title">ChatGPT account</span>
                        <span class="config-summary-description">
                            ${status.connecting ? 'Waiting for sign-in…' : status.connected ? status.email || 'Connected' : 'Sign in with your ChatGPT plan'}
                        </span>
                    </span>
                    ${this._renderConfigChevron()}
                </summary>
                <div class="config-content">
                    ${
                        !status.connected || !status.planEnabled
                            ? html`
                                  <button class="chatgpt-sign-in" ?disabled=${busy || this.isInitializing} @click=${() => this._signInChatGPT()}>
                                      ${busy ? 'Waiting for sign-in…' : 'Continue with ChatGPT'}
                                  </button>
                                  <div class="form-hint">
                                      Sign in in your browser; choose Continue with Google there to use Gmail. Eligible requests use your ChatGPT plan
                                      or credits. An eligible Plus or Pro plan is required.
                                  </div>
                                  ${status.connected ? html`<div class="config-note">Connected. Continue with ChatGPT to allow plan usage.</div>` : ''}
                              `
                            : html`
                                  <div class="form-hint">Using ChatGPT plan · ${status.email || 'Connected account'}</div>
                                  <div class="form-group">
                                      <label class="form-label" for="chatgpt-model">ChatGPT model</label>
                                      <select
                                          id="chatgpt-model"
                                          .value=${this._chatgptModel}
                                          ?disabled=${this._chatgptModelsLoading || this._providerSaving || this.isInitializing || !this._chatgptModels.length}
                                          @change=${event => this._saveChatGPTModel(event.target.value)}
                                      >
                                          ${!this._chatgptModels.length ? html`<option value="">${this._chatgptModelsLoading ? 'Loading models…' : 'Refresh to load models'}</option>` : ''}
                                          ${this._chatgptModels.map(model => html`<option value=${model.id}>${model.name}</option>`)}
                                      </select>
                                      <div class="form-hint">
                                          Models available to your account are shown. GPT-5.6 Instant is preferred when available; otherwise a listed
                                          fast model is selected.
                                      </div>
                                  </div>
                                  ${
                                      selected?.supportsPro
                                          ? html`
                                                <div class="form-group">
                                                    <label class="form-label" for="chatgpt-reasoning-mode">Response mode</label>
                                                    <select
                                                        id="chatgpt-reasoning-mode"
                                                        .value=${this._chatgptReasoningMode}
                                                        ?disabled=${this._providerSaving || this.isInitializing || this._chatgptModelsLoading}
                                                        @change=${event => this._saveChatGPTReasoningMode(event.target.value)}
                                                    >
                                                        <option value="standard">Standard — faster</option>
                                                        <option value="pro">Pro — deeper reasoning, slower</option>
                                                    </select>
                                                </div>
                                            `
                                          : ''
                                  }
                                  <div class="form-hint">
                                      Replies stream as they arrive. Speed depends on the model, connection, and current usage limits.
                                  </div>
                              `
                    }
                    <label class="config-checkbox">
                        <input
                            type="checkbox"
                            .checked=${this._chatgptUseTranscription}
                            ?disabled=${this._providerSaving || this.isInitializing}
                            @change=${event => this._saveChatGPTUseTranscription(event.target.checked)}
                        />
                        <span class="config-checkbox-text">
                            <span class="config-summary-title">Use Gemini for voice transcription</span>
                            <span class="config-summary-description">Requires a Gemini API key above and uses Gemini quota for speech.</span>
                        </span>
                    </label>
                    <div class="account-actions">
                        ${
                            status.connected && status.planEnabled
                                ? html`
                                      <button
                                          class="mode-link"
                                          ?disabled=${this._chatgptModelsLoading || busy || this._providerSaving}
                                          @click=${() => this._loadChatGPTModels(true)}
                                      >
                                          ${this._chatgptModelsLoading ? 'Loading…' : 'Refresh models'}
                                      </button>
                                  `
                                : ''
                        }
                        <button class="mode-link" @click=${() => this.onExternalLink('https://chatgpt.com/settings/usage')}>Manage usage</button>
                        ${
                            status.connected
                                ? html`<button class="mode-link" ?disabled=${busy || this.isInitializing} @click=${() => this._signInChatGPT(true)}>
                                      Use another account
                                  </button>`
                                : ''
                        }
                        ${
                            status.connected
                                ? html`<button class="mode-link" ?disabled=${busy || this.isInitializing} @click=${() => this._signOutChatGPT()}>
                                      Sign out
                                  </button>`
                                : ''
                        }
                    </div>
                </div>
            </details>
        `;
    }

    _renderChatGPTPlanNotice() {
        return html`
            <div class="help-dialog-backdrop">
                <section class="help-dialog" role="dialog" aria-modal="true" aria-labelledby="chatgpt-plan-title">
                    <div class="help-dialog-header"><div class="help-dialog-title" id="chatgpt-plan-title">You’re using your ChatGPT plan</div></div>
                    <div class="help-content">
                        <div class="help-section-text">
                            Eligible AI requests in Honest Father use your ChatGPT plan. Manage usage in your ChatGPT settings.
                        </div>
                        <button class="mode-link" @click=${() => this.onExternalLink('https://chatgpt.com/settings/usage')}>Manage usage</button>
                        <button class="help-cloud-btn" autofocus @click=${() => this._dismissChatGPTPlanNotice()}>Got it</button>
                    </div>
                </section>
            </div>
        `;
    }

    // ── Local AI mode ──

    _renderLocalMode() {
        return html`
            <details class="config-section">
                <summary class="config-summary">
                    <span class="config-summary-text">
                        <span class="config-summary-title">Language model</span>
                        <span class="config-summary-description">Local GGUF model</span>
                    </span>
                    ${this._renderConfigChevron()}
                </summary>
                <div class="config-content">
                    <div class="form-group">
                        <label class="form-label">Model</label>
                        <select
                            .value=${this._useCustomLocalLlmModel ? 'custom' : this._localLlmModel}
                            @change=${event => this._selectLocalLlmModel(event.target.value)}
                        >
                            ${LOCAL_LLM_PRESETS.map(preset => html`<option value=${preset.value}>${preset.label}</option>`)}
                            <option value="custom">Custom Hugging Face model or local GGUF…</option>
                        </select>
                        ${
                            this._useCustomLocalLlmModel
                                ? html`
                                      <input
                                          type="text"
                                          placeholder="owner/repository:quant or /absolute/model.gguf"
                                          .value=${this._localLlmModel}
                                          @input=${event => this._saveLocalLlmModel(event.target.value)}
                                      />
                                  `
                                : ''
                        }
                        <div class="form-hint">Sizes include the vision model. Q4 uses less memory; Q8 preserves more quality.</div>
                    </div>
                </div>
            </details>

            <details class="config-section">
                <summary class="config-summary">
                    <span class="config-summary-text">
                        <span class="config-summary-title">Transcription</span>
                        <span class="config-summary-description">Whisper speech-to-text model</span>
                    </span>
                    ${this._renderConfigChevron()}
                </summary>
                <div class="config-content">
                    <div class="form-group">
                        <div class="whisper-label-row">
                            <label class="form-label">Whisper Model</label>
                            ${this.whisperDownloading ? html`<div class="whisper-spinner"></div>` : ''}
                        </div>
                        <select .value=${this._whisperModel} @change=${e => this._saveWhisperModel(e.target.value)}>
                            <option value="tiny.en" ?selected=${this._whisperModel === 'tiny.en'}>Tiny English (75 MB, fastest)</option>
                            <option value="base.en" ?selected=${this._whisperModel === 'base.en'}>Base English (142 MB)</option>
                            <option value="small.en" ?selected=${this._whisperModel === 'small.en'}>Small English (466 MB, most accurate)</option>
                        </select>
                        <div class="form-hint">${this.whisperDownloading ? 'Downloading model...' : 'Downloaded automatically on first use'}</div>
                    </div>
                </div>
            </details>

            ${this._renderStartButton()} ${this._renderDivider()}

            <!-- Cloud promo intentionally removed from the active UI. -->

            <div class="mode-links">
                <button class="mode-link" @click=${() => this._saveMode('byok')}>Use Gemini or ChatGPT</button>
            </div>
        `;
    }

    // ── Main render ──

    render() {
        const helpIcon = html`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
            <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                <path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0m9 5v.01" />
                <path d="M12 13.5a1.5 1.5 0 0 1 1-1.5a2.6 2.6 0 1 0-3-4" />
            </g>
        </svg>`;
        const closeIcon = html`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
            <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 6L6 18M6 6l12 12" />
        </svg>`;

        return html`
            <div class="form-wrapper">
                ${
                    this._mode === 'local'
                        ? html`
                              <div class="title-row">
                                  <div class="page-title">Honest Father <span class="mode-suffix">Local AI</span></div>
                                  <button class="help-btn" @click=${this._openLocalHelp} aria-label="Open Local AI help">${helpIcon}</button>
                              </div>
                          `
                        : html` <div class="page-title">${html`Honest Father <span class="mode-suffix">ANAYSSA</span>`}</div> `
                }
                <div class="page-subtitle">
                    ${this._mode === 'byok' ? 'Use Gemini API or your ChatGPT account' : 'Run models locally on your machine'}
                </div>

                ${this.statusText ? html`<div class="form-hint" role="status">${this.statusText}</div>` : ''}
                <!-- Cloud mode render branch intentionally disabled. -->
                ${this._mode === 'byok' ? this._renderByokMode() : ''} ${this._mode === 'local' ? this._renderLocalMode() : ''}
            </div>
            ${this._mode === 'local' && this._showLocalHelp ? this._renderLocalHelp(closeIcon) : ''}
            ${this._showChatGPTPlanNotice ? this._renderChatGPTPlanNotice() : ''}
        `;
    }

    _renderLocalHelp(closeIcon) {
        return html`
            <div class="help-dialog-backdrop" @click=${this._closeLocalHelp}>
                <section class="help-dialog" role="dialog" aria-modal="true" aria-labelledby="local-help-title" @click=${this._handleHelpDialogClick}>
                    <div class="help-dialog-header">
                        <div id="local-help-title" class="help-dialog-title">Local AI setup</div>
                        <button class="help-btn" @click=${this._closeLocalHelp} aria-label="Close Local AI help">${closeIcon}</button>
                    </div>

                    <div class="help-content">
                        <div class="help-section">
                            <div class="help-section-title">Native local AI</div>
                            <div class="help-section-text">
                                Honest Father runs llama.cpp and whisper.cpp directly. Everything stays on your computer — no external AI service or
                                Ollama installation is required.
                            </div>
                        </div>

                        <div class="help-section">
                            <div class="help-section-title">Automatic setup</div>
                            <div class="help-section-text">
                                The correct native runners, selected Whisper model, and language model are downloaded and checksum-verified on first
                                use. They are stored in the Honest Father config directory.
                            </div>
                        </div>

                        <div class="help-section">
                            <div class="help-section-title">Default model</div>
                            <div class="help-models">
                                <div class="help-model">
                                    <span class="help-model-name">Qwen3.5 4B Q4_K_M</span><span>About 2.7 GB — balanced local quality and speed</span>
                                </div>
                            </div>
                        </div>

                        <div class="help-section">
                            <div class="help-section-title">Whisper</div>
                            <div class="help-section-text">
                                The selected whisper.cpp model is downloaded automatically once and kept in the config directory.
                            </div>
                        </div>

                        <hr class="help-divider" />

                        <div class="help-section">
                            <div class="help-section-title">Computer hanging or slow?</div>
                            <div class="help-section-text">
                                Running models locally uses a lot of RAM and CPU. If your computer slows down or freezes, it's likely the LLM. Switch
                                back to BYOK mode if you want to use a hosted provider instead.
                            </div>
                        </div>

                        <button
                            class="help-cloud-btn"
                            @click=${() => {
                                this._closeLocalHelp();
                                this._saveMode('byok');
                            }}
                        >
                            Use Gemini or ChatGPT
                        </button>
                    </div>
                </section>
            </div>
        `;
    }
}

customElements.define('main-view', MainView);
