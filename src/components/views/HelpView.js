import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';

const { getDefaultKeybinds, normalizeKeybinds } = window.require('./utils/keybinds');

export class HelpView extends LitElement {
    static styles = [
        unifiedPageStyles,
        css`
            .shortcut-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: var(--space-sm);
            }

            .shortcut-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-sm);
                padding: var(--space-sm);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: var(--bg-elevated);
            }

            .shortcut-label {
                color: var(--text-secondary);
                font-size: var(--font-size-xs);
            }

            .shortcut-keys {
                display: inline-flex;
                gap: 4px;
                flex-wrap: wrap;
                justify-content: flex-end;
            }

            .key {
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                padding: 2px 6px;
                font-size: var(--font-size-xs);
                color: var(--text-primary);
                background: var(--bg-surface);
                font-family: var(--font-mono);
            }

            .list {
                display: grid;
                gap: var(--space-sm);
            }

            .list-item {
                padding: var(--space-sm);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                color: var(--text-secondary);
                font-size: var(--font-size-sm);
                line-height: 1.45;
                background: var(--bg-elevated);
            }

            .link-row {
                display: flex;
                flex-wrap: wrap;
                gap: var(--space-sm);
            }

            .link-button {
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                padding: 8px 10px;
                background: var(--bg-elevated);
                color: var(--text-primary);
                font-size: var(--font-size-sm);
                cursor: pointer;
                transition:
                    border-color var(--transition),
                    color var(--transition),
                    background var(--transition);
            }

            .link-button:hover {
                color: var(--text-primary);
                border-color: var(--accent);
                background: rgba(63, 125, 229, 0.14);
            }

            @media (max-width: 820px) {
                .shortcut-grid {
                    grid-template-columns: 1fr;
                }
            }
        `,
    ];

    static properties = {
        onExternalLinkClick: { type: Function },
        keybinds: { type: Object },
    };

    constructor() {
        super();
        this.onExternalLinkClick = () => {};
        this.keybinds = this.getDefaultKeybinds();
        this._loadKeybinds();
    }

    async _loadKeybinds() {
        try {
            const keybinds = await cheatingDaddy.storage.getKeybinds();
            if (keybinds) {
                const isMac = cheatingDaddy.isMacOS || navigator.platform.includes('Mac');
                this.keybinds = normalizeKeybinds(keybinds, isMac ? 'darwin' : 'win32');
                this.requestUpdate();
            }
        } catch (error) {
            console.error('Error loading keybinds:', error);
        }
    }

    getDefaultKeybinds() {
        const isMac = cheatingDaddy.isMacOS || navigator.platform.includes('Mac');
        return getDefaultKeybinds(isMac ? 'darwin' : 'win32');
    }

    _formatKeybind(keybind) {
        return keybind.split('+').map(key => html`<span class="key">${key}</span>`);
    }

    _open(url) {
        this.onExternalLinkClick(url);
    }

    render() {
        const shortcutRows = [
            ['Move Window Up', this.keybinds.moveUp],
            ['Move Window Down', this.keybinds.moveDown],
            ['Move Window Left', this.keybinds.moveLeft],
            ['Move Window Right', this.keybinds.moveRight],
            ['Toggle App Window', this.keybinds.toggleVisibility],
            ['Toggle Review Marks', this.keybinds.toggleReviewMarks],
            ['Toggle Click-through', this.keybinds.toggleClickThrough],
            ['Ask Next Step', this.keybinds.nextStep],
            ['Previous Response', this.keybinds.previousResponse],
            ['Next Response', this.keybinds.nextResponse],
            ['Scroll Response Up', this.keybinds.scrollUp],
            ['Scroll Response Down', this.keybinds.scrollDown],
            ['Quit Application', this.keybinds.quitApplication],
        ];

        return html`
            <div class="unified-page">
                <div class="unified-wrap">
                    <div class="page-title">Help</div>

                    <section class="surface">
                        <div class="surface-title">Support</div>
                        <div class="link-row">
                            <button class="link-button" @click=${() => this._open('https://github.com/CyberKotletochka/Honest-Father')}>
                                Website
                            </button>
                            <button class="link-button" @click=${() => this._open('https://github.com/CyberKotletochka/Honest-Father')}>
                                GitHub
                            </button>
                            <button class="link-button" @click=${() => this._open('https://discord.gg/GCBdubnXfJ')}>Discord</button>
                        </div>
                    </section>

                    <section class="surface">
                        <div class="surface-title">Keyboard Shortcuts</div>
                        <div class="shortcut-grid">
                            ${shortcutRows.map(
                                ([label, keys]) => html`
                                    <div class="shortcut-row">
                                        <span class="shortcut-label">${label}</span>
                                        <span class="shortcut-keys">${this._formatKeybind(keys)}</span>
                                    </div>
                                `
                            )}
                        </div>
                    </section>
                </div>
            </div>
        `;
    }
}

customElements.define('help-view', HelpView);
