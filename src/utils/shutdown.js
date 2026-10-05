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

function createQuitController({ shutdown, exit, timeoutMs = 2000, schedule = setTimeout, cancel = clearTimeout, logger = console }) {
    let quitting = false;
    let deadline = null;

    function beginQuit() {
        if (quitting) return;
        quitting = true;
        // will-quit only means the windows closed. Keep this deadline until the process
        // actually exits so a stuck renderer/transport cannot leave the app running.
        deadline = schedule(() => {
            deadline = null;
            logger.warn(`Quit did not finish within ${timeoutMs} ms; closing the application.`);
            exit(0);
        }, timeoutMs);
        // A healthy quit should exit immediately rather than wait for this timer.
        deadline?.unref?.();
        try {
            Promise.resolve(shutdown()).catch(error => logger.error('Application cleanup failed:', error));
        } catch (error) {
            logger.error('Application cleanup failed:', error);
        }
    }

    function processExited() {
        if (deadline !== null) cancel(deadline);
        deadline = null;
    }

    return { beginQuit, processExited, isQuitting: () => quitting };
}

module.exports = { createShutdownHandler, createQuitController };
