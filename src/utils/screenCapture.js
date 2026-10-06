function selectScreenSource(sources, screen, mainWindow) {
    if (!sources.length) return null;

    // Match Electron display IDs, not the ordinal embedded in a capture source ID.
    if (mainWindow && !mainWindow.isDestroyed()) {
        const display = screen.getDisplayMatching(mainWindow.getBounds());
        const source = sources.find(item => item.display_id === String(display.id));
        if (source) return source;
    }
    const primaryId = String(screen.getPrimaryDisplay().id);
    return sources.find(item => item.display_id === primaryId) || sources[0];
}

function registerAutomaticScreenCapture(
    session,
    { desktopCapturer, screen, mainWindow, onSourceSelected = () => {}, platform = process.platform, logger = console }
) {
    const isCurrentRequest = request => !mainWindow.isDestroyed() && request.videoRequested && request.frame === mainWindow.webContents.mainFrame;
    session.setDisplayMediaRequestHandler(
        async (request, callback) => {
            let streams = null;
            try {
                if (isCurrentRequest(request)) {
                    // macOS still enforces Screen Recording consent when enumerating/capturing sources.
                    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
                    if (isCurrentRequest(request)) {
                        const source = selectScreenSource(sources, screen, mainWindow);
                        if (source) {
                            onSourceSelected(source);
                            streams = { video: source };
                            if (platform === 'win32' && request.audioRequested) streams.audio = 'loopback';
                        }
                    }
                }
            } catch (error) {
                logger.warn('Screen capture could not start:', error.message);
            }
            try {
                callback(streams);
            } catch (error) {
                // The frame can disappear while Electron is enumerating the displays.
                logger.warn('Screen capture request ended:', error.message);
            }
        },
        // On macOS 15+, true bypasses this handler and opens Apple's screen chooser.
        { useSystemPicker: false }
    );
}

module.exports = { selectScreenSource, registerAutomaticScreenCapture };
