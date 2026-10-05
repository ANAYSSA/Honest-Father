const path = require('path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const { buildAudioHelper } = require('./scripts/build-audio-helper');
const { verifyMacApp } = require('./scripts/verify-macos-app');

module.exports = {
    packagerConfig: {
        asar: true,
        name: 'Honest Father',
        executableName: process.platform === 'win32' ? 'HonestFather' : 'Honest Father',
        appBundleId: 'com.anayssa.honestfather',
        appCategoryType: 'public.app-category.education',
        icon: 'src/assets/logo',
        extraResource: process.platform === 'darwin' ? [path.resolve('src/assets/SystemAudioDump')] : [],
        extendInfo: {
            CFBundleDisplayName: 'Honest Father',
            CFBundleName: 'Honest Father',
            LSUIElement: true,
            NSMicrophoneUsageDescription: 'Honest Father uses your microphone for interview practice and study sessions.',
            NSScreenCaptureUsageDescription: 'Honest Father captures shared screens and system audio to help you review practice questions.',
            NSAudioCaptureUsageDescription: 'Honest Father uses system audio during interview practice and study sessions.',
            LSMinimumSystemVersion: '13.0',
        },
        ignore: [/^\/native(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/tests?(?:\/|$)/, /^\/work(?:\/|$)/, /^\/\.github(?:\/|$)/],
        // Re-sign the final bundle after plist/ASAR/fuse changes. '-' needs no certificate;
        // Developer ID signing and notarization remain separate distribution steps.
        osxSign: {
            identity: '-',
            identityValidation: false,
            preAutoEntitlements: false,
            preEmbedProvisioningProfile: false,
            optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
            continueOnError: false,
        },
    },
    rebuildConfig: {},
    hooks: {
        generateAssets: async () => {
            if (process.platform === 'darwin') buildAudioHelper(process.arch);
        },
        prePackage: async (_config, platform, arch) => {
            if (platform === 'darwin') buildAudioHelper(arch);
        },
        postPackage: async (_config, { platform, outputPaths }) => {
            if (platform !== 'darwin') return;
            for (const outputPath of outputPaths) verifyMacApp(path.join(outputPath, 'Honest Father.app'));
        },
    },
    makers: [
        {
            name: '@electron-forge/maker-squirrel',
            platforms: ['win32'],
            config: {
                name: 'HonestFather',
                productName: 'Honest Father',
                shortcutName: 'Honest Father',
                setupExe: 'Honest-Father-Setup.exe',
                setupIcon: 'src/assets/logo.ico',
            },
        },
        {
            name: '@electron-forge/maker-dmg',
            platforms: ['darwin'],
            config: { name: 'Honest Father', format: 'ULFO' },
        },
        {
            name: '@electron-forge/maker-zip',
            platforms: ['darwin', 'win32'],
        },
    ],
    plugins: [
        { name: '@electron-forge/plugin-auto-unpack-natives', config: {} },
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
        }),
    ],
};
