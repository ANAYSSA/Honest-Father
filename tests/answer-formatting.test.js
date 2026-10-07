const test = require('node:test');
const assert = require('node:assert/strict');
const { getAnswerFormattingInstruction, getSystemPrompt, getScreenshotSystemPrompt } = require('../src/utils/prompts');

test('answer presentation includes real TeX delimiters and never fabricates question or choice labels', () => {
    const instruction = getAnswerFormattingInstruction();
    for (const formula of [String.raw`\(\Theta(n^2)\)`, String.raw`\(\log_2 n\)`, String.raw`\(\frac{a}{b}\)`]) {
        assert.ok(instruction.includes(formula), `Missing TeX example: ${formula}`);
    }
    assert.match(instruction, /put the answer first/);
    assert.match(instruction, /Never invent a missing question number or option label/);
    assert.match(instruction, /never guess labels for cropped or unreadable choices/);
    assert.match(instruction, /Do not put math in backticks or a code block/);
    assert.match(instruction, /\*\*Question 7 — B\*\*/);
});

test('turning label emphasis off retains mathematics and custom authored Markdown', () => {
    const custom = 'Keep **my context** and use Python.';
    const screenshot = getScreenshotSystemPrompt('exam', custom, false);
    assert.ok(screenshot.includes(custom));
    assert.ok(screenshot.includes(String.raw`\(\Theta(n^2)\)`));
    assert.doesNotMatch(screenshot, /Emphasize each supplied question number|\*\*Question 7 — B\*\*/);
    assert.match(screenshot, /complete runnable implementation/);
});

test('Live prompt formatting is opt-in for existing callers and preserves profile, language context, and search choice', () => {
    const oldContract = getSystemPrompt('interview', 'Respond in Russian.', false);
    assert.doesNotMatch(oldContract, /ANSWER PRESENTATION/);
    for (const enabled of [true, false]) {
        const formatted = getSystemPrompt('interview', 'Respond in Russian.', false, enabled);
        assert.ok(formatted.startsWith(oldContract));
        assert.match(formatted, /ANSWER PRESENTATION/);
        assert.equal(formatted.includes('Emphasize each supplied question number'), enabled);
        assert.doesNotMatch(formatted, /SEARCH TOOL USAGE/);
    }
});
