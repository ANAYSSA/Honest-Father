const ACTION_NAMES = {
    moveUp: 'Move Window Up',
    moveDown: 'Move Window Down',
    moveLeft: 'Move Window Left',
    moveRight: 'Move Window Right',
    toggleVisibility: 'Toggle App Window',
    toggleReviewMarks: 'Toggle Review Marks',
    openVisibilitySettings: 'Open Test Visibility Settings',
    toggleClickThrough: 'Toggle Click-through',
    nextStep: 'Ask Next Step',
    previousResponse: 'Previous Response',
    nextResponse: 'Next Response',
    scrollUp: 'Scroll Response Up',
    scrollDown: 'Scroll Response Down',
    quitApplication: 'Quit Application',
    emergencyErase: 'Erase Data and Quit',
};

function getDefaultKeybinds(platform = process.platform) {
    const isMac = platform === 'darwin';
    const primary = isMac ? 'Cmd' : 'Ctrl';
    return {
        moveUp: isMac ? 'Alt+Up' : 'Ctrl+Up',
        moveDown: isMac ? 'Alt+Down' : 'Ctrl+Down',
        moveLeft: isMac ? 'Alt+Left' : 'Ctrl+Left',
        moveRight: isMac ? 'Alt+Right' : 'Ctrl+Right',
        toggleVisibility: `${primary}+\\`,
        toggleReviewMarks: `${primary}+Shift+\\`,
        openVisibilitySettings: `${primary}+Shift+,`,
        toggleClickThrough: `${primary}+M`,
        nextStep: `${primary}+Enter`,
        previousResponse: `${primary}+[`,
        nextResponse: `${primary}+]`,
        scrollUp: `${primary}+Shift+Up`,
        scrollDown: `${primary}+Shift+Down`,
        quitApplication: `${primary}+Shift+Q`,
        emergencyErase: `${primary}+Shift+E`,
    };
}

function normalizeAccelerator(accelerator, platform = process.platform) {
    if (typeof accelerator !== 'string' || accelerator.length > 80) {
        throw new Error('Shortcut must be a valid key combination.');
    }
    const parts = accelerator.trim().split('+');
    const modifiers = new Set();
    const aliases = {
        ctrl: 'Ctrl',
        control: 'Ctrl',
        cmd: 'Cmd',
        command: 'Cmd',
        commandorcontrol: platform === 'darwin' ? 'Cmd' : 'Ctrl',
        cmdorctrl: platform === 'darwin' ? 'Cmd' : 'Ctrl',
        alt: 'Alt',
        option: 'Alt',
        shift: 'Shift',
        super: platform === 'darwin' ? 'Cmd' : 'Super',
        meta: platform === 'darwin' ? 'Cmd' : 'Super',
    };
    for (const part of parts.slice(0, -1)) {
        const modifier = aliases[part.toLowerCase()];
        if (!modifier || modifiers.has(modifier)) throw new Error('Invalid shortcut modifiers.');
        modifiers.add(modifier);
    }
    if (![...modifiers].some(modifier => modifier !== 'Shift')) {
        throw new Error('Use Command, Control, or Alt together with a key.');
    }
    const keyAliases = {
        escape: 'Escape',
        esc: 'Escape',
        return: 'Enter',
        enter: 'Enter',
        space: 'Space',
        up: 'Up',
        down: 'Down',
        left: 'Left',
        right: 'Right',
        home: 'Home',
        end: 'End',
        pageup: 'PageUp',
        pagedown: 'PageDown',
        insert: 'Insert',
        delete: 'Delete',
        backspace: 'Backspace',
        tab: 'Tab',
        plus: 'Plus',
    };
    const rawKey = parts.at(-1);
    const key = keyAliases[rawKey.toLowerCase()] || rawKey;
    if (
        !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Tab|Enter|Escape|Space|Plus|[\\[\];',.\/`=\-])$/i.test(
            key
        )
    ) {
        throw new Error('Unsupported shortcut key.');
    }
    const canonicalKey = key.length === 1 || /^f\d+$/i.test(key) ? key.toUpperCase() : key;
    return [...['Ctrl', 'Cmd', 'Alt', 'Shift', 'Super'].filter(modifier => modifiers.has(modifier)), canonicalKey].join('+');
}

