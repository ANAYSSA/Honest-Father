import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';
import { renderResponseHtml, renderResponseClipboardHtml, installResponseStyles } from '../../utils/responseRendering.js';

export class HistoryView extends LitElement {
    static styles = [
        unifiedPageStyles,
        css`
            .unified-page {
                overflow-y: hidden;
            }

            .unified-wrap {
                height: 100%;
            }

            .history-toolbar,
            .message-footer,
            .clear-confirmation,
            .confirmation-actions {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-sm);
            }

            .history-toolbar .page-title {
                margin: 0;
            }
            .history-action {
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: var(--bg-elevated);
                color: var(--text-secondary);
                padding: 6px 10px;
                font-size: var(--font-size-xs);
                cursor: pointer;
                white-space: nowrap;
            }
            .history-action:hover:not(:disabled) {
                color: var(--text-primary);
                border-color: var(--text-muted);
            }
            .history-action:disabled {
                opacity: 0.4;
                cursor: default;
            }
            .history-action.danger {
                color: var(--danger);
            }
            .clear-confirmation {
                flex-wrap: wrap;
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: var(--bg-elevated);
                padding: var(--space-sm);
                color: var(--text-secondary);
                font-size: var(--font-size-xs);
            }
            .history-error {
                color: var(--danger);
                font-size: var(--font-size-xs);
            }
            .message-footer {
                margin-top: 7px;
                flex-wrap: wrap;
            }
            .message-footer .message-meta {
                margin: 0;
            }
            .model-label {
                color: var(--text-secondary);
                font-size: var(--font-size-xs);
                overflow-wrap: anywhere;
            }
            .message-model {
                display: block;
                font-size: 10px;
                margin-top: 2px;
            }
            .copy-btn {
                padding: 3px 7px;
            }
            .message-body,
            .message-body * {
                user-select: text;
            }

            .search-wrap {
                position: relative;
                max-width: 280px;
            }

            .search-icon {
                position: absolute;
                left: 10px;
                top: 50%;
                transform: translateY(-50%);
                width: 14px;
                height: 14px;
                color: var(--text-muted);
                pointer-events: none;
            }

            .search-wrap .control {
                padding-left: 30px;
            }

            .list-shell {
                border: 1px solid var(--border);
                border-radius: var(--radius-md);
                background: var(--bg-surface);
                overflow: hidden;
                flex: 1;
                display: flex;
                flex-direction: column;
                min-height: 0;
            }

            .sessions-list {
                overflow-y: auto;
                flex: 1;
            }

            .session-card {
                width: 100%;
                border: none;
                border-bottom: 1px solid var(--border);
                background: transparent;
                text-align: left;
                padding: var(--space-sm) var(--space-md);
                cursor: pointer;
                transition: background var(--transition);
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-sm);
            }

            .session-card:hover {
                background: var(--bg-hover);
            }

            .session-left {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }

            .session-profile {
                color: var(--text-primary);
                font-size: var(--font-size-sm);
            }

            .session-date {
                color: var(--text-muted);
                font-size: var(--font-size-xs);
            }

            .session-badge {
                color: var(--text-secondary);
                font-size: var(--font-size-xs);
                background: var(--bg-elevated);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                padding: 2px 8px;
                white-space: nowrap;
            }

            .detail-top {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
            }

            .back-btn {
                border: none;
                background: none;
                color: var(--text-muted);
                padding: 0;
                font-size: var(--font-size-sm);
                cursor: pointer;
                display: flex;
                align-items: center;
            }

            .back-btn svg {
                cursor: pointer;
            }

            .back-btn:hover {
                color: var(--text-primary);
            }

            .detail-info {
                color: var(--text-secondary);
                font-size: var(--font-size-sm);
            }

            .tab-row {
                display: flex;
                gap: 6px;
            }

            .tab-btn {
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: transparent;
                color: var(--text-muted);
                padding: 6px 10px;
                cursor: pointer;
                font-size: var(--font-size-xs);
            }

            .tab-btn:hover {
                color: var(--text-secondary);
            }

            .tab-btn.active {
                color: var(--text-primary);
                border-color: var(--text-secondary);
            }

            .details-scroll {
                overflow-y: auto;
                flex: 1;
                min-height: 0;
                display: flex;
                flex-direction: column;
                gap: var(--space-sm);
                padding: var(--space-sm) 0;
            }

            .message-row {
                display: flex;
            }

            .message-row.user {
                justify-content: flex-end;
            }

            .message-row.ai,
            .message-row.screen {
                justify-content: flex-start;
            }

            .message {
                max-width: 75%;
                border-radius: 16px;
                padding: 8px 12px;
                word-break: break-word;
                user-select: text;
                cursor: text;
                font-size: var(--font-size-sm);
                line-height: 1.45;
            }

            .message-body {
                white-space: pre-wrap;
            }

            .message-meta {
                font-size: 10px;
                margin-top: 4px;
                opacity: 0.5;
            }

            .message-row.user .message {
                background: var(--accent);
                color: var(--bg-app);
                border-bottom-right-radius: 4px;
            }

            .message-row.user .message-meta {
                text-align: right;
            }

            .message-row.ai .message {
                background: var(--bg-elevated);
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-bottom-left-radius: 4px;
            }

            .message-row.screen .message {
                background: var(--bg-elevated);
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-bottom-left-radius: 4px;
            }

            .context-row {
                display: flex;
                align-items: flex-start;
                gap: var(--space-sm);
                padding: var(--space-sm);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: var(--bg-elevated);
            }

            .context-key {
                width: 84px;
                color: var(--text-muted);
                font-size: var(--font-size-xs);
                text-transform: uppercase;
                letter-spacing: 0.4px;
                flex-shrink: 0;
            }

            .context-value {
                color: var(--text-primary);
                font-size: var(--font-size-sm);
                line-height: 1.45;
                white-space: pre-wrap;
                word-break: break-word;
                user-select: text;
                cursor: text;
            }

            .empty {
                color: var(--text-muted);
                font-size: var(--font-size-sm);
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 120px;
                border: 1px dashed var(--border);
                border-radius: var(--radius-sm);
            }
        `,
    ];

