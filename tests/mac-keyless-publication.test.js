// Pure proposal checks: no GitHub calls, app launch, media, signing or uploads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
    validateInputs,
    validateRun,
    validateManifest,
    assertExactRequirement,
    validateZipEntries,
    verifyReleaseFiles,
    validateTargetEntries,
    appTree,
    verifyAppTree,
    resolvePatchFile,
} = require('../scripts/publish-macos-keyless');

const context = {
    tag: 'v0.10.4',
    version: '0.10.4',
    runId: '37498744095',
    sourceSha: 'a'.repeat(40),
    manifestSHA256: 'b'.repeat(64),
    prefix: 'Honest-Father-0.10.4-macos-arm64',
};
const inputs = { GH_REPO: 'ANAYSSA/Honest-Father', HF_TAG: context.tag, HF_RUN_ID: context.runId, HF_MANIFEST_SHA: context.manifestSHA256 };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const targetEntries = [
    { path: 'Contents', type: 'directory', mode: 0o755 },
    { path: 'Contents/MacOS', type: 'directory', mode: 0o755 },
    { path: 'Contents/MacOS/Honest Father', type: 'file', mode: 0o755, sha256: 'e'.repeat(64) },
];
const manifest = {
    format: 'honest-father-macos-files-bsdiff-v1',
    version: context.version,
    runId: context.runId,
    sourceSha: context.sourceSha,
    baseSHA256: 'c'.repeat(64),
    files: [
        {
            path: 'Contents/MacOS/Honest Father',
            baseSHA256: 'c'.repeat(64),
            targetSHA256: 'e'.repeat(64),
            patchSHA256: 'd'.repeat(64),
            patchName: '0000.bsdiff',
            size: 1234,
            mode: 0o755,
        },
    ],
    targetEntries,
    targetTreeSHA256: sha(JSON.stringify(targetEntries)),
};
function pinned(metadata) {
    const rawBytes = Buffer.from(JSON.stringify(metadata));
    return { rawBytes, context: { ...context, manifestSHA256: sha(rawBytes) } };
}
function checkManifest(metadata) {
    const pin = pinned(metadata);
    return validateManifest(metadata, pin.context, pin.rawBytes);
}
const run = {
    id: Number(context.runId),
    head_repository: { full_name: inputs.GH_REPO },
    path: '.github/workflows/build.yml',
    name: 'Build Honest Father',
    event: 'push',
    head_branch: context.tag,
    head_sha: context.sourceSha,
    status: 'completed',
    conclusion: 'success',
};
const jobs = ['darwin / arm64', 'win32 / x64'].map(name => ({ name, status: 'completed', conclusion: 'success' }));

test('dispatch rejects shell syntax, foreign repositories and malformed SHA/run IDs before using commands', () => {
    assert.deepEqual(validateInputs(inputs), { tag: context.tag, runId: context.runId, manifestSHA256: context.manifestSHA256 });
    for (const changes of [
        { GH_REPO: 'someone/else' },
        { HF_TAG: 'v0.10.4;touch /tmp/no' },
        { HF_TAG: '$(id)' },
        { HF_TAG: '--help' },
        { HF_RUN_ID: '1\n2' },
        { HF_RUN_ID: '0' },
        { HF_MANIFEST_SHA: '../target.zip' },
        { HF_MANIFEST_SHA: 'b'.repeat(63) },
    ])
        assert.throws(() => validateInputs({ ...inputs, ...changes }));
});

