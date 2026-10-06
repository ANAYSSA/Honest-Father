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
    let lastFailure = null;
    let latestRequest = 0;
    const cleanError = (error, fallback) => {
        // Electron's desktopCapturer rejects with a string on native source failures.
        const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : fallback;
        return (
            message
                .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 512) || fallback
        );
    };
    const isCurrentRequest = request => !mainWindow.isDestroyed() && request.videoRequested && request.frame === mainWindow.webContents.mainFrame;
    session.setDisplayMediaRequestHandler(
        async (request, callback) => {
            const requestId = ++latestRequest;
            lastFailure = null;
            const fail = (code, error, stage) => {
                if (requestId === latestRequest) lastFailure = { code, error, stage, at: Date.now() };
            };
            let streams = null;
            let stage = 'request';
            try {
                if (isCurrentRequest(request)) {
                    // macOS still enforces Screen Recording consent when enumerating/capturing sources.
                    stage = 'sources';
                    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
                    if (requestId === latestRequest && isCurrentRequest(request)) {
                        stage = 'source-selected';
                        const source = selectScreenSource(sources, screen, mainWindow);
                        if (source) {
                            onSourceSelected(source);
                            streams = { video: source };
                            if (platform === 'win32' && request.audioRequested) streams.audio = 'loopback';
                        } else {
                            fail('no_screen_sources', 'No screen capture sources are available.', 'sources');
                        }
                    } else {
                        fail('capture_cancelled', 'The screen capture window or request changed before a screen could be selected.', 'request');
                    }
                } else {
                    fail('invalid_request', 'Screen capture must be requested by the active application window with video enabled.', 'request');
                }
            } catch (error) {
                const message = cleanError(error, 'Screen capture could not start.');
                const code =
                    stage === 'sources' ? 'source_enumeration_failed' : stage === 'source-selected' ? 'source_selection_failed' : 'invalid_request';
                fail(code, message, stage);
                logger.warn('Screen capture could not start:', message);
            }
            try {
                callback(streams);
                if (streams && requestId === latestRequest) lastFailure = null;
            } catch (error) {
                // The frame can disappear while Electron is enumerating the displays.
                const message = cleanError(error, 'The screen capture request ended before it could be granted.');
                fail('capture_callback_failed', message, 'callback');
                logger.warn('Screen capture request ended:', message);
            }
        },
        // On macOS 15+, true bypasses this handler and opens Apple's screen chooser.
        { useSystemPicker: false }
    );
    return { getLastFailure: () => (lastFailure ? { ...lastFailure } : null) };
}

module.exports = { selectScreenSource, registerAutomaticScreenCapture };
