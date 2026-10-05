const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const [platform, modifier, shortcut] of [
    ['MacIntel', 'metaKey', 'cmd+enter'],
    ['Win32', 'ctrlKey', 'ctrl+enter'],
]) {
    test(`focused Home ${shortcut} follows the screen-only shortcut path without calling Live Start`, () => {
        let View;
        const shortcuts = [];
        const source = fs
            .readFileSync(path.resolve(__dirname, '../src/components/views/MainView.js'), 'utf8')
            .replace(/^import[^\n]+\n/, '')
            .replace('export class MainView', 'class MainView');
        vm.runInNewContext(source, {
            LitElement: class {},
            html: () => '',
            css: () => '',
            customElements: {
                define: (name, constructor) => {
                    View = constructor;
                },
            },
            navigator: { platform },
            cheatingDaddy: { handleShortcut: key => shortcuts.push(key) },
        });
        const view = Object.create(View.prototype);
        view._handleStart = () => assert.fail('Screenshot hotkey must not start a Live session');
        let prevented = false;
        view._handleKeydown({
            key: 'Enter',
            [modifier]: true,
            preventDefault: () => {
                prevented = true;
            },
        });
        assert.equal(prevented, true);
        assert.deepEqual(shortcuts, [shortcut]);
        view._handleKeydown({ key: 'Enter', preventDefault: () => assert.fail('Plain Enter must not start screen sharing') });
        assert.deepEqual(shortcuts, [shortcut]);
    });
}
