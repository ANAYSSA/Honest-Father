// Reconstruct an already signed release app. This script never packages the
// application, invokes codesign --sign, or accesses a private signing key.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const repository = 'ANAYSSA/Honest-Father';
const hashPattern = /^[a-f0-9]{64}$/;
const command = (root, binary, args) => execFileSync(binary, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const bytesHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validateInputs(env) {
    assert.equal(env.GH_REPO, repository, 'Publication must stay in the Honest Father repository');
    assert.match(env.HF_TAG || '', /^v\d+\.\d+\.\d+$/, 'Supply an exact existing version tag');
    assert.match(env.HF_RUN_ID || '', /^[1-9]\d*$/, 'Supply the successful build run ID');
    assert.match(env.HF_MANIFEST_SHA || '', hashPattern, 'Supply the locally verified signed-app manifest SHA-256');
    return { tag: env.HF_TAG, runId: env.HF_RUN_ID, manifestSHA256: env.HF_MANIFEST_SHA };
}

function validateRun(run, jobs, context) {
    assert.equal(String(run.id), context.runId, 'The CI run ID must match the dispatch');
    assert.equal(run.head_repository?.full_name, repository, 'The baseline must come from this repository');
    assert.equal(run.path, '.github/workflows/build.yml');
    assert.equal(run.name, 'Build Honest Father');
    assert.equal(run.event, 'push');
    assert.equal(run.head_branch, context.tag);
    assert.equal(run.head_sha, context.sourceSha);
    assert.equal(run.status, 'completed');
    assert.equal(run.conclusion, 'success');
    for (const name of ['darwin / arm64', 'win32 / x64']) {
        const matching = jobs.filter(job => job.name === name);
        assert.equal(matching.length, 1, `Expected exactly one latest ${name} job`);
        assert.equal(matching[0].status, 'completed', `${name} must finish`);
        assert.equal(matching[0].conclusion, 'success', `${name} must pass`);
    }
}

function validateRelativePath(value) {
    assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 1024, 'Invalid relative path');
    assert.ok(!path.posix.isAbsolute(value) && !/[\\\u0000-\u001f\u007f]/.test(value), 'Paths must remain inside the app');
    assert.ok(
        value.split('/').every(part => part && part !== '.' && part !== '..'),
        'Paths must be canonical and cannot escape'
    );
}

function validateTargetEntries(entries) {
    assert.ok(Array.isArray(entries) && entries.length > 0 && entries.length <= 10000, 'Invalid target app tree');
    const seen = new Map();
    let previous = '';
    for (const entry of entries) {
        validateRelativePath(entry.path);
        assert.ok(entry.path > previous, 'The target tree must be sorted by path without duplicates');
        previous = entry.path;
        assert.ok(['file', 'directory', 'symlink'].includes(entry.type), 'Unsupported app tree entry type');
        assert.ok(Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o7777, 'Invalid app file permissions');
        const keys = ['path', 'type', 'mode', ...(entry.type === 'file' ? ['sha256'] : entry.type === 'symlink' ? ['link'] : [])];
        assert.deepEqual(Object.keys(entry), keys, 'App tree descriptors must use the exact canonical field order');
        if (entry.type === 'file') assert.match(entry.sha256 || '', hashPattern, 'Invalid target app file hash');
        if (entry.type === 'symlink') {
            assert.ok(typeof entry.link === 'string' && entry.link && !/[\\\u0000-\u001f\u007f]/.test(entry.link), 'Invalid symlink target');
            assert.ok(!path.posix.isAbsolute(entry.link), 'App symlinks must be relative');
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), entry.link));
            assert.ok(resolved !== '..' && !resolved.startsWith('../'), 'App symlinks must stay inside the app');
        }
        const parent = path.posix.dirname(entry.path);
        if (parent !== '.') assert.equal(seen.get(parent)?.type, 'directory', 'Every entry must have a real parent directory');
        seen.set(entry.path, entry);
    }
    return seen;
}

