const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reviewOverlay', {
    onUpdate(callback) {
        if (typeof callback !== 'function') throw new TypeError('An update callback is required.');
        const listener = (_, payload) => callback(payload);
        ipcRenderer.on('review-overlay:update', listener);
        return () => ipcRenderer.removeListener('review-overlay:update', listener);
    },
});
