import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';

const { DEFAULT_TEST_VISIBILITY, normalizeTestVisibility, validateTestVisibilityUpdate } = window.require('./utils/testVisibility');

export class TestVisibilityView extends LitElement {
    static properties = {
        preferences: { type: Object },
        _loaded: { state: true },
        _saving: { state: true },
        _error: { state: true },
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
                color: var(--text-primary);
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
            input:focus-visible {
                outline: 2px solid var(--accent);
                outline-offset: 3px;
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
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this._loaded) this._loadPreferences();
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
                            Use ${modifier} + \\ to show or hide the app. Reopen these settings with ${modifier} + Shift + , (default shortcut), even
                            when the answer is invisible. Shortcuts can be changed in Settings.
                        </p>
                    </section>
                    <section class="surface form-row">
                        <div class="surface-title">Answer visibility</div>
                        ${this.renderOpacitySlider('answerTextOpacity', 'Answer text opacity', 'Changes answer text and formulas.')}
                        ${this.renderOpacitySlider('answerFrameOpacity', 'Answer frame opacity', 'Changes the answer background and border separately from the text.')}
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
                            style=${`--preview-text-opacity: ${prefs.answerTextOpacity / 100}; --preview-frame-opacity: ${prefs.answerFrameOpacity / 100};`}
                        >
                            <div class="preview-frame">
                                ${prefs.blindMode ? '' : html`<div class="preview-status">Screen ready · Practice session</div>`}
                                <div class="preview-answer">
                                    ${prefs.emphasizeAnswerLabels ? html`<strong>Question 7 · B</strong>` : 'Question 7 · B'}<br />
                                    Linear time: Θ(n)
                                </div>
                                ${prefs.blindMode ? '' : html`<div class="preview-status preview-controls">Previous · Next · Analyze Screen</div>`}
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
