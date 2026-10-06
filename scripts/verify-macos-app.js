const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { releaseRequirement } = require('./mac-signing');

function verifyMacApp(appPath, { requireStableSigning = process.env.HONEST_FATHER_RELEASE_SIGNING === '1' } = {}) {
    assert.equal(process.platform, 'darwin', 'macOS signature verification requires macOS');
    const bundle = path.resolve(appPath);
    const plistPath = path.join(bundle, 'Contents', 'Info.plist');
    assert.ok(fs.existsSync(plistPath), `Missing packaged app: ${bundle}`);
    for (const [key, expected] of Object.entries({
        CFBundleIdentifier: 'com.anayssa.honestfather',
        CFBundleDisplayName: 'Honest Father',
        CFBundleExecutable: 'Honest Father',
        LSUIElement: 'true',
    })) {
        const actual = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], { encoding: 'utf8' }).trim();
        assert.equal(actual, expected, `Unexpected packaged ${key}`);
    }
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '-R=identifier "com.anayssa.honestfather"', bundle], { stdio: 'inherit' });
    if (requireStableSigning) {
        execFileSync('/usr/bin/codesign', ['--verify', '--strict', `-R=${releaseRequirement}`, bundle], { stdio: 'inherit' });
        const designated = execFileSync('/usr/bin/codesign', ['-dr', '-', bundle], { encoding: 'utf8' });
        // codesign renders certificate hashes in lowercase. Preserve every
        // predicate and identifier; a broader DR must never pass by substring.
        const normalizeHex = requirement => requirement.replace(/H"([0-9a-fA-F]+)"/g, (_, hex) => `H"${hex.toUpperCase()}"`);
        assert.equal(
            normalizeHex(designated.trim()),
            normalizeHex(`designated => ${releaseRequirement}`),
            'Published Mac app must use the stable certificate and app identifier requirement'
        );
        assert.doesNotMatch(designated, /\bcdhash\b/, 'Published Mac permission identity must not change with each build');
    }
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
