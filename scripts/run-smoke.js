// The parent owns temporary storage so Chromium never deletes files it still has open.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electronPath = require('electron');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-father-smoke-'));
const child = spawn(electronPath, [path.join(__dirname, 'smoke.js')], {
    stdio: 'inherit',
    env: { ...process.env, HONEST_FATHER_SMOKE_HOME: temporary },
});
let timedOut = false;
const deadline = setTimeout(() => {
    timedOut = true;
    console.error('Electron process did not exit within 45 seconds.');
    child.kill();
}, 45000);
function cleanup() {
    clearTimeout(deadline);
    try {
        fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
        console.warn('Could not remove isolated smoke storage:', error.message);
    }
}
child.once('error', error => {
    cleanup();
    console.error('Could not launch Electron:', error.message);
    process.exitCode = 1;
});
child.once('exit', (code, signal) => {
    cleanup();
    console.log('Electron process exited:', code, signal || '');
    process.exitCode = timedOut || signal ? 1 : (code ?? 1);
});