test('only a successful same-repository push for the exact tag/source and both platforms is accepted', () => {
    assert.doesNotThrow(() => validateRun(run, jobs, context));
    for (const changes of [
        { id: 1 },
        { head_repository: { full_name: 'someone/else' } },
        { path: '.github/workflows/other.yml' },
        { name: 'Other Build' },
        { event: 'pull_request' },
        { head_branch: 'master' },
        { head_sha: 'e'.repeat(40) },
        { status: 'in_progress' },
        { conclusion: 'failure' },
    ])
        assert.throws(() => validateRun({ ...run, ...changes }, jobs, context));
    assert.throws(() => validateRun(run, jobs.slice(0, 1), context));
    assert.throws(() => validateRun(run, [...jobs, jobs[0]], context));
    assert.throws(() => validateRun(run, [jobs[0], { ...jobs[1], conclusion: 'failure' }], context));
});

test('delta metadata is pinned byte-for-byte and bound to source, baseline run and exact signed tree', () => {
    assert.doesNotThrow(() => checkManifest(manifest));
    const pin = pinned(manifest);
    assert.throws(() => validateManifest(manifest, pin.context, Buffer.from(JSON.stringify(manifest) + ' ')));
    for (const changes of [
        { format: 'BSDIFF40' },
        { version: '0.10.3' },
        { runId: Number(context.runId) },
        { runId: '1' },
        { sourceSha: 'e'.repeat(40) },
        { baseSHA256: 'not a hash' },
        { targetTreeSHA256: 'f'.repeat(64) },
        { downloadUrl: 'https://someone.example/patch' },
    ])
        assert.throws(() => checkManifest({ ...manifest, ...changes }));
    for (const changes of [
        { path: '../escape' },
        { patchName: '../escape.bsdiff' },
        { patchSHA256: 'invalid' },
        { targetSHA256: 'f'.repeat(64) },
        { mode: 0o644 },
        { size: -1 },
        { size: Number.MAX_SAFE_INTEGER },
    ])
        assert.throws(() => checkManifest({ ...manifest, files: [{ ...manifest.files[0], ...changes }] }));
    assert.throws(() => checkManifest({ ...manifest, files: [manifest.files[0], manifest.files[0]] }));
});

test('tree descriptors reject duplicate/unsorted paths, symlink parents, external links and noncanonical fields', () => {
    assert.doesNotThrow(() => validateTargetEntries(targetEntries));
    for (const entries of [
        [...targetEntries, targetEntries[2]],
        [...targetEntries].reverse(),
        [{ path: '../escape', type: 'directory', mode: 0o755 }],
        [{ path: 'Contents', type: 'symlink', mode: 0o777, link: '../outside' }],
        [{ path: 'Contents', type: 'symlink', mode: 0o777, link: '/tmp/outside' }],
        [{ path: 'Contents', type: 'symlink', mode: 0o777, link: 'internal' }, targetEntries[1]],
        [{ type: 'directory', path: 'Contents', mode: 0o755 }],
        [{ path: 'Contents', type: 'directory', mode: 0o100755 }],
    ])
        assert.throws(() => validateTargetEntries(entries));
});

