const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadStorage(config = {}) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/storage.js'), 'utf8'), {
        module,
        require(name) {
            if (name === 'fs') {
                return {
                    existsSync: () => true,
                    readFileSync(file) {
                        assert.equal(path.basename(file), 'config.json', 'Model resolution must not read credentials');
                        return JSON.stringify(config);
                    },
                };
            }
            if (name === 'os') return { platform: () => 'darwin', homedir: () => '/mock-home' };
            if (name === 'path') return path;
            throw new Error(`Unexpected dependency: ${name}`);
        },
        console,
    });
    return module.exports;
}

test('fresh Gemini settings request automatic per-project selection for Live and screenshots', () => {
    const storage = loadStorage();
    assert.equal(storage.getConfig().geminiLiveModel, 'auto');
    assert.equal(storage.getAvailableModel(), 'auto');
});

test('updates preserve explicitly selected current and legacy Gemini models for catalogue validation', () => {
    for (const model of ['gemini-3.1-flash-live-preview', 'gemini-3.8-live', 'models/gemini-custom-live']) {
        const storage = loadStorage({ geminiLiveModel: model, geminiImageModel: 'models/gemini-custom-flash' });
        assert.equal(storage.getConfig().geminiLiveModel, model);
        assert.equal(storage.getAvailableModel(), 'models/gemini-custom-flash');
    }
});

test('blank screenshot model uses automatic selection without resetting other settings', () => {
    const storage = loadStorage({ geminiImageModel: '   ', layout: 'compact', groqModel: 'custom-groq-model' });
    assert.equal(storage.getAvailableModel(), 'auto');
    assert.equal(storage.getConfig().layout, 'compact');
    assert.equal(storage.getConfig().groqModel, 'custom-groq-model');
});
