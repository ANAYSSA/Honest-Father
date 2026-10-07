const assert = require('node:assert/strict');

module.exports = async function checkHistory(window) {
    const { clipboard } = require('electron');
    const originalWrite = clipboard.write;
    const copied = [];
    clipboard.write = data => copied.push(data);
    let result;
    try {
        result = await window.webContents.executeJavaScript(`(async () => {
        const app = document.querySelector('cheating-daddy-app');
        const originalView = app.currentView;
        const storage = window.cheatingDaddy.storage;
        const source = String.raw\`**Question 7: B** — \\(\\Theta(n^2)\\)\n\n\\[\\frac{n^2}{3} + \\log_2 n\\]\`;
        const modelInfo = { provider: 'chatgpt', modelId: 'gpt-6-astra', displayName: 'GPT-6 Astra', reasoningMode: 'standard', reasoningEffort: 'low' };
        const sessionId = String(Date.now());
        try {
            const saved = await storage.saveSession(sessionId, {
                createdAt: Date.now(), profile: 'exam', modelInfo, modelsUsed: [modelInfo],
                screenAnalysisHistory: [{ response: source, timestamp: Date.now(), modelInfo }],
                conversationHistory: []
            });
            if (!saved.success) throw new Error('Could not save isolated History fixture');
            app.currentView = 'history';
            await app.updateComplete;
            const view = app.shadowRoot.querySelector('history-view');
            await view.loadSessions();
            await view.updateComplete;
            const sessionLabel = view.shadowRoot.textContent.includes('GPT-6 Astra · Fast');
            await view.openSession(sessionId);
            view.activeTab = 'screen';
            await view.updateComplete;
            const mathRendered = view.shadowRoot.querySelectorAll('.katex').length === 2;
            const boldRendered = view.shadowRoot.querySelector('strong')?.textContent === 'Question 7: B';
            const entryLabel = view.shadowRoot.querySelector('.message-model')?.textContent === 'GPT-6 Astra · Fast';
            view.shadowRoot.querySelector('.copy-btn').click();
            for (let attempt = 0; attempt < 100 && !view._copyState; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
            await view.updateComplete;
            const copiedFeedback = view.shadowRoot.querySelector('.copy-btn').textContent.trim() === 'Copied';
            view.shadowRoot.querySelector('.history-toolbar .history-action').click();
            await view.updateComplete;
            const confirmation = !!view.shadowRoot.querySelector('.clear-confirmation') && (await storage.getAllSessions()).length > 0;
            await view.clearHistory();
            await view.updateComplete;
            const historyCleared = (await storage.getAllSessions()).length === 0 && view.sessions.length === 0 && !view.selectedSession && !view.shadowRoot.querySelector('.clear-confirmation');
            return { sessionLabel, mathRendered, boldRendered, entryLabel, copiedFeedback, confirmation, historyCleared };
        } finally {
            app.currentView = originalView;
            await app.updateComplete;
        }
    })()`);
    } finally {
        clipboard.write = originalWrite;
    }
    assert.equal(copied.length, 1, 'Renderer copy reaches the main-process clipboard');
    assert.match(copied[0].text, /Question 7: B/);
    assert.ok(copied[0].text.includes('\\Theta(n^2)'), 'Plain copy preserves original TeX');
    assert.ok(copied[0].html.includes('<math '), 'Rich copy contains native MathML');
    assert.ok(!copied[0].html.includes('katex-html'), 'Rich copy has no duplicate visual formula');
    assert.ok(copied[0].html.includes('<strong>Question 7: B</strong>'), 'Rich copy retains bold formatting');
    for (const [key, value] of Object.entries(result)) assert.equal(value, true, key);
    console.log('History math, model labels, copy and clear smoke passed:', JSON.stringify(result));
};