function normalizeKeybinds(input, platform = process.platform) {
    if (input !== null && (typeof input !== 'object' || Array.isArray(input))) {
        throw new Error('Invalid keyboard shortcut settings.');
    }
    const keybinds = getDefaultKeybinds(platform);
    for (const action of Object.keys(keybinds)) {
        if (input && Object.hasOwn(input, action)) keybinds[action] = normalizeAccelerator(input[action], platform);
    }
    // Keep existing custom bindings when adding an action to older settings.
    // Explicitly saved bindings still go through ordinary conflict validation.
    const primary = platform === 'darwin' ? 'Cmd' : 'Ctrl';
    for (const [addedAction, alternatives] of [
        ['toggleReviewMarks', [`${primary}+Alt+Shift+\\`, `${primary}+Alt+\\`]],
        ['openVisibilitySettings', [`${primary}+Alt+Shift+,`, `${primary}+Alt+,`]],
    ]) {
        if (!input || Object.hasOwn(input, addedAction)) continue;
        const occupied = new Set(
            Object.entries(keybinds)
                .filter(([action]) => action !== addedAction)
                .map(([, accelerator]) => normalizeAccelerator(accelerator, platform).toLowerCase())
        );
        const candidates = [keybinds[addedAction], ...alternatives, ...Array.from({ length: 13 }, (_, index) => `${primary}+Shift+F${index + 12}`)];
        keybinds[addedAction] = candidates.find(accelerator => !occupied.has(normalizeAccelerator(accelerator, platform).toLowerCase()));
    }
    const seen = new Map();
    for (const action of Object.keys(keybinds)) {
        const canonical = normalizeAccelerator(keybinds[action], platform).toLowerCase();
        if (seen.has(canonical)) {
            throw new Error(`${ACTION_NAMES[action]} conflicts with ${ACTION_NAMES[seen.get(canonical)]}. Choose a different shortcut.`);
        }
        seen.set(canonical, action);
    }
    return keybinds;
}

// Electron can return false instead of throwing when another app owns a shortcut.
// A failed edit restores the previous working bindings and is never saved.
function createShortcutRegistrar(globalShortcut, platform = process.platform) {
    let active = new Map();
    let desired = new Map();
    let configured = null;
    let paused = false;
    let disposed = false;
    let lastResult = { success: true, keybinds: getDefaultKeybinds(platform), failures: [] };

    function register(bindings) {
        const registered = new Map();
        const failures = [];
        for (const [action, binding] of bindings) {
            try {
                if (!globalShortcut.register(binding.accelerator, binding.callback))
                    throw new Error('Already used by the system or another application');
                registered.set(action, binding);
            } catch (error) {
                failures.push({ action, accelerator: binding.accelerator, error: error.message });
            }
        }
        return { registered, failures };
    }

    function update(input, actions, { allowPartial = false } = {}) {
        if (disposed) return { success: false, error: 'Application is closing.', keybinds: configured || getDefaultKeybinds(platform), failures: [] };
        let keybinds;
        try {
            keybinds = normalizeKeybinds(input, platform);
        } catch (error) {
            return { success: false, error: error.message, keybinds: configured || getDefaultKeybinds(platform), failures: [] };
        }
        const previous = active;
        globalShortcut.unregisterAll();
        const bindings = new Map(Object.entries(keybinds).map(([action, accelerator]) => [action, { accelerator, callback: actions[action] }]));
        const { registered, failures } = register(bindings);
        const changedFailures = failures.filter(failure => configured?.[failure.action] !== failure.accelerator);
        if (changedFailures.length && !allowPartial) {
            globalShortcut.unregisterAll();
            const restored = register(previous);
            active = restored.registered;
            if (paused) globalShortcut.unregisterAll();
            const failed = changedFailures[0];
            return {
                success: false,
                error: `${ACTION_NAMES[failed.action]} (${failed.accelerator}) is unavailable. Choose another shortcut.`,
                keybinds: configured || getDefaultKeybinds(platform),
                failures: [...failures, ...restored.failures],
            };
        }
        active = registered;
        desired = bindings;
        configured = keybinds;
        if (paused) globalShortcut.unregisterAll();
        lastResult = { success: true, keybinds, failures };
        return lastResult;
    }

    function setPaused(value) {
        if (disposed) return { ...lastResult, success: false, error: 'Application is closing.' };
        paused = value;
        globalShortcut.unregisterAll();
        if (!paused) {
            const result = register(desired);
            active = result.registered;
            lastResult = { ...lastResult, failures: result.failures };
        }
        return lastResult;
    }

    function dispose() {
        disposed = true;
        active.clear();
        desired.clear();
        globalShortcut.unregisterAll();
    }

    return { update, setPaused, dispose, getStatus: () => lastResult };
}

module.exports = { ACTION_NAMES, getDefaultKeybinds, normalizeAccelerator, normalizeKeybinds, createShortcutRegistrar };
