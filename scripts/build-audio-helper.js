const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function buildAudioHelper(arch = process.arch) {
    if (process.platform !== 'darwin') return;
    const swiftArch = { arm64: 'arm64', x64: 'x86_64' }[arch];
    if (!swiftArch) throw new Error(`Unsupported macOS audio helper architecture: ${arch}`);

    const root = path.resolve(__dirname, '..');
    const output = path.join(root, 'src/assets/SystemAudioDump');
    const cache = path.join(root, 'work/swift-module-cache');
    fs.mkdirSync(cache, { recursive: true });
    const result = spawnSync(
        'xcrun',
        [
            'swiftc',
            '-O',
            '-parse-as-library',
            '-target',
            `${swiftArch}-apple-macosx13.0`,
            '-module-cache-path',
            cache,
            path.join(root, 'native/SystemAudioDump/main.swift'),
            '-o',
            output,
        ],
        { stdio: 'inherit' }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('SystemAudioDump compilation failed. Install the Xcode Command Line Tools on macOS.');
    fs.chmodSync(output, 0o755);
    console.log(`Built SystemAudioDump for macOS ${arch}`);
}

if (require.main === module) buildAudioHelper(process.argv[2] || process.arch);

module.exports = { buildAudioHelper };
