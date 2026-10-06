const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { releaseSigningIdentity, releaseRequirement } = require('./mac-signing');
const { verifyMacApp } = require('./verify-macos-app');

const appPath = path.resolve(process.argv[2] || path.join('out', `Honest Father-darwin-${process.arch}`, 'Honest Father.app'));
verifyMacApp(appPath, { requireStableSigning: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-signature-stability-'));
const copy = path.join(temporary, 'Honest Father.app');
const readRequirement = app => execFileSync('codesign', ['-dr', '-', app], { encoding: 'utf8' }).trim();
const readHash = app => {
    const output = spawnSync('codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8' });
    assert.equal(output.status, 0);
    const hash = /CDHash=([a-f0-9]+)/i.exec(output.stderr);
    assert.ok(hash, 'The actual code signature has a code hash');
    return hash[1];
};
try {
    fs.cpSync(appPath, copy, { recursive: true, verbatimSymlinks: true });
    const before = readRequirement(appPath);
    const beforeHash = readHash(appPath);
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleVersion 999.999.999', path.join(copy, 'Contents', 'Info.plist')]);
    execFileSync(
        'codesign',
        ['--force', '--sign', releaseSigningIdentity, '--timestamp=none', '--requirements', `=designated => ${releaseRequirement}`, copy],
        { stdio: 'inherit' }
    );
    verifyMacApp(copy, { requireStableSigning: true });
    assert.notEqual(readHash(copy), beforeHash, 'Changing the version produces a different signed code hash');
    assert.equal(readRequirement(copy), before, 'The app identity stays identical across an updated build');
    execFileSync('codesign', ['--verify', '--strict', `-R=${before.replace(/^designated => /, '')}`, copy], { stdio: 'inherit' });
    console.log('macOS signing stability passed: different code hashes, identical certificate-bound app identity.');
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
