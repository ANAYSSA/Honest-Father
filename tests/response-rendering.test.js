const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const katex = require('katex');
const createDOMPurify = require('dompurify');
const marked = require('../src/assets/marked-4.3.0.min.js');

const dom = new JSDOM('<!doctype html><html><body></body></html>');
dom.window.marked = marked;
const context = {
    window: dom.window,
    document: dom.window.document,
    katex,
    DOMPurify: createDOMPurify(dom.window),
    URL,
};
const source = fs
    .readFileSync(path.resolve(__dirname, '../src/utils/responseRendering.js'), 'utf8')
    .replace(/\r\n?/g, '\n')
    .replace(/^import .+;\n/gm, '')
    .replace(/^const MATH_STYLESHEET = .+;$/m, "const MATH_STYLESHEET = 'file:///app/node_modules/katex/dist/katex.min.css';")
    .replace(/^export /gm, '');
vm.runInNewContext(`${source}\nthis.api = { renderResponseHtml, renderResponseClipboardHtml, installResponseStyles };`, context);
const { renderResponseHtml, renderResponseClipboardHtml, installResponseStyles } = context.api;

function rendered(source) {
    const element = dom.window.document.createElement('div');
    element.innerHTML = renderResponseHtml(source);
    return element;
}

test('AI answer Markdown and the screenshot examples render Greek symbols, fractions, powers and logs', () => {
    const element = rendered(String.raw`**Question 3: b, d, e.**

- **b)** \(5 \sim 5\)
- **d)** \(\left(\frac{N^2}{3}+\frac N2\right)\sim\frac{N^2}{3}\)

The running time is \(\Theta(n^2)\), using \(\log_2 n\) iterations.`);
    assert.equal(element.querySelector('strong').textContent, 'Question 3: b, d, e.');
    assert.equal(element.querySelectorAll('.katex').length, 4);
    assert.match(element.querySelectorAll('.katex-html')[2].textContent, /Θ/);
    assert.ok(element.querySelector('.mfrac'), 'fractions use numerator / denominator layout');
    assert.ok(element.querySelector('.msupsub'), 'powers and subscripts use typeset layout');
    assert.equal(element.querySelector('math').getAttribute('xmlns'), 'http://www.w3.org/1998/Math/MathML');
});

test('both display delimiters and dollar inline math work, including inequalities', () => {
    const element = rendered(String.raw`Cost is $5 or $10. Formula $n^2$.

\[
\log n < n\log n < n^2 < n^3
\]

$$\frac{1}{2}$$`);
    assert.equal(element.querySelectorAll('.katex').length, 3);
    assert.equal(element.querySelectorAll('.katex-display').length, 2);
    assert.match(element.textContent, /Cost is \$5 or \$10/);
});

test('literal math in fenced, indented and inline code is preserved', () => {
    const source = '`\\(\\Theta(n)\\)` and ``$x$``\n\n```tex\n\\[\\frac{1}{2}\\]\n```\n\n    $$n^2$$';
    const element = rendered(source);
    assert.equal(element.querySelectorAll('.katex').length, 0);
    assert.deepEqual(
        Array.from(element.querySelectorAll('code'), node => node.textContent.trim()),
        [String.raw`\(\Theta(n)\)`, '$x$', String.raw`\[\frac{1}{2}\]`, '$$n^2$$']
    );
});

test('streaming incomplete formulas and unsupported commands stay safe and readable', () => {
    const response = String.raw`**Question 4: e.** The result is \(\Theta(n^2)\).`;
    for (let length = 0; length <= response.length; length++) assert.doesNotThrow(() => rendered(response.slice(0, length)));
    const invalid = rendered(String.raw`\(\unknownCommand{<img src=x onerror=alert(1)>}\)`);
    assert.equal(invalid.querySelectorAll('.math-fallback').length, 1);
    assert.equal(invalid.querySelectorAll('img,script').length, 0);
    assert.match(invalid.textContent, /unknownCommand/);
    assert.equal(rendered(response).querySelectorAll('.katex').length, 1);
});

test('untrusted HTML and image Markdown cannot execute code, style the app or fetch external images', () => {
    const element = rendered(
        '<script>alert(1)</script>\n<style>body{display:none}</style>\n<img src="https://example.com/track" onerror="alert(1)">\n\n![track](https://example.com/pixel)\n\n<svg onload="alert(1)"></svg>'
    );
    assert.equal(element.querySelectorAll('script,style,img,svg,iframe,object').length, 0);
    assert.equal(element.querySelectorAll('[onerror],[onload],[src]').length, 0);
    assert.match(element.textContent, /<script>alert\(1\)<\/script>/);
    assert.match(element.textContent, /track/);
});

test('links allow web/mail URLs only, reject embedded markup, and math trust remains disabled', () => {
    const element = rendered(String.raw`[safe](https://example.com/a?q=1 "safe") [bad](javascript:alert%281%29) [file](file:///etc/passwd)

\(\href{javascript:alert(1)}{bad}\) \(\includegraphics{https://example.com/pixel}\)

[encoded](javascript&#58;alert(1))`);
    const links = element.querySelectorAll('a');
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'https://example.com/a?q=1');
    assert.equal(links[0].getAttribute('rel'), 'noopener noreferrer');
    assert.equal(element.querySelectorAll('[src],[onload],img').length, 0);
});

test('KaTeX expansion is bounded and macros cannot leak between answers', () => {
    assert.doesNotThrow(() => rendered(String.raw`\(\def\a{\a}\a\)`));
    rendered(String.raw`\(\gdef\honestTestMacro{REAL}\honestTestMacro\)`);
    assert.equal(rendered(String.raw`\(\honestTestMacro\)`).querySelectorAll('.math-fallback').length, 1);
});

test('Shadow DOM receives local math styles exactly once', () => {
    const host = dom.window.document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    installResponseStyles(root);
    installResponseStyles(root);
    assert.equal(root.querySelectorAll('link[data-response-math-styles]').length, 1);
    assert.match(root.querySelector('link').href, /node_modules\/katex\/dist\/katex\.min\.css$/);
    assert.match(root.querySelector('style').textContent, /\.katex \* \{ font-family: inherit/);
});

test('missing renderer dependencies return escaped plain text instead of unsafe HTML', () => {
    const saved = dom.window.marked;
    dom.window.marked = null;
    try {
        const element = rendered('<img src=x onerror=alert(1)>\ntext');
        assert.equal(element.querySelectorAll('img').length, 0);
        assert.equal(element.querySelectorAll('br').length, 1);
    } finally {
        dom.window.marked = saved;
    }
});

test('rich clipboard math uses one native MathML representation without app CSS or duplicated formulas', () => {
    const element = dom.window.document.createElement('div');
    element.innerHTML = renderResponseClipboardHtml(String.raw`**Question 7: B** \(\Theta(n^2)\)`);
    assert.equal(element.querySelectorAll('math').length, 1);
    assert.equal(element.querySelectorAll('.katex-html,.katex-mathml').length, 0);
    assert.equal(element.querySelector('strong').textContent, 'Question 7: B');
    assert.equal(element.querySelector('mi').textContent, 'Θ');
});