    static properties = {
        sessions: { type: Array },
        selectedSession: { type: Object },
        selectedSessionId: { type: String },
        loading: { type: Boolean },
        activeTab: { type: String },
        searchQuery: { type: String },
        _clearConfirmation: { state: true },
        _clearing: { state: true },
        _historyError: { state: true },
        _copyKey: { state: true },
        _copyState: { state: true },
    };

    constructor() {
        super();
        this.sessions = [];
        this.selectedSession = null;
        this.selectedSessionId = null;
        this.loading = true;
        this.activeTab = 'conversation';
        this.searchQuery = '';
        this._clearConfirmation = false;
        this._clearing = false;
        this._historyError = '';
        this._copyKey = '';
        this._copyState = '';
        this._copyAttempt = 0;
        this._copyTimer = null;
        this.loadSessions();
    }

    firstUpdated() {
        installResponseStyles(this.shadowRoot);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        clearTimeout(this._copyTimer);
        this._copyAttempt++;
    }

    async copyResponse(content, key) {
        const attempt = ++this._copyAttempt;
        clearTimeout(this._copyTimer);
        try {
            const text = String(content ?? '');
            const ipc = window.require?.('electron')?.ipcRenderer;
            if (ipc) {
                const result = await ipc.invoke('clipboard:write-response', { text, html: renderResponseClipboardHtml(text) });
                if (!result?.success) throw new Error('Clipboard is unavailable');
            } else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
            else throw new Error('Clipboard is unavailable');
            if (attempt !== this._copyAttempt) return;
            this._copyState = 'copied';
        } catch {
            if (attempt !== this._copyAttempt) return;
            this._copyState = 'failed';
        }
        this._copyKey = key;
        this._copyTimer = setTimeout(() => {
            this._copyKey = '';
            this._copyState = '';
        }, 2500);
    }

