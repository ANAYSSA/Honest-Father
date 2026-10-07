import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';

const { DEFAULT_TEST_VISIBILITY, ANSWER_PLACEMENT_LIMITS, normalizeTestVisibility, validateTestVisibilityUpdate, isAnswerPlacement } =
    window.require('./utils/testVisibility');
const { ipcRenderer } = window.require('electron');

export class TestVisibilityView extends LitElement {
    static properties = {
        preferences: { type: Object },
        _loaded: { state: true },
        _saving: { state: true },
        _error: { state: true },
        _displays: { state: true },
        _placementFallback: { state: true },
        _displayError: { state: true },
    };

    static styles = [
        unifiedPageStyles,
        css`
            .toggle-row,
            .slider-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-md);
            }
            .toggle-row {
                cursor: pointer;
                color: var(--text-primary);
                font-size: var(--font-size-sm);
            }
            .toggle-row input {
                width: 16px;
                height: 16px;
                accent-color: var(--text-primary);
                cursor: pointer;
            }
            .slider-header {
                margin-bottom: var(--space-sm);
            }
            .opacity-slider {
                width: 100%;
                accent-color: var(--text-primary);
                cursor: pointer;
            }
            .form-row {
                gap: var(--space-md);
            }
            .preview {
                position: relative;
                min-height: 140px;
                padding: var(--space-md);
                background: repeating-conic-gradient(var(--bg-elevated) 0% 25%, var(--bg-app) 0% 50%) 0 / 20px 20px;
                border-radius: var(--radius-sm);
                overflow: hidden;
            }
            .preview-frame {
                position: relative;
                padding: var(--space-md);
            }
            .preview-frame::before {
                content: '';
                position: absolute;
                inset: 0;
                pointer-events: none;
                background: var(--bg-surface);
                border: 1px solid var(--border-strong);
                border-radius: var(--radius-md);
                opacity: var(--preview-frame-opacity);
            }
            .preview-answer {
                position: relative;
                color: var(--preview-answer-color, var(--text-primary));
                opacity: var(--preview-text-opacity);
                line-height: 1.6;
            }
            .preview-answer strong {
                font-weight: 800;
            }
            .preview-status {
                position: relative;
                color: var(--text-muted);
                font-size: var(--font-size-xs);
                margin-bottom: var(--space-sm);
            }
            .preview-controls {
                margin-top: var(--space-sm);
                margin-bottom: 0;
            }
            .save-status {
                min-height: 1.4em;
                font-size: var(--font-size-xs);
                color: var(--text-muted);
            }
            .save-error {
                color: var(--danger);
            }
            input:focus-visible,
            button:focus-visible {
                outline: 2px solid var(--accent);
                outline-offset: 3px;
            }
            .color-row,
            .placement-tools,
            .size-row {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
                flex-wrap: wrap;
            }
            .color-row input[type='color'] {
                width: 48px;
                height: 36px;
                padding: 3px;
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: var(--bg-elevated);
                cursor: pointer;
            }
            .compact-button {
                width: auto;
                cursor: pointer;
            }
            .position-layout {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                align-items: center;
                gap: var(--space-md);
            }
            .screen-map {
                display: block;
                position: relative;
                width: 100%;
                padding: 0;
                overflow: hidden;
                background: var(--bg-app);
                border: 1px solid var(--border-strong);
                border-radius: var(--radius-sm);
                cursor: crosshair;
            }
            .screen-map:disabled {
                cursor: default;
            }
            .screen-answer {
                position: absolute;
                display: flex;
                align-items: center;
                justify-content: center;
                border: 1px solid var(--accent);
                border-radius: 4px;
                color: var(--text-primary);
                background: var(--bg-elevated);
                font-size: var(--font-size-xs);
                min-height: 8px;
                pointer-events: none;
                overflow: hidden;
            }
            .anchor-grid {
                display: grid;
                grid-template-columns: repeat(3, 32px);
                gap: 4px;
            }
            .anchor-grid button {
                width: 32px;
                height: 32px;
                padding: 0;
                cursor: pointer;
            }
            .anchor-grid button[aria-pressed='true'] {
                border-color: var(--accent);
                box-shadow: 0 0 0 1px var(--accent);
            }
            .size-row label {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
            }
            .size-row input {
                width: 96px;
            }
            .placement-tools select {
                flex: 1;
                min-width: 180px;
            }
        `,
    ];

