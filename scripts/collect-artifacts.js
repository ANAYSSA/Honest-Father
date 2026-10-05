const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { version } = require('../package.json');

const [platform, arch] = process.argv.slice(2);
if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error('Usage: node scripts/collect-artifacts.js <darwin|win32> <arm64|x64>');
}
const source = path.resolve(__dirname, '../out/make');
const destination = path.resolve(__dirname, '../out/releases');
fs.mkdirSync(destination, { recursive: true });
const osName = platform === 'darwin' ? 'macos' : 'windows';
const prefix = `Honest-Father-${version}-${osName}-${arch}`;
const assets = [];
function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collect(file);
            continue;
        }
        const extension = path.extname(entry.name);
        if (!['.dmg', '.zip', '.exe', '.nupkg'].includes(extension) && entry.name !== 'RELEASES') continue;
        const name = extension === '.exe' ? `${prefix}-Setup.exe` : ['.dmg', '.zip'].includes(extension) ? `${prefix}${extension}` : entry.name;
        const output = path.join(destination, name);
        if (fs.existsSync(output)) throw new Error(`Duplicate release artifact: ${name}`);
        fs.copyFileSync(file, output);
        assets.push(name);
    }
}
collect(source);
const required = platform === 'darwin' ? ['.dmg', '.zip'] : ['.exe', '.zip'];
for (const extension of required) {
    if (!assets.some(name => name.endsWith(extension))) throw new Error(`Missing ${extension} release artifact`);
}
const checksums = assets.sort().map(name => {
    const digest = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(destination, name)))
        .digest('hex');
    return `${digest}  ${name}`;
});
fs.writeFileSync(path.join(destination, `${prefix}-SHA256SUMS.txt`), checksums.join('\n') + '\n');
console.log(`Collected ${assets.length} assets in out/releases`);
