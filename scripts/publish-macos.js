// Publish only certificate-signed Mac packages after both CI builds have passed.
// This script uses the local keychain-signed output; it never exports the key.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { version } = require('../package.json');
const { verifyMacApp } = require('./verify-macos-app');
const [tag, runId] = process.argv.slice(2);
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.equal(tag, `v${version}`, 'The tag must match the packaged version');
assert.match(runId || '', /^\d+$/, 'Supply the successful GitHub build run ID');
const root = path.resolve(__dirname, '..');
const command = (name, args) => execFileSync(name, args, { cwd: root, encoding: 'utf8' }).trim();
const repository = 'CyberKotletochka/Honest-Father';
const sourceSha = command('git', ['rev-parse', `${tag}^{commit}`]);
assert.equal(command('git', ['rev-parse', 'HEAD']), sourceSha, 'Build and publish from the exact release tag');
assert.equal(command('git', ['status', '--porcelain']), '', 'Tracked release source must be clean');
const run = JSON.parse(command('gh', ['api', `repos/${repository}/actions/runs/${runId}`]));
assert.equal(run.head_sha, sourceSha);
assert.equal(run.head_branch, tag);
assert.equal(run.event, 'push');
assert.equal(run.path, '.github/workflows/build.yml');
assert.equal(run.conclusion, 'success');
const jobs = JSON.parse(command('gh', ['api', `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`])).jobs;
for (const platform of ['darwin / arm64', 'win32 / x64']) {
    assert.ok(
        jobs.some(job => job.name === platform && job.status === 'completed' && job.conclusion === 'success'),
        `${platform} must pass`
    );
}
const referenceApp = path.join(root, 'out/Honest Father-darwin-arm64/Honest Father.app');
function verifyPublishedApp(bundle) {
    verifyMacApp(bundle, { requireStableSigning: true });
    const plist = path.join(bundle, 'Contents', 'Info.plist');
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
        assert.equal(command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]), version, `Wrong packaged ${key}`);
    }
}
function asarHash(bundle) {
    return crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(bundle, 'Contents', 'Resources', 'app.asar')))
        .digest('hex');
}
verifyPublishedApp(referenceApp);
const referenceAsarHash = asarHash(referenceApp);
const prefix = `Honest-Father-${version}-macos-arm64`;
const directory = path.join(root, 'out/releases');
const manifest = `${prefix}-SHA256SUMS.txt`;
const lines = fs.readFileSync(path.join(directory, manifest), 'utf8').trim().split('\n');
assert.equal(lines.length, 2);
const files = new Set([`${prefix}.dmg`, `${prefix}.zip`]);
for (const line of lines) {
    const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line);
    assert.ok(match && files.has(match[2]), 'Only the versioned Mac DMG/ZIP may be published');
    const digest = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(directory, match[2])))
        .digest('hex');
    assert.equal(digest, match[1]);
    files.delete(match[2]);
}
assert.equal(files.size, 0);
// Validate the apps inside the exact archives being uploaded. Verifying the
// unpackaged output alone can allow stale ad-hoc packages through publication.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-release-verification-'));
const zipDirectory = path.join(temporary, 'zip');
const mountPoint = path.join(temporary, 'dmg');
let mounted = false;
try {
    fs.mkdirSync(zipDirectory);
    fs.mkdirSync(mountPoint);
    command('/usr/bin/ditto', ['-x', '-k', path.join(directory, `${prefix}.zip`), zipDirectory]);
    const zipApp = path.join(zipDirectory, 'Honest Father.app');
    verifyPublishedApp(zipApp);
    assert.equal(asarHash(zipApp), referenceAsarHash, 'ZIP app code must match the verified release output');
    command('/usr/bin/hdiutil', [
        'attach',
        path.join(directory, `${prefix}.dmg`),
        '-readonly',
        '-nobrowse',
        '-noautoopen',
        '-mountpoint',
        mountPoint,
    ]);
    mounted = true;
    const dmgApp = path.join(mountPoint, 'Honest Father.app');
    verifyPublishedApp(dmgApp);
    assert.equal(asarHash(dmgApp), referenceAsarHash, 'DMG app code must match the verified release output');
} finally {
    if (mounted) {
        try {
            command('/usr/bin/hdiutil', ['detach', mountPoint]);
        } catch {
            // Only detach the mount point created above. If both attempts fail,
            // leave the directory intact rather than deleting a mounted volume.
            command('/usr/bin/hdiutil', ['detach', mountPoint, '-force']);
        }
    }
    fs.rmSync(temporary, { recursive: true, force: true });
}
command('gh', ['release', 'view', tag, '-R', repository]);
execFileSync(
    'gh',
    [
        'release',
        'upload',
        tag,
        '-R',
        repository,
        ...[`${prefix}.dmg`, `${prefix}.zip`, manifest].map(name => path.join(directory, name)),
        '--clobber',
    ],
    { cwd: root, stdio: 'inherit' }
);
console.log(`Published certificate-signed macOS assets for ${tag}.`);
