function clearSavedHistory({ event, window, storage, resetSavedHistory }) {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        return { success: false, error: 'Untrusted history request.' };
    }
    if (!storage.deleteAllSessions()) return { success: false, error: 'Could not clear all history. Please try again.' };
    // Discard saved-entry buffers, not account configuration or active provider credentials.
    // Storage rejects older queued renderer saves using its history epoch.
    resetSavedHistory();
    return { success: true };
}

function copyHistoryResponse({ event, window, clipboard, payload }) {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        return { success: false, error: 'Untrusted clipboard request.' };
    }
    if (
        !payload ||
        typeof payload.text !== 'string' ||
        typeof payload.html !== 'string' ||
        payload.text.length > 1024 * 1024 ||
        payload.html.length > 4 * 1024 * 1024
    ) {
        return { success: false, error: 'Invalid or oversized response to copy.' };
    }
    clipboard.write({ text: payload.text, html: payload.html });
    return { success: true };
}

module.exports = { clearSavedHistory, copyHistoryResponse };