    constructor() {
        super();
        this.preferences = { ...DEFAULT_TEST_VISIBILITY };
        this._savedPreferences = { ...DEFAULT_TEST_VISIBILITY };
        this._loaded = false;
        this._saving = 0;
        this._error = '';
        this._saveQueue = Promise.resolve();
        this._displays = [];
        this._placementFallback = { displayId: 'primary', x: 50, y: 50, width: 700, height: 320 };
        this._displayError = '';
        this._onDisplaysChanged = () => this._loadDisplays();
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this._loaded) this._loadPreferences();
        ipcRenderer.on('answer-displays-changed', this._onDisplaysChanged);
        this._loadDisplays();
    }

    disconnectedCallback() {
        ipcRenderer.removeListener('answer-displays-changed', this._onDisplaysChanged);
        super.disconnectedCallback();
    }

    async _loadDisplays() {
        try {
            const result = await ipcRenderer.invoke('get-answer-displays');
            if (!result?.success || !Array.isArray(result.displays) || !result.displays.length) {
                throw new Error('Could not read connected displays.');
            }
            this._displays = result.displays;
            this._primaryDisplayId = result.primaryDisplayId;
            if (result.placement && isAnswerPlacement(result.placement)) this._placementFallback = { ...result.placement };
            else this._placementFallback = { ...this._placementFallback, displayId: result.primaryDisplayId };
            this._displayError = '';
        } catch {
            this._displayError = 'Display preview is unavailable. Reopen these settings to try again.';
        }
    }

    async _loadPreferences() {
        try {
            const preferences = normalizeTestVisibility(await cheatingDaddy.storage.getPreferences());
            this.preferences = preferences;
            this._savedPreferences = { ...preferences };
            this._loaded = true;
        } catch {
            this._error = 'Could not load visibility settings. Reopen this page to try again.';
        }
    }

    previewOpacity(key, value) {
        const update = { [key]: value };
        try {
            validateTestVisibilityUpdate(update);
            this.preferences = { ...normalizeTestVisibility(this.preferences), ...update };
        } catch {
            // Invalid range input must never become a CSS value.
        }
    }

    savePreference(key, value) {
        const update = { [key]: value };
        try {
            validateTestVisibilityUpdate(update);
        } catch (error) {
            this._error = error.message;
            return Promise.resolve(false);
        }
        this.preferences = { ...normalizeTestVisibility(this.preferences), ...update };
        this._saving++;
        this._error = '';
        // Serialize updates so a slow earlier disk write cannot undo a later slider change.
        const pending = this._saveQueue.then(async () => {
            try {
                const result = await cheatingDaddy.storage.setPreferences(update);
                if (!result?.success) throw new Error(result?.error || 'Could not save visibility settings.');
                this._savedPreferences = { ...this._savedPreferences, ...update };
                this.dispatchEvent(
                    new CustomEvent('test-visibility-changed', {
                        detail: { ...this._savedPreferences },
                        bubbles: true,
                        composed: true,
                    })
                );
                return true;
            } catch (error) {
                this._error = error.message || 'Could not save visibility settings.';
                if (this.preferences[key] === value) this.preferences = { ...this.preferences, [key]: this._savedPreferences[key] };
                return false;
            } finally {
                this._saving--;
            }
        });
        this._saveQueue = pending;
        return pending;
    }

    getPlacement() {
        const placement = normalizeTestVisibility(this.preferences).answerPlacement || this._placementFallback;
        const display =
            this._displays.find(item => item.id === placement.displayId) ||
            this._displays.find(item => item.id === this._placementFallback.displayId) ||
            this._displays.find(item => item.id === this._primaryDisplayId) ||
            this._displays[0];
        return { ...placement, displayId: display?.id || placement.displayId };
    }

    savePlacement(update) {
        return this.savePreference('answerPlacement', { ...this.getPlacement(), ...update });
    }

    selectPosition(event) {
        if (!this._loaded || !this._displays.length || event.detail === 0) return;
        const placement = this.getPlacement();
        const display = this._displays.find(item => item.id === placement.displayId);
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const widthRatio = Math.min(1, placement.width / display.workArea.width);
        const heightRatio = Math.min(1, placement.height / display.workArea.height);
        const clamp = value => Math.round(Math.max(0, Math.min(100, value)));
        const x = widthRatio < 1 ? clamp((((event.clientX - rect.left) / rect.width - widthRatio / 2) / (1 - widthRatio)) * 100) : 50;
        const y = heightRatio < 1 ? clamp((((event.clientY - rect.top) / rect.height - heightRatio / 2) / (1 - heightRatio)) * 100) : 50;
        return this.savePlacement({ x, y });
    }

    movePreview(event) {
        const offsets = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] };
        const offset = offsets[event.key];
        if (!offset || !this._loaded || !this._displays.length) return;
        event.preventDefault();
        const placement = this.getPlacement();
        return this.savePlacement({
            x: Math.max(0, Math.min(100, placement.x + offset[0])),
            y: Math.max(0, Math.min(100, placement.y + offset[1])),
        });
    }

    renderPlacement() {
        const placement = this.getPlacement();
        const display = this._displays.find(item => item.id === placement.displayId);
        const width = display ? Math.min(100, (placement.width / display.workArea.width) * 100) : 50;
        const height = display ? Math.min(100, (placement.height / display.workArea.height) * 100) : 40;
        const anchors = [
            [0, 0, '↖', 'Top left'],
            [50, 0, '↑', 'Top center'],
            [100, 0, '↗', 'Top right'],
            [0, 50, '←', 'Center left'],
            [50, 50, '•', 'Center'],
            [100, 50, '→', 'Center right'],
            [0, 100, '↙', 'Bottom left'],
            [50, 100, '↓', 'Bottom center'],
            [100, 100, '↘', 'Bottom right'],
        ];
        return html`
            <section class="surface form-row">
                <div class="surface-title">Answer position on screen</div>
                <div class="form-help">Choose where the answer will appear before starting. Click the screen preview or choose a position.</div>
                <div class="placement-tools">
                    <label class="form-label" for="answerDisplay">Display</label>
                    <select
                        id="answerDisplay"
                        class="control"
                        .value=${placement.displayId}
                        ?disabled=${!this._loaded || !this._displays.length}
                        @change=${event => this.savePlacement({ displayId: event.target.value })}
                    >
                        ${this._displays.map(item => html`<option value=${item.id}>${item.label} · ${item.workArea.width} × ${item.workArea.height}</option>`)}
                    </select>
                </div>
                <div class="position-layout">
                    <button
                        class="screen-map"
                        type="button"
                        style=${`aspect-ratio: ${display ? display.workArea.width / display.workArea.height : 16 / 9}; max-width: ${Math.round(240 * (display ? display.workArea.width / display.workArea.height : 16 / 9))}px;`}
                        aria-label="Answer position preview. Click to position the answer, or use the arrow keys."
                        ?disabled=${!this._loaded || !display}
                        @click=${this.selectPosition}
                        @keydown=${this.movePreview}
                    >
                        <span
                            class="screen-answer"
                            style=${`width: ${width}%; height: ${height}%; left: ${((100 - width) * placement.x) / 100}%; top: ${((100 - height) * placement.y) / 100}%;`}
                            >Answer</span
                        >
                    </button>
                    <div class="anchor-grid" aria-label="Answer position presets">
                        ${anchors.map(
                            ([x, y, symbol, label]) => html`
                                <button
                                    class="control"
                                    type="button"
                                    title=${label}
                                    aria-label=${label}
                                    aria-pressed=${String(placement.x === x && placement.y === y)}
                                    ?disabled=${!this._loaded || !display}
                                    @click=${() => this.savePlacement({ x, y })}
                                >
                                    ${symbol}
                                </button>
                            `
                        )}
                    </div>
                </div>
                <div class="size-row">
                    <label class="form-label" for="answerWidth"
                        >Width
                        <input
                            id="answerWidth"
                            class="control"
                            type="number"
                            min=${ANSWER_PLACEMENT_LIMITS.minWidth}
                            max=${ANSWER_PLACEMENT_LIMITS.maxWidth}
                            step="10"
                            .value=${String(placement.width)}
                            ?disabled=${!this._loaded || !display}
                            @change=${event => this.savePlacement({ width: Number(event.target.value) })}
                        />
                    </label>
                    <label class="form-label" for="answerHeight"
                        >Height
                        <input
                            id="answerHeight"
                            class="control"
                            type="number"
                            min=${ANSWER_PLACEMENT_LIMITS.minHeight}
                            max=${ANSWER_PLACEMENT_LIMITS.maxHeight}
                            step="10"
                            .value=${String(placement.height)}
                            ?disabled=${!this._loaded || !display}
                            @change=${event => this.savePlacement({ height: Number(event.target.value) })}
                        />
                    </label>
                    <span class="form-help">Screen points · fitted to your display</span>
                </div>
                <div class="form-help">
                    Position is saved for the next session. During a session, use Option + arrow keys on Mac or Alt + arrow keys on Windows to move
                    the answer.
                </div>
                ${this._displayError ? html`<div class="save-error form-help" role="status">${this._displayError}</div>` : ''}
            </section>
        `;
    }

    renderOpacitySlider(key, label, help) {
        const value = normalizeTestVisibility(this.preferences)[key];
        return html`
            <div>
                <div class="slider-header">
                    <label class="form-label" for=${key}>${label}</label>
                    <output class="chip" for=${key}>${value}%</output>
                </div>
                <input
                    id=${key}
                    class="opacity-slider"
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    .value=${String(value)}
                    aria-describedby=${`${key}-help`}
                    ?disabled=${!this._loaded}
                    @input=${event => this.previewOpacity(key, Number(event.target.value))}
                    @change=${event => this.savePreference(key, Number(event.target.value))}
                />
                <div class="form-help" id=${`${key}-help`}>${help} 0% is invisible; 100% is fully visible.</div>
            </div>
        `;
    }

    render() {
        const prefs = normalizeTestVisibility(this.preferences);
        const modifier = cheatingDaddy.isMacOS || navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
        return html`
            <div class="unified-page">
                <div class="unified-wrap">
                    <div>
                        <div class="page-title">Test Visibility</div>
                        <div class="page-subtitle">Choose how answers appear during a session.</div>
                    </div>
                    <section class="surface">
                        <label class="toggle-row" for="blindMode">
                            <span>Blind mode — answers only</span>
                            <input
                                id="blindMode"
                                type="checkbox"
                                .checked=${prefs.blindMode}
                                ?disabled=${!this._loaded}
                                @change=${event => this.savePreference('blindMode', event.target.checked)}
                            />
                        </label>
                        <p class="form-help">
                            Hide waiting messages, status, navigation and input controls while the session is active. Only the answer remains.
                        </p>
                        <p class="form-help">
                            During a session, clicks and scrolling pass through to the app underneath. Use shortcuts to control the answer; copying is
                            available in History.
                        </p>
                        <p class="form-help">
                            Use ${modifier} + \\ to show or hide the app. Reopen these settings with ${modifier} + Shift + , (default shortcut), even
                            when the answer is invisible. Shortcuts can be changed in Settings.
                        </p>
                    </section>
                    ${this.renderPlacement()}
                    <section class="surface form-row">
                        <div class="surface-title">Answer visibility</div>
                        ${this.renderOpacitySlider('answerTextOpacity', 'Answer text opacity', 'Changes answer text and formulas.')}
                        ${this.renderOpacitySlider('answerFrameOpacity', 'Answer frame opacity', 'Changes the answer background and border separately from the text.')}
                        <div class="form-row">
                            <label class="form-label" for="answerTextColor">Answer text color</label>
                            <div class="color-row">
                                <input
                                    id="answerTextColor"
                                    type="color"
                                    .value=${prefs.answerTextColor || '#ffffff'}
                                    ?disabled=${!this._loaded}
                                    @input=${event => this.previewOpacity('answerTextColor', event.target.value)}
                                    @change=${event => this.savePreference('answerTextColor', event.target.value)}
                                />
                                <span class="chip">${prefs.answerTextColor || 'Theme default'}</span>
                                <button
                                    type="button"
                                    class="control compact-button"
                                    ?disabled=${!this._loaded || !prefs.answerTextColor}
                                    @click=${() => this.savePreference('answerTextColor', '')}
                                >
                                    Use theme color
                                </button>
                            </div>
                            <div class="form-help">Changes live answer text and formulas. The preview below shows the selected color.</div>
                        </div>
                    </section>
                    <section class="surface">
                        <label class="toggle-row" for="emphasizeAnswerLabels">
                            <span>Bold question numbers and answer letters</span>
                            <input
                                id="emphasizeAnswerLabels"
                                type="checkbox"
                                .checked=${prefs.emphasizeAnswerLabels}
                                ?disabled=${!this._loaded}
                                @change=${event => this.savePreference('emphasizeAnswerLabels', event.target.checked)}
                            />
                        </label>
                        <p class="form-help">Make labels such as “Question 7” and “B” stand out in answers.</p>
                    </section>
                    <section class="surface">
                        <div class="surface-title">Preview</div>
                        <div class="surface-subtitle">This sample does not make an AI request.</div>
                        <div
                            class="preview"
                            style=${`--preview-text-opacity: ${prefs.answerTextOpacity / 100}; --preview-frame-opacity: ${prefs.answerFrameOpacity / 100}; --preview-answer-color: ${prefs.answerTextColor || 'var(--text-primary)'};`}
                        >
                            <div class="preview-frame">
                                ${prefs.blindMode ? '' : html`<div class="preview-status">Screen ready · Practice session</div>`}
                                <div class="preview-answer">
                                    ${prefs.emphasizeAnswerLabels ? html`<strong>Question 7 · B</strong>` : 'Question 7 · B'}<br />
                                    Linear time: Θ(n)
                                </div>
                                ${prefs.blindMode ? '' : html`<div class="preview-status preview-controls">Keyboard shortcuts · Mouse passes through</div>`}
                            </div>
                        </div>
                    </section>
                    <div class=${`save-status ${this._error ? 'save-error' : ''}`} role="status" aria-live="polite">
                        ${this._error || (this._saving ? 'Saving…' : this._loaded ? 'Settings saved automatically.' : 'Loading settings…')}
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('test-visibility-view', TestVisibilityView);
