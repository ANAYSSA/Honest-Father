const assert = require('node:assert/strict');

module.exports = async function checkAnswerVisibility(window) {
    const result = await window.webContents.executeJavaScript(`(async () => {
        const app = document.querySelector('cheating-daddy-app');
        const original = { currentView: app.currentView, responses: app.responses, currentResponseIndex: app.currentResponseIndex, sessionActive: app.sessionActive, testReview: app.testReview, visibilityPreferences: app.visibilityPreferences };
        const wait = async () => { await app.updateComplete; const view = app.shadowRoot.querySelector('assistant-view'); await view?.updateComplete; return view; };
        try {
            app.testReview = false;
            app.sessionActive = true;
            app.visibilityPreferences = { blindMode: true, answerTextOpacity: 100, answerFrameOpacity: 0, emphasizeAnswerLabels: true };
            app.responses = [];
            app.currentResponseIndex = -1;
            app.currentView = 'assistant';
            let view = await wait();
            const blank = view.shadowRoot.querySelector('#responseContainer').textContent === '' && !app.shadowRoot.querySelector('.live-bar') && !view.shadowRoot.querySelector('.answer-backplate') && getComputedStyle(view.shadowRoot.querySelector('.input-bar')).display === 'none';
            const transparentShell = [document.body, app, app.shadowRoot.querySelector('.content'), view.shadowRoot.querySelector('.response-container')].every(node => getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)');
            app.responses = [String.raw\`**Question 7: B** — \\(\\Theta(n^2)\\)\n\n\\[\\frac{n^2}{3} + \\log_2 n\\]\`];
            app.currentResponseIndex = 0;
            view = await wait();
            const formula = view.shadowRoot.querySelectorAll('.katex').length === 2 && view.shadowRoot.querySelector('strong')?.textContent === 'Question 7: B';
            await document.fonts.ready;
            const stylesLoaded = await new Promise(resolve => { const link = view.shadowRoot.querySelector('[data-response-math-styles]'); if(link.sheet) resolve(true); else { link.onload = () => resolve(true); link.onerror = () => resolve(false); } });
            const read = () => ({ text: getComputedStyle(view.shadowRoot.querySelector('#responseContainer')).opacity, frame: getComputedStyle(view.shadowRoot.querySelector('.answer-backplate')).opacity });
            const fullText = read();
            const passiveContent = getComputedStyle(view).pointerEvents === 'none' && getComputedStyle(view.shadowRoot.querySelector('strong')).userSelect === 'none' && !view.shadowRoot.querySelector('button, input, textarea');
            app.visibilityPreferences = { ...app.visibilityPreferences, answerTextColor: '#51c8ef' };
            view = await wait();
            const customColor = [view.shadowRoot.querySelector('strong'), view.shadowRoot.querySelector('.katex')].every(node => getComputedStyle(node).color === 'rgb(81, 200, 239)');
            app.visibilityPreferences = { ...app.visibilityPreferences, answerTextColor: '' };
            view = await wait();
            const themeColorRestored = !view.style.getPropertyValue('--answer-text-color') && getComputedStyle(view.shadowRoot.querySelector('.katex')).color !== 'rgb(81, 200, 239)';
            app.visibilityPreferences = { ...app.visibilityPreferences, answerTextOpacity: 50, answerFrameOpacity: 35 };
            view = await wait(); const partial = read();
            app.visibilityPreferences = { ...app.visibilityPreferences, answerTextOpacity: 0, answerFrameOpacity: 0 };
            view = await wait(); const zero = read();
            // The same event sent by the native recovery hotkey must restore a readable settings page.
            window.require('electron').ipcRenderer.emit('open-test-visibility');
            await wait();
            const settings = app.shadowRoot.querySelector('test-visibility-view');
            await settings?.updateComplete;
            const recovered = !!settings && !app.hasAttribute('answer-visibility') && getComputedStyle(app).backgroundColor === getComputedStyle(document.body).backgroundColor && !getComputedStyle(app).backgroundColor.startsWith('rgba') && app.sessionActive && !!app.shadowRoot.querySelector('.session-return');
            const theme = cheatingDaddy.theme.current;
            cheatingDaddy.theme.apply('light', 0);
            const lightSettingsReadable = getComputedStyle(app).backgroundColor === 'rgb(255, 255, 255)' && getComputedStyle(app).color !== 'rgb(255, 255, 255)';
            cheatingDaddy.theme.apply(theme);
            app.shadowRoot.querySelector('.session-return button').click();
            view = await wait();
            const returned = app.currentView === 'assistant' && app.sessionActive && view.shadowRoot.querySelector('strong')?.textContent === 'Question 7: B';
            app.testReview = true;
            view = await wait();
            const reviewUnchanged = !app.hasAttribute('answer-visibility') && !!app.shadowRoot.querySelector('.live-bar') && getComputedStyle(view.shadowRoot.querySelector('#responseContainer')).opacity === '1' && !view.hasAttribute('blind-mode');
            return { blank, transparentShell, formula, stylesLoaded, passiveContent, customColor, themeColorRestored, fullText, partial, zero, recovered, lightSettingsReadable, returned, reviewUnchanged };
        } finally { Object.assign(app, original); await app.updateComplete; }
    })()`);
    for (const key of [
        'blank',
        'transparentShell',
        'formula',
        'stylesLoaded',
        'passiveContent',
        'customColor',
        'themeColorRestored',
        'recovered',
        'lightSettingsReadable',
        'returned',
        'reviewUnchanged',
    ])
        assert.equal(result[key], true, key);
    assert.deepEqual(result.fullText, { text: '1', frame: '0' });
    assert.deepEqual(result.partial, { text: '0.5', frame: '0.35' });
    assert.deepEqual(result.zero, { text: '0', frame: '0' });
    console.log('Answer visibility and local math smoke passed:', JSON.stringify(result));
};
