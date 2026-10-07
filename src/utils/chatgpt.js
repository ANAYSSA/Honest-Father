// ChatGPT credentials stay in the main process. IPC exposes account status only.
const { chatGPTModelInfo } = require('./historyModels');
let auth;
let responses;
let onDisconnect = () => {};

function getServices() {
    if (!auth) throw new Error('ChatGPT connection is not ready. Restart Honest Father.');
    return { auth, responses };
}

function setupChatGPT({ window, disconnected }) {
    const { app, ipcMain, net, shell, safeStorage } = require('electron');
    const { createChatGPTAuth } = require('./chatgptAuth');
    const { createChatGPTResponses, selectDefaultModel } = require('./chatgptResponses');
    const storage = require('../storage');
    const fetch = (input, init) => net.fetch(input, init);
    onDisconnect = disconnected;
    let identity = null;
    auth = createChatGPTAuth({
        fetch,
        openExternal: url => shell.openExternal(url),
        safeStorage,
        userDataPath: app.getPath('userData'),
        onChange(status) {
            const nextIdentity = status.connected ? status.activeAccountId || status.email : null;
            if (identity !== nextIdentity) {
                responses?.invalidateModels();
                onDisconnect();
                identity = nextIdentity;
            }
            const target = window();
            if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) {
                target.webContents.send('chatgpt-status-changed', status);
            }
        },
    });
    identity = auth.getStatus().connected ? auth.getStatus().activeAccountId || auth.getStatus().email : null;
    responses = createChatGPTResponses({ fetch, getAccessToken: options => auth.getAccessToken(options) });

    const trusted = event => {
        const target = window();
        return target && !target.isDestroyed() && event.sender === target.webContents && event.senderFrame === target.webContents.mainFrame;
    };
    const handle = (name, callback) =>
        ipcMain.handle(name, async (event, ...args) => {
            if (!trusted(event)) return { success: false, error: 'Untrusted ChatGPT request.' };
            try {
                return await callback(...args);
            } catch (error) {
                return { success: false, error: error.message || 'ChatGPT request failed.' };
            }
        });
    handle('chatgpt-status', () => auth.getStatus());
    handle('chatgpt-sign-in', async (options = {}) => {
        await auth.signIn({ newAccount: options?.newAccount === true, consent: auth.getStatus().connected && !auth.getStatus().planEnabled });
        return { success: true, ...auth.getStatus() };
    });
    handle('chatgpt-sign-out', async () => {
        onDisconnect();
        responses.invalidateModels();
        const result = await auth.signOut();
        return { success: true, ...result, warning: result?.remoteRevocationConfirmed === false ? result.error : undefined };
    });
    handle('chatgpt-models', async (options = {}) => {
        const models = await responses.listModels({ force: options?.force === true });
        const selected = storage.getConfig().chatgptModel;
        const selectedModel = models.some(model => model.id === selected) ? selected : selectDefaultModel(models);
        if (selectedModel !== selected) storage.updateConfig('chatgptModel', selectedModel);
        return { success: true, models, selectedModel };
    });
    app.once('will-quit', () => auth.dispose());
}

async function prepareChatGPT() {
    const { auth, responses } = getServices();
    if (!auth.getStatus().connected) throw new Error('Continue with ChatGPT in Home before starting.');
    if (!auth.getStatus().planEnabled) throw new Error('Enable ChatGPT plan usage in Home before starting.');
    const storage = require('../storage');
    const { selectDefaultModel } = require('./chatgptResponses');
    const models = await responses.listModels();
    const config = storage.getConfig();
    const selected = config.chatgptModel || selectDefaultModel(models);
    const model = models.find(item => item.id === selected);
    if (!model) throw new Error('This ChatGPT model is unavailable for the account. Select a model in Home.');
    if (config.chatgptReasoningMode === 'pro' && !model.supportsPro) throw new Error('Pro is unavailable for this model. Select Standard in Home.');
    const reasoningMode = config.chatgptReasoningMode === 'pro' ? 'pro' : 'standard';
    return { model: model.id, reasoningMode, modelInfo: chatGPTModelInfo(model, reasoningMode) };
}

function respond(options) {
    return getServices().responses.respond(options);
}

module.exports = { setupChatGPT, prepareChatGPT, respond };