test(
    'whole app verification detects changed bytes, file modes, links or extra files without following patch symlinks',
    { skip: process.platform === 'win32' },
    () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-keyless-tree-'));
        try {
            fs.mkdirSync(path.join(root, 'Contents/MacOS'), { recursive: true, mode: 0o755 });
            fs.mkdirSync(path.join(root, 'Contents/Resources'), { mode: 0o755 });
            const executable = path.join(root, 'Contents/MacOS/Honest Father');
            const link = path.join(root, 'Contents/Resources/current');
            fs.writeFileSync(executable, 'signed executable bytes', { mode: 0o755 });
            fs.symlinkSync('../MacOS/Honest Father', link);
            const expected = { targetEntries: appTree(root) };
            expected.targetTreeSHA256 = sha(JSON.stringify(expected.targetEntries));
            assert.doesNotThrow(() => validateTargetEntries(expected.targetEntries));
            assert.doesNotThrow(() => verifyAppTree(root, expected));
            assert.equal(resolvePatchFile(root, 'Contents/MacOS/Honest Father'), executable);
            assert.throws(() => resolvePatchFile(root, 'Contents/Resources/current'));
            fs.appendFileSync(executable, 'tampered');
            assert.throws(() => verifyAppTree(root, expected));
            fs.writeFileSync(executable, 'signed executable bytes');
            fs.chmodSync(executable, 0o644);
            assert.throws(() => verifyAppTree(root, expected));
            fs.chmodSync(executable, 0o755);
            fs.unlinkSync(link);
            fs.symlinkSync('../MacOS/another', link);
            assert.throws(() => verifyAppTree(root, expected));
            fs.unlinkSync(link);
            fs.symlinkSync('../MacOS/Honest Father', link);
            fs.writeFileSync(path.join(root, 'Contents/extra'), 'extra');
            assert.throws(() => verifyAppTree(root, expected));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
);
test('exact DR permits only certificate hash case differences, rejecting broader or per-build identities', () => {
    const requirement = `identifier "com.anayssa.honestfather" and certificate leaf = H"${'AB'.repeat(20)}"`;
    assert.doesNotThrow(() => assertExactRequirement(`designated => ${requirement.replace('AB'.repeat(20), 'ab'.repeat(20))}`, requirement));
    for (const actual of [
        `designated => ${requirement} or true`,
        `designated => ${requirement} and cdhash H"${'AB'.repeat(20)}"`,
        `designated => identifier "com.anayssa.honestfather"`,
        `designated => ${requirement.replace('AB'.repeat(20), 'CD'.repeat(20))}`,
        `designated => ${requirement.replace('honestfather', 'HonestFather')}`,
    ])
        assert.throws(() => assertExactRequirement(actual, requirement));
});

test('ZIP extraction accepts only the exact app root and refuses path escape or unrelated payloads', () => {
    const plist = 'Honest Father.app/Contents/Info.plist';
    assert.doesNotThrow(() => validateZipEntries(['Honest Father.app/', plist, 'Honest Father.app/Contents/MacOS/Honest Father']));
    for (const entries of [
        [],
        ['Other.app/Contents/Info.plist'],
        [plist, '/tmp/file'],
        [plist, 'Honest Father.app/../../file'],
        [plist, 'Honest Father.app/Contents\\evil'],
        [plist, 'Honest Father.app/Contents/evil\u0000'],
    ]) {
        assert.throws(() => validateZipEntries(entries));
    }
});

test('upload collection rejects altered bytes, duplicate checksum lines and any extra release file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-keyless-proposal-'));
    const directory = path.join(root, 'out/releases');
    fs.mkdirSync(directory, { recursive: true });
    try {
        const zip = `${context.prefix}.zip`,
            dmg = `${context.prefix}.dmg`,
            checksums = `${context.prefix}-SHA256SUMS.txt`;
        fs.writeFileSync(path.join(directory, zip), 'signed ZIP fixture');
        fs.writeFileSync(path.join(directory, dmg), 'DMG fixture');
        const hash = name =>
            crypto
                .createHash('sha256')
                .update(fs.readFileSync(path.join(directory, name)))
                .digest('hex');
        const lines = `${hash(dmg)}  ${dmg}\n${hash(zip)}  ${zip}\n`;
        fs.writeFileSync(path.join(directory, checksums), lines);
        const verified = context;
        assert.equal(verifyReleaseFiles(root, verified).length, 3);
        fs.writeFileSync(path.join(directory, 'extra.zip'), 'unrelated');
        assert.throws(() => verifyReleaseFiles(root, verified));
        fs.unlinkSync(path.join(directory, 'extra.zip'));
        fs.writeFileSync(path.join(directory, checksums), lines.split('\n')[0] + '\n' + lines.split('\n')[0] + '\n');
        assert.throws(() => verifyReleaseFiles(root, verified));
        fs.writeFileSync(path.join(directory, checksums), lines);
        fs.appendFileSync(path.join(directory, zip), 'tampered');
        assert.throws(() => verifyReleaseFiles(root, verified));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