    async clearHistory() {
        if (!this._clearConfirmation || this._clearing) return;
        this._clearing = true;
        this._historyError = '';
        try {
            const result = await cheatingDaddy.storage.deleteAllSessions();
            if (result === false || result?.success === false) throw new Error('History could not be deleted');
            this.closeSession();
            this.searchQuery = '';
            this._clearConfirmation = false;
            await this.loadSessions();
        } catch {
            this._historyError = 'Could not clear history. Please try again.';
        } finally {
            this._clearing = false;
        }
    }

    _modelLabel(info) {
        if (!info || typeof info !== 'object') return 'Model not recorded';
        const name = typeof info.displayName === 'string' ? info.displayName : typeof info.modelId === 'string' ? info.modelId : '';
        if (!name) return 'Model not recorded';
        const parts = [name];
        if (info.reasoningMode === 'pro') parts.push('Pro');
        if (typeof info.reasoningEffort === 'string' && info.reasoningEffort) {
            const effort = info.reasoningEffort;
            parts.push(['none', 'minimal', 'low'].includes(effort) ? 'Fast' : effort.charAt(0).toUpperCase() + effort.slice(1));
        }
        return parts.join(' · ');
    }

    _sessionModelLabel(session) {
        const models =
            Array.isArray(session.modelsUsed) && session.modelsUsed.length ? session.modelsUsed : session.modelInfo ? [session.modelInfo] : [];
        const labels = [...new Set(models.map(info => this._modelLabel(info)))];
        return labels.length ? labels.join(' / ') : 'Model not recorded';
    }

    _renderCopyButton(content, key) {
        const label = this._copyKey === key ? (this._copyState === 'copied' ? 'Copied' : 'Copy failed') : 'Copy answer';
        return html`<button
            class="history-action copy-btn"
            title="Copy the full answer, including formatted text and formulas"
            aria-live="polite"
            @click=${() => this.copyResponse(content, key)}
        >
            ${label}
        </button>`;
    }

    async loadSessions() {
        try {
            this.loading = true;
            this.sessions = await cheatingDaddy.storage.getAllSessions();
        } catch (error) {
            console.error('Error loading sessions:', error);
            this.sessions = [];
        } finally {
            this.loading = false;
            this.requestUpdate();
        }
    }

    async openSession(sessionId) {
        try {
            const session = await cheatingDaddy.storage.getSession(sessionId);
            if (session) {
                clearTimeout(this._copyTimer);
                this._copyAttempt++;
                this._copyKey = '';
                this._copyState = '';
                this.selectedSession = session;
                this.selectedSessionId = sessionId;
                this.activeTab = 'conversation';
                this.requestUpdate();
            }
        } catch (error) {
            console.error('Error loading session:', error);
        }
    }

    closeSession() {
        clearTimeout(this._copyTimer);
        this._copyAttempt++;
        this._copyKey = '';
        this._copyState = '';
        this.selectedSession = null;
        this.selectedSessionId = null;
        this.activeTab = 'conversation';
    }

    handleSearchInput(e) {
        this.searchQuery = e.target.value;
    }

    formatDate(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }

    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    getProfileNames() {
        return {
            interview: 'Job Interview',
            sales: 'Sales Call',
            meeting: 'Business Meeting',
            presentation: 'Presentation',
            negotiation: 'Negotiation',
            exam: 'Exam Assistant',
        };
    }

    _getProfileLabel(session) {
        if (session.profile) {
            const names = this.getProfileNames();
            return names[session.profile] || session.profile;
        }
        return 'Session';
    }

    getSessionPreview(session) {
        const parts = [];
        if (session.messageCount > 0) parts.push(`${session.messageCount} messages`);
        if (session.screenAnalysisCount > 0) parts.push(`${session.screenAnalysisCount} screen`);
        if (session.profile) {
            const profileNames = this.getProfileNames();
            parts.push(profileNames[session.profile] || session.profile);
        }
        return parts.length > 0 ? parts.join(' · ') : 'Empty session';
    }

