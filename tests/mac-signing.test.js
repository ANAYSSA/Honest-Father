const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, X509Certificate } = require('node:crypto');
const { releaseSigningIdentity, releaseRequirement, getMacSigningOptions } = require('../scripts/mac-signing');

test('the release identity pins the public X.509 certificate using the codesign SHA-1 format', () => {
    const pem = fs.readFileSync(path.join(__dirname, '..', 'build', 'honest-father-signing.pem'), 'utf8');
    assert.match(pem, /-----BEGIN CERTIFICATE-----/);
    assert.doesNotMatch(pem, /PRIVATE KEY/);
    const certificate = new X509Certificate(pem);
    assert.equal(releaseSigningIdentity, createHash('sha1').update(certificate.raw).digest('hex').toUpperCase());
    assert.match(releaseSigningIdentity, /^[A-F0-9]{40}$/);
    assert.equal(releaseRequirement, `identifier "com.anayssa.honestfather" and certificate leaf = H"${releaseSigningIdentity}"`);
    assert.doesNotMatch(releaseRequirement, /cdhash|subject\.CN|\bor\b/);
});

test('CI and ordinary development builds retain ad-hoc signing without a release key', () => {
    for (const env of [{}, { HONEST_FATHER_RELEASE_SIGNING: '0' }, { HONEST_FATHER_RELEASE_SIGNING: '' }]) {
        const options = getMacSigningOptions(env);
        assert.equal(options.identity, '-');
        assert.equal(options.identityValidation, false);
        assert.equal(options.preAutoEntitlements, false);
        assert.equal(options.preEmbedProvisioningProfile, false);
        assert.equal(options.continueOnError, false);
        assert.deepEqual(options.optionsForFile('/tmp/Honest Father.app'), { hardenedRuntime: false, timestamp: 'none' });
    }
});

test('release builds require the pinned identity and include both certificate and bundle identifier', () => {
    const options = getMacSigningOptions({ HONEST_FATHER_RELEASE_SIGNING: '1' });
    assert.equal(options.identity, releaseSigningIdentity);
    assert.notEqual(options.identity, '-');
    for (const filePath of [
        '/tmp/Honest Father.app',
        'Honest Father.app',
        '/tmp/Honest Father.app/Contents/MacOS/Honest Father',
        'C:\\tmp\\Honest Father.app',
    ]) {
        const perFile = options.optionsForFile(filePath);
        assert.equal(perFile.requirements, `=designated => ${releaseRequirement}`);
        assert.equal(perFile.hardenedRuntime, false);
        assert.equal(perFile.timestamp, 'none');
    }
});

test('nested helpers keep their own identifiers while using the pinned release signing key', () => {
    const options = getMacSigningOptions({ HONEST_FATHER_RELEASE_SIGNING: '1' });
    for (const filePath of [
        '/tmp/Honest Father.app/Contents/Frameworks/Honest Father Helper.app',
        '/tmp/Honest Father.app/Contents/Frameworks/Honest Father Helper (Renderer).app',
        '/tmp/Honest Father.app/Contents/Frameworks/Electron Framework.framework',
        '/tmp/Honest Father.app/Contents/Resources/SystemAudioDump',
        '/tmp/Honest Father.app.backup',
    ]) {
        assert.equal(options.identity, releaseSigningIdentity);
        assert.equal(Object.hasOwn(options.optionsForFile(filePath), 'requirements'), false);
    }
});

test('release environment overrides cannot replace the pinned key with ad-hoc or another identity', () => {
    for (const identity of ['-', 'Another Developer', '0'.repeat(40), `${releaseSigningIdentity} or anchor trusted`]) {
        assert.throws(
            () => getMacSigningOptions({ HONEST_FATHER_RELEASE_SIGNING: '1', HONEST_FATHER_SIGNING_IDENTITY: identity }),
            /pinned Honest Father signing certificate/
        );
    }
    assert.equal(
        getMacSigningOptions({ HONEST_FATHER_RELEASE_SIGNING: '1', HONEST_FATHER_SIGNING_IDENTITY: releaseSigningIdentity.toLowerCase() }).identity,
        releaseSigningIdentity
    );
});

test('forks can choose their own signing identity outside Honest Father release mode', () => {
    const options = getMacSigningOptions({ HONEST_FATHER_SIGNING_IDENTITY: 'Fork Developer Identity' });
    assert.equal(options.identity, 'Fork Developer Identity');
    assert.equal(Object.hasOwn(options.optionsForFile('/tmp/Honest Father.app'), 'requirements'), false);
});

test('malformed signing flags and unsafe identity values fail instead of silently signing a release ad-hoc', () => {
    for (const value of ['true', '01', ' 1 ', 'yes', 1]) {
        assert.throws(() => getMacSigningOptions({ HONEST_FATHER_RELEASE_SIGNING: value }), /must be 1/);
    }
    for (const value of ['', ' ', '\nOther Identity', 'x'.repeat(257), {}, null]) {
        assert.throws(() => getMacSigningOptions({ HONEST_FATHER_SIGNING_IDENTITY: value }), /one valid signing identity/);
    }
});
