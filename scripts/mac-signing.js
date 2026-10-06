const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');

// Only the public certificate belongs in this repository. The signing key stays
// in the release signer's keychain and is never part of an installer or checkout.
const certificatePath = path.join(__dirname, '..', 'build', 'honest-father-signing.pem');
const releaseCertificate = new X509Certificate(fs.readFileSync(certificatePath));
const releaseSigningIdentity = releaseCertificate.fingerprint.replaceAll(':', '').toUpperCase();
if (!/^[A-F0-9]{40}$/.test(releaseSigningIdentity)) throw new Error('The macOS release signing certificate has an invalid fingerprint.');

// A name or bundle identifier alone can be copied. Bind app identity to the
// actual signing certificate so permissions cannot follow an unrelated signer.
const releaseRequirement = `identifier "com.anayssa.honestfather" and certificate leaf = H"${releaseSigningIdentity}"`;

function getMacSigningOptions(env = process.env) {
    const releaseFlag = env.HONEST_FATHER_RELEASE_SIGNING;
    if (releaseFlag !== undefined && releaseFlag !== '' && releaseFlag !== '0' && releaseFlag !== '1') {
        throw new Error('HONEST_FATHER_RELEASE_SIGNING must be 1 for a release or 0 for a development build.');
    }
    const isRelease = releaseFlag === '1';
    const configuredIdentity = env.HONEST_FATHER_SIGNING_IDENTITY;
    if (
        configuredIdentity !== undefined &&
        (typeof configuredIdentity !== 'string' ||
            !configuredIdentity.trim() ||
            configuredIdentity.length > 256 ||
            /[\u0000-\u001f\u007f-\u009f]/.test(configuredIdentity))
    ) {
        throw new Error('HONEST_FATHER_SIGNING_IDENTITY must contain one valid signing identity.');
    }
    if (isRelease && configuredIdentity !== undefined && configuredIdentity.toUpperCase() !== releaseSigningIdentity) {
        throw new Error('A macOS release must use the pinned Honest Father signing certificate.');
    }

    return {
        identity: isRelease ? releaseSigningIdentity : configuredIdentity || '-',
        identityValidation: false,
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        optionsForFile: filePath => {
            const options = { hardenedRuntime: false, timestamp: 'none' };
            const normalizedPath = filePath?.replaceAll('\\', '/');
            if (
                isRelease &&
                (normalizedPath?.endsWith('/Honest Father.app') ||
                    normalizedPath === 'Honest Father.app' ||
                    normalizedPath?.endsWith('/Honest Father.app/Contents/MacOS/Honest Father'))
            ) {
                options.requirements = `=designated => ${releaseRequirement}`;
            }
            return options;
        },
        continueOnError: false,
    };
}

module.exports = { releaseSigningIdentity, releaseRequirement, getMacSigningOptions };