    getFilteredSessions() {
        if (!this.searchQuery.trim()) return this.sessions;
        const q = this.searchQuery.toLowerCase();
        return this.sessions.filter(session => {
            const preview = this.getSessionPreview(session).toLowerCase();
            const date = this.formatDate(session.createdAt).toLowerCase();
            return preview.includes(q) || date.includes(q) || this._sessionModelLabel(session).toLowerCase().includes(q);
        });
    }

    collectConversation(session) {
        const messages = [];
        const history = session.conversationHistory || [];
        history.forEach(turn => {
            if (turn.transcription) messages.push({ type: 'user', content: turn.transcription, timestamp: turn.timestamp });
            if (turn.ai_response) messages.push({ type: 'ai', content: turn.ai_response, timestamp: turn.timestamp, modelInfo: turn.modelInfo });
        });
        return messages;
    }

    renderTabContent() {
        if (!this.selectedSession) return html`<div class="empty">Select a session.</div>`;

        if (this.activeTab === 'conversation') {
            const messages = this.collectConversation(this.selectedSession);
            if (!messages.length) return html`<div class="empty">No conversation data.</div>`;
            return messages.map(
                (msg, index) => html`
                    <div class="message-row ${msg.type}">
                        <div class="message">
                            ${
                                msg.type === 'ai'
                                    ? html`<div class="message-body response-markdown" .innerHTML=${renderResponseHtml(msg.content)}></div>`
                                    : html`<div class="message-body">${msg.content}</div>`
                            }
                            ${
                                msg.type === 'ai'
                                    ? html` <div class="message-footer">
                                          <div>
                                              <span class="message-meta">${this.formatTime(msg.timestamp)}</span>
                                              <span class="model-label message-model">${this._modelLabel(msg.modelInfo)}</span>
                                          </div>
                                          ${this._renderCopyButton(msg.content, `conversation-${index}`)}
                                      </div>`
                                    : html`<div class="message-meta">${this.formatTime(msg.timestamp)}</div>`
                            }
                        </div>
                    </div>
                `
            );
        }

        if (this.activeTab === 'screen') {
            const screen = this.selectedSession.screenAnalysisHistory || [];
            if (!screen.length) return html`<div class="empty">No screen analysis data.</div>`;
            return screen.map(
                (entry, index) => html`
                    <div class="message-row screen">
                        <div class="message">
                            <div class="message-body response-markdown" .innerHTML=${renderResponseHtml(entry.response || '')}></div>
                            <div class="message-footer">
                                <div>
                                    <span class="message-meta">${this.formatTime(entry.timestamp)}</span>
                                    <span class="model-label message-model"
                                        >${this._modelLabel(entry.modelInfo || (entry.model ? { modelId: entry.model } : null))}</span
                                    >
                                </div>
                                ${this._renderCopyButton(entry.response || '', `screen-${index}`)}
                            </div>
                        </div>
                    </div>
                `
            );
        }

        const profile = this.selectedSession.profile;
        const prompt = this.selectedSession.customPrompt;
        if (!profile && !prompt) return html`<div class="empty">No context saved for this session.</div>`;

        return html`
            ${
                profile
                    ? html`
                          <div class="context-row">
                              <span class="context-key">Profile</span>
                              <span class="context-value">${this.getProfileNames()[profile] || profile}</span>
                          </div>
                      `
                    : ''
            }
            ${
                prompt
                    ? html`
                          <div class="context-row">
                              <span class="context-key">Prompt</span>
                              <span class="context-value">${prompt}</span>
                          </div>
                      `
                    : ''
            }
        `;
    }

