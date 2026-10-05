function createShutdownHandler({ closeActiveSession, stopAudioCapture, closeLocalSession, unregisterShortcuts, logger = console }) {
    let shuttingDown = false;
    return function shutdown() {
        if (shuttingDown) return;
        shuttingDown = true;
        // Keep cleanup independent: a broken session must not leave native helpers running.
        for (const [name, cleanup] of Object.entries({ closeActiveSession, stopAudioCapture, closeLocalSession, unregisterShortcuts })) {
            try {
                Promise.resolve(cleanup()).catch(error => logger.error(`Shutdown ${name} failed:`, error));
            } catch (error) {
                logger.error(`Shutdown ${name} failed:`, error);
            }
        }
    };
}

module.exports = { createShutdownHandler };