function validateManifest(manifest, context, rawBytes) {
    assert.equal(bytesHash(rawBytes), context.manifestSHA256, 'The manifest must match the independently pinned local manifest');
    assert.deepEqual(
        Object.keys(manifest).sort(),
        ['format', 'version', 'runId', 'sourceSha', 'baseSHA256', 'files', 'targetEntries', 'targetTreeSHA256'].sort(),
        'Unexpected delta metadata fields'
    );
    assert.equal(manifest.format, 'honest-father-macos-files-bsdiff-v1');
    assert.equal(manifest.version, context.version);
    assert.equal(manifest.runId, context.runId);
    assert.equal(manifest.sourceSha, context.sourceSha);
    for (const key of ['baseSHA256', 'targetTreeSHA256']) assert.match(manifest[key] || '', hashPattern, `Invalid ${key}`);
    const entries = validateTargetEntries(manifest.targetEntries);
    assert.equal(
        bytesHash(JSON.stringify(manifest.targetEntries)),
        manifest.targetTreeSHA256,
        'Target tree hash must match the canonical descriptors'
    );
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= entries.size, 'Invalid file patch list');
    const paths = new Set(),
        patches = new Set();
    for (const file of manifest.files) {
        assert.deepEqual(Object.keys(file).sort(), ['path', 'baseSHA256', 'targetSHA256', 'patchSHA256', 'patchName', 'size', 'mode'].sort());
        validateRelativePath(file.path);
        assert.ok(!paths.has(file.path) && !patches.has(file.patchName), 'Duplicate patched path or patch name');
        paths.add(file.path);
        patches.add(file.patchName);
        assert.match(file.patchName || '', /^[0-9]{4}\.bsdiff$/, 'Invalid patch archive filename');
        for (const key of ['baseSHA256', 'targetSHA256', 'patchSHA256']) assert.match(file[key] || '', hashPattern, `Invalid patched file ${key}`);
        assert.ok(Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 1024 * 1024 * 1024, 'Invalid target file size');
        const target = entries.get(file.path);
        assert.equal(target?.type, 'file', 'Only regular target app files may be patched');
        assert.equal(file.mode, target.mode, 'Patched permissions must match the full target tree');
        assert.equal(file.targetSHA256, target.sha256, 'Patched bytes must match the full target tree');
    }
}

function appTree(bundle) {
    const entries = [];
    function walk(relative) {
        for (const name of fs.readdirSync(path.join(bundle, relative))) {
            const item = relative ? `${relative}/${name}` : name;
            validateRelativePath(item);
            const file = path.join(bundle, item),
                stat = fs.lstatSync(file);
            const entry = {
                path: item,
                type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
                mode: stat.mode & 0o7777,
            };
            assert.ok(stat.isSymbolicLink() || stat.isDirectory() || stat.isFile(), 'Unsupported app filesystem entry');
            if (entry.type === 'file') entry.sha256 = fileHash(file);
            if (entry.type === 'symlink') entry.link = fs.readlinkSync(file);
            entries.push(entry);
            if (entry.type === 'directory') walk(item);
        }
    }
    walk('');
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function verifyAppTree(bundle, manifest) {
    const actual = appTree(bundle);
    assert.equal(bytesHash(JSON.stringify(actual)), manifest.targetTreeSHA256, 'The entire app must match the locally verified signed app');
    assert.deepEqual(actual, manifest.targetEntries, 'The app must contain exactly the signed files, directories, modes and symlinks');
}

function resolvePatchFile(bundle, relative) {
    validateRelativePath(relative);
    const parts = relative.split('/');
    let current = bundle;
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        const stat = fs.lstatSync(current);
        assert.ok(index === parts.length - 1 ? stat.isFile() : stat.isDirectory(), 'Patch paths must not follow symlinks or non-files');
    }
    return current;
}