    renderListView() {
        const filteredSessions = this.getFilteredSessions();
        return html`
            <div class="search-wrap">
                <svg
                    class="search-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input class="control" type="text" placeholder="Search sessions..." .value=${this.searchQuery} @input=${this.handleSearchInput} />
            </div>

            <section class="list-shell">
                <div class="sessions-list">
                    ${this.loading ? html`<div class="empty" style="margin:var(--space-md);">Loading sessions...</div>` : ''}
                    ${!this.loading && filteredSessions.length === 0 ? html`<div class="empty" style="margin:var(--space-md);">No matching sessions.</div>` : ''}
                    ${
                        !this.loading
                            ? filteredSessions.map(
                                  session => html`
                                      <button class="session-card" @click=${() => this.openSession(session.sessionId)}>
                                          <div class="session-left">
                                              <span class="session-profile">${this._getProfileLabel(session)}</span>
                                              <span class="session-date"
                                                  >${this.formatDate(session.createdAt)} · ${this.formatTime(session.createdAt)}</span
                                              >
                                              <span class="model-label">${this._sessionModelLabel(session)}</span>
                                          </div>
                                          ${session.messageCount > 0 ? html`<span class="session-badge">${session.messageCount}</span>` : ''}
                                      </button>
                                  `
                              )
                            : ''
                    }
                </div>
            </section>
        `;
    }

    renderDetailView() {
        const conversationCount = this.collectConversation(this.selectedSession).length;
        const screenCount = this.selectedSession?.screenAnalysisHistory?.length || 0;

        return html`
            <div class="detail-top">
                <button class="back-btn" @click=${this.closeSession}>
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <polyline points="15 18 9 12 15 6" />
                    </svg>
                </button>
                <span class="detail-info"
                    >${this._getProfileLabel(this.selectedSession)} · ${this.formatDate(this.selectedSession.createdAt)} ·
                    ${this.formatTime(this.selectedSession.createdAt)}</span
                >
            </div>
            <div class="model-label">${this._sessionModelLabel(this.selectedSession)}</div>
            <div class="tab-row">
                <button
                    class="tab-btn ${this.activeTab === 'conversation' ? 'active' : ''}"
                    @click=${() => {
                        this.activeTab = 'conversation';
                    }}
                >
                    Conversation (${conversationCount})
                </button>
                <button
                    class="tab-btn ${this.activeTab === 'screen' ? 'active' : ''}"
                    @click=${() => {
                        this.activeTab = 'screen';
                    }}
                >
                    Screen (${screenCount})
                </button>
                <button
                    class="tab-btn ${this.activeTab === 'context' ? 'active' : ''}"
                    @click=${() => {
                        this.activeTab = 'context';
                    }}
                >
                    Context
                </button>
            </div>
            <section class="details-scroll">${this.renderTabContent()}</section>
        `;
    }

    render() {
        return html`
            <div class="unified-page">
                <div class="unified-wrap">
                    <div class="history-toolbar">
                        <div class="page-title">${this.selectedSession ? 'Session Detail' : 'History'}</div>
                        <button
                            class="history-action danger"
                            ?disabled=${this.loading || this._clearing || this.sessions.length === 0}
                            @click=${() => {
                                this._clearConfirmation = !this._clearConfirmation;
                                this._historyError = '';
                            }}
                        >
                            Clear history
                        </button>
                    </div>
                    ${
                        this._clearConfirmation
                            ? html` <div class="clear-confirmation" role="alert">
                                  <span>Delete all saved sessions? This cannot be undone.</span>
                                  <div class="confirmation-actions">
                                      <button
                                          class="history-action"
                                          ?disabled=${this._clearing}
                                          @click=${() => {
                                              this._clearConfirmation = false;
                                          }}
                                      >
                                          Cancel
                                      </button>
                                      <button class="history-action danger" ?disabled=${this._clearing} @click=${this.clearHistory}>
                                          ${this._clearing ? 'Deleting...' : 'Delete all'}
                                      </button>
                                  </div>
                              </div>`
                            : ''
                    }
                    ${this._historyError ? html`<div class="history-error" role="alert">${this._historyError}</div>` : ''}
                    ${this.selectedSession ? this.renderDetailView() : this.renderListView()}
                </div>
            </div>
        `;
    }
}

customElements.define('history-view', HistoryView);
