const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reviewOverlay', {
    onUpdate(callback) {
        if (typeof callback !== 'function') throw new TypeError('An update callback is required.');
        const listener = (_, payload) => {
            if (payload && typeof payload === 'object' && Object.hasOwn(payload, 'appearance')) {
                // This sandboxed preload cannot require the app's CommonJS helper.
                // Accept only the same bounded color/opacity contract from main.
                const value = payload.appearance;
                const color = typeof value?.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color) ? value.color.toLowerCase() : '#16a34a';
                const opacity =
                    typeof value?.opacity === 'number' && Number.isFinite(value.opacity) && value.opacity >= 0.1 && value.opacity <= 1
                        ? value.opacity
                        : 1;
                callback({ ...payload, appearance: { color, opacity } });
            } else callback(payload);
        };
        ipcRenderer.on('review-overlay:update', listener);
        return () => ipcRenderer.removeListener('review-overlay:update', listener);
    },
});
