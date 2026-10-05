const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function verifyMacApp(appPath) {
    assert.equal(process.platform, 'darwin', 'macOS signature verification requires macOS');
    const bundle = path.resolve(appPath);
    const plistPath = path.join(bundle, 'Contents', 'Info.plist');
    assert.ok(fs.existsSync(plistPath), `Missing packaged app: ${bundle}`);
    for (const [key, expected] of Object.entries({
        CFBundleIdentifier: 'com.anayssa.honestfather',
        CFBundleDisplayName: 'Honest Father',
        CFBundleExecutable: 'Honest Father',
    })) {
        const actual = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], { encoding: 'utf8' }).trim();
        assert.equal(actual, expected, `Unexpected packaged ${key}`);
    }
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '-R=identifier "com.anayssa.honestfather"', bundle], { stdio: 'inherit' });
    // Resources are sealed by the bundle, but the standalone Swift executable also
    // needs its own valid Mach-O signature before Apple Silicon will execute it.
    const audioHelper = path.join(bundle, 'Contents', 'Resources', 'SystemAudioDump');
    assert.ok(fs.existsSync(audioHelper), 'System audio helper is missing');
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', audioHelper], { stdio: 'inherit' });
    console.log(`Packaged macOS signatures verified: ${bundle}`);
}

if (require.main === module) {
    const appPath = process.argv[2] || path.join('out', `Honest Father-darwin-${process.arch}`, 'Honest Father.app');
    verifyMacApp(appPath);
}

module.exports = { verifyMacApp };