function archiveMember(root, archive, member) {
    // Stream one member to memory; never let tar write filesystem paths or links.
    return execFileSync('/usr/bin/tar', ['-xOf', archive, member], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
}

function readDelta(root, archive, context) {
    const rawBytes = archiveMember(root, archive, 'manifest.json');
    assert.ok(rawBytes.length <= 2 * 1024 * 1024, 'The delta manifest is too large');
    const manifest = JSON.parse(rawBytes.toString('utf8'));
    validateManifest(manifest, context, rawBytes);
    const members = command(root, '/usr/bin/tar', ['-tzf', archive]).split('\n');
    const expected = new Set(['manifest.json', ...manifest.files.map(file => `patches/${file.patchName}`)]);
    const seen = new Set();
    for (const member of members) {
        if (member === 'patches' || member === 'patches/') continue;
        assert.ok(expected.has(member) && !seen.has(member), 'Unexpected or duplicate delta archive member');
        seen.add(member);
    }
    assert.equal(seen.size, expected.size, 'The delta archive must contain every expected patch');
    return manifest;
}

function normalizeRequirement(requirement) {
    // Only certificate hash case is cosmetic. Do not accept additional predicates
    // or a cdhash-based identity by substring matching.
    return requirement.trim().replace(/H"([a-f0-9]+)"/gi, (_, hex) => `H"${hex.toUpperCase()}"`);
}

function assertExactRequirement(actual, expected) {
    assert.equal(normalizeRequirement(actual), normalizeRequirement(`designated => ${expected}`), 'The app must have the exact certificate-bound DR');
    assert.doesNotMatch(actual, /\bcdhash\b/i, 'The app permission identity must survive updates');
}

function validateZipEntries(entries) {
    assert.ok(entries.length > 0, 'The signed ZIP is empty');
    assert.ok(
        entries.some(entry => entry === 'Honest Father.app/Contents/Info.plist'),
        'The signed ZIP must contain the expected app root'
    );
    for (const entry of entries) {
        assert.ok(entry.startsWith('Honest Father.app/'), 'The signed ZIP may contain only Honest Father.app');
        assert.ok(!/[\\\u0000-\u001f\u007f]/.test(entry), 'Invalid signed ZIP entry');
        assert.ok(!entry.split('/').includes('..'), 'The signed ZIP must not escape its extraction directory');
    }
}

function validate(root, env = process.env) {
    const context = validateInputs(env);
    assert.equal(process.platform, 'darwin', 'Use the macOS release runner');
    assert.equal(process.arch, 'arm64', 'Use the Apple Silicon release runner');
    context.sourceSha = command(root, 'git', ['rev-parse', `refs/tags/${context.tag}^{commit}`]);
    assert.match(context.sourceSha, /^[a-f0-9]{40}$/);
    context.packageJSON = JSON.parse(command(root, 'git', ['show', `${context.sourceSha}:package.json`]));
    context.version = context.packageJSON.version;
    assert.equal(context.tag, `v${context.version}`, 'The tag and source package version must match');
    assert.equal(
        JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
        context.version,
        'The publication checkout must retain the target version for artifact collection'
    );
    const run = JSON.parse(command(root, 'gh', ['api', `repos/${repository}/actions/runs/${context.runId}`]));
    const jobs = JSON.parse(command(root, 'gh', ['api', `repos/${repository}/actions/runs/${context.runId}/jobs?per_page=100`])).jobs;
    validateRun(run, jobs, context);
    // Bind verification to the public certificate in the exact source tag, even
    // though the publishing workflow itself runs from a later commit.
    const publicCertificate = command(root, 'git', ['show', `${context.sourceSha}:build/honest-father-signing.pem`]);
    const identity = new crypto.X509Certificate(publicCertificate).fingerprint.replaceAll(':', '').toUpperCase();
    assert.match(identity, /^[A-F0-9]{40}$/);
    context.releaseRequirement = `identifier "com.anayssa.honestfather" and certificate leaf = H"${identity}"`;
    const { releaseRequirement } = require(path.join(root, 'scripts/mac-signing'));
    assert.equal(releaseRequirement, context.releaseRequirement, 'The publication checkout must pin the same public release certificate');
    context.prefix = `Honest-Father-${context.version}-macos-arm64`;
    console.log(`Verified successful source build ${context.runId} for ${context.tag} (${context.sourceSha}).`);
    return context;
}

function verifyPublishedApp(root, bundle, context) {
    const { verifyMacApp } = require(path.join(root, 'scripts/verify-macos-app'));
    verifyMacApp(bundle, { requireStableSigning: true });
    const plist = path.join(bundle, 'Contents/Info.plist');
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
        assert.equal(command(root, '/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]), context.version, `Wrong packaged ${key}`);
    }
    assertExactRequirement(command(root, '/usr/bin/codesign', ['-dr', '-', bundle]), context.releaseRequirement);
}

async function prepare(root, context) {
    const downloadDirectory = path.join(root, 'work/keyless-publication-downloads');
    const deltaDirectory = path.join(downloadDirectory, 'delta');
    fs.mkdirSync(deltaDirectory, { recursive: true });
    const archiveName = `${context.prefix}.signed-files.tar.gz`;
    command(root, 'gh', ['release', 'download', context.tag, '-R', repository, '--pattern', archiveName, '--dir', deltaDirectory]);
    const archive = path.join(deltaDirectory, archiveName);
    const manifest = readDelta(root, archive, context);
    const baseline = path.join(downloadDirectory, 'base', `${context.prefix}.zip`);
    assert.equal(fileHash(baseline), manifest.baseSHA256, 'The CI baseline ZIP hash must match');
    validateZipEntries(command(root, '/usr/bin/unzip', ['-Z1', baseline]).split('\n'));

    const makeDirectory = path.join(root, 'out/make');
    const packagedDirectory = path.join(root, 'out/Honest Father-darwin-arm64');
    assert.ok(!fs.existsSync(makeDirectory), 'Packaging output must start empty');
    assert.ok(!fs.existsSync(packagedDirectory), 'App extraction output must start empty');
    assert.ok(!fs.existsSync(path.join(root, 'out/releases')), 'Release collection output must start empty');
    fs.mkdirSync(packagedDirectory, { recursive: true });
    command(root, '/usr/bin/ditto', ['-x', '-k', baseline, packagedDirectory]);
    const bundle = path.join(packagedDirectory, 'Honest Father.app');
    for (const file of manifest.files) {
        const appFile = resolvePatchFile(bundle, file.path);
        assert.equal(fileHash(appFile), file.baseSHA256, `Baseline file hash must match: ${file.path}`);
        const patchBytes = archiveMember(root, archive, `patches/${file.patchName}`);
        assert.equal(bytesHash(patchBytes), file.patchSHA256, `Patch hash must match: ${file.path}`);
        assert.equal(patchBytes.subarray(0, 8).toString('ascii'), 'BSDIFF40', 'Use the system bspatch-compatible delta format');
        const patchFile = path.join(deltaDirectory, file.patchName);
        fs.writeFileSync(patchFile, patchBytes, { flag: 'wx' });
        const restoredFile = `${appFile}.honest-release-patch`;
        assert.ok(!fs.existsSync(restoredFile), 'Temporary patch output must not overwrite an existing file');
        command(root, '/usr/bin/bspatch', [appFile, restoredFile, patchFile]);
        assert.equal(fs.statSync(restoredFile).size, file.size, `Restored file size must match: ${file.path}`);
        assert.equal(fileHash(restoredFile), file.targetSHA256, `Restored signed file hash must match: ${file.path}`);
        fs.chmodSync(restoredFile, file.mode);
        fs.renameSync(restoredFile, appFile);
    }
    // Archive extraction may use a different umask. Restore the pinned ordinary
    // entry modes without ever following a symlink, then compare the whole tree.
    for (const entry of manifest.targetEntries) {
        if (entry.type === 'symlink') continue;
        const item = path.join(bundle, entry.path);
        const stat = fs.lstatSync(item);
        assert.ok(entry.type === 'directory' ? stat.isDirectory() : stat.isFile(), 'Restored entry type must match before chmod');
        fs.chmodSync(item, entry.mode);
    }
    verifyAppTree(bundle, manifest);
    verifyPublishedApp(root, bundle, context);

    // Call only the existing container makers. No Forge package/sign/build hooks run.
    const [{ MakerZIP }, { MakerDMG }] = await Promise.all([import('@electron-forge/maker-zip'), import('@electron-forge/maker-dmg')]);
    const makerOptions = {
        dir: packagedDirectory,
        makeDir: makeDirectory,
        appName: 'Honest Father',
        packageJSON: context.packageJSON,
        targetArch: 'arm64',
        targetPlatform: 'darwin',
        forgeConfig: {},
    };
    const zipMaker = new MakerZIP({}, ['darwin']);
    const dmgMaker = new MakerDMG({ name: 'Honest Father', format: 'ULFO' }, ['darwin']);
    for (const maker of [zipMaker, dmgMaker]) {
        assert.ok(maker.isSupportedOnCurrentPlatform());
        maker.ensureExternalBinariesExist();
        await maker.prepareConfig('arm64');
    }
    const zipArtifacts = await zipMaker.make(makerOptions);
    const dmgArtifacts = await dmgMaker.make(makerOptions);
    assert.equal(zipArtifacts.length, 1, 'The maker must produce exactly one ZIP');
    assert.equal(dmgArtifacts.length, 1, 'The maker must produce exactly one DMG');
    verifyAppTree(bundle, manifest);
    verifyPublishedApp(root, bundle, context);

    const zipCheck = path.join(downloadDirectory, 'zip-check');
    fs.mkdirSync(zipCheck);
    validateZipEntries(command(root, '/usr/bin/unzip', ['-Z1', zipArtifacts[0]]).split('\n'));
    command(root, '/usr/bin/ditto', ['-x', '-k', zipArtifacts[0], zipCheck]);
    const zipBundle = path.join(zipCheck, 'Honest Father.app');
    verifyAppTree(zipBundle, manifest);
    verifyPublishedApp(root, zipBundle, context);

    const mountpoint = path.join(downloadDirectory, 'dmg-mount');
    fs.mkdirSync(mountpoint);
    let mounted = false;
    try {
        command(root, '/usr/bin/hdiutil', ['verify', dmgArtifacts[0]]);
        command(root, '/usr/bin/hdiutil', ['attach', dmgArtifacts[0], '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint]);
        mounted = true;
        const dmgBundle = path.join(mountpoint, 'Honest Father.app');
        verifyAppTree(dmgBundle, manifest);
        verifyPublishedApp(root, dmgBundle, context);
    } finally {
        if (mounted) {
            try {
                command(root, '/usr/bin/hdiutil', ['detach', mountpoint]);
            } catch {
                command(root, '/usr/bin/hdiutil', ['detach', mountpoint, '-force']);
            }
        }
    }
    command(root, process.execPath, [path.join(root, 'scripts/collect-artifacts.js'), 'darwin', 'arm64']);
    const files = verifyReleaseFiles(root, context);
    const receipt = {
        tag: context.tag,
        sourceSha: context.sourceSha,
        manifestSHA256: context.manifestSHA256,
        targetTreeSHA256: manifest.targetTreeSHA256,
        files: files.map(file => ({ name: path.basename(file), sha256: fileHash(file) })),
    };
    fs.writeFileSync(path.join(downloadDirectory, 'verified-assets.json'), JSON.stringify(receipt) + '\n', { flag: 'wx' });
    console.log('The complete signed app tree, ZIP and DMG are verified; only the final upload remains.');
}
function verifyReleaseFiles(root, context) {
    const directory = path.join(root, 'out/releases');
    const names = [`${context.prefix}.dmg`, `${context.prefix}.zip`, `${context.prefix}-SHA256SUMS.txt`];
    assert.deepEqual(fs.readdirSync(directory).sort(), [...names].sort(), 'Only the three versioned Mac files may be uploaded');
    const expectedFiles = new Set(names.slice(0, 2));
    const lines = fs.readFileSync(path.join(directory, names[2]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) {
        const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
        assert.ok(match && expectedFiles.has(match[2]), 'Unexpected release checksum entry');
        assert.equal(fileHash(path.join(directory, match[2])), match[1], 'Collected file checksum must match');
        expectedFiles.delete(match[2]);
    }
    assert.equal(expectedFiles.size, 0);
    return names.map(name => path.join(directory, name));
}

function publish(root, context) {
    const files = verifyReleaseFiles(root, context);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'work/keyless-publication-downloads/verified-assets.json'), 'utf8'));
    assert.equal(receipt.tag, context.tag);
    assert.equal(receipt.sourceSha, context.sourceSha);
    assert.equal(receipt.manifestSHA256, context.manifestSHA256);
    assert.deepEqual(
        receipt.files,
        files.map(file => ({ name: path.basename(file), sha256: fileHash(file) })),
        'Uploaded containers must be the exact files verified during preparation'
    );
    command(root, 'gh', ['release', 'view', context.tag, '-R', repository]);
    execFileSync('gh', ['release', 'upload', context.tag, '-R', repository, ...files, '--clobber'], { cwd: root, stdio: 'inherit' });
    console.log(`Published the verified signed Mac ZIP, DMG and checksums for ${context.tag}.`);
}

async function main() {
    const [mode, ...extra] = process.argv.slice(2);
    assert.ok(['validate', 'prepare', 'publish'].includes(mode) && extra.length === 0, 'Use validate, prepare or publish');
    const root = path.resolve(__dirname, '..');
    const context = validate(root);
    if (mode === 'prepare') await prepare(root, context);
    if (mode === 'publish') publish(root, context);
}

if (require.main === module)
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
module.exports = {
    validateInputs,
    validateRun,
    validateManifest,
    assertExactRequirement,
    validateZipEntries,
    verifyReleaseFiles,
    validateRelativePath,
    validateTargetEntries,
    appTree,
    verifyAppTree,
    resolvePatchFile,
    readDelta,
};
