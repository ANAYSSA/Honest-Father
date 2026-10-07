import katex from '../../node_modules/katex/dist/katex.mjs';
import DOMPurify from '../../node_modules/dompurify/dist/purify.es.mjs';

const MATH_STYLESHEET = new URL('../../node_modules/katex/dist/katex.min.css', import.meta.url).href;
const DELIMITERS = [
    { open: '\\[', close: '\\]', display: true },
    { open: '\\(', close: '\\)', display: false },
    { open: '$$', close: '$$', display: true },
    { open: '$', close: '$', display: false },
];

export function escapeResponseHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function isEscaped(source, index) {
    let backslashes = 0;
    while (index > 0 && source[--index] === '\\') backslashes++;
    return backslashes % 2 === 1;
}

// This tokenizer runs before Markdown's escape parser. Code spans and fences
// remain Markdown tokens, so their literal LaTeX is never typeset.
function mathToken(source, block = false) {
    for (const delimiter of DELIMITERS) {
        if (block && !delimiter.display) continue;
        if (!source.startsWith(delimiter.open)) continue;
        const start = delimiter.open.length;
        if (delimiter.open === '$' && (source[1] === '$' || /\s/.test(source[1] || ''))) return;
        for (let end = start; end < source.length; end++) {
            if (!source.startsWith(delimiter.close, end) || isEscaped(source, end)) continue;
            if (delimiter.open === '$' && (/\s/.test(source[end - 1]) || /\d/.test(source[end + 1] || ''))) return;
            const text = source.slice(start, end);
            if (!text.trim()) return;
            // A single dollar must not consume unrelated paragraphs or prices.
            if (delimiter.open === '$' && /\n/.test(text)) return;
            return { type: 'responseMath', raw: source.slice(0, end + delimiter.close.length), text, display: delimiter.display };
        }
        // Incomplete streamed math stays readable until its closing delimiter.
        return;
    }
}

function mathStart(source, block = false) {
    const delimiters = block ? ['\\[', '$$'] : ['\\[', '\\(', '$'];
    for (let index = 0; index < source.length; index++) {
        if (isEscaped(source, index)) continue;
        if (delimiters.some(delimiter => source.startsWith(delimiter, index)) && mathToken(source.slice(index), block)) return index;
    }
}

function renderMath(token) {
    try {
        return katex.renderToString(token.text, {
            displayMode: token.display,
            output: 'htmlAndMathml',
            throwOnError: true,
            trust: false,
            strict: 'ignore',
            maxSize: 10,
            maxExpand: 500,
            macros: {},
        });
    } catch {
        return `<span class="math-fallback">${escapeResponseHtml(token.raw)}</span>`;
    }
}

function safeLink(href) {
    try {
        const url = new URL(href);
        return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}

/** Render untrusted model output locally; never permit embedded HTML or network images. */
export function renderResponseHtml(content) {
    const source = String(content ?? '');
    const marked = globalThis.window?.marked;
    if (!marked || !DOMPurify.isSupported) return escapeResponseHtml(source).replace(/\n/g, '<br>');
    try {
        const renderer = new marked.Renderer();
        renderer.html = value => escapeResponseHtml(value);
        renderer.image = (_href, _title, text) => escapeResponseHtml(text);
        renderer.link = (href, title, text) => {
            const url = safeLink(href);
            if (!url) return text;
            return `<a href="${escapeResponseHtml(url)}"${title ? ` title="${escapeResponseHtml(title)}"` : ''} rel="noopener noreferrer">${text}</a>`;
        };
        const parsed = marked.parse(source, {
            renderer,
            breaks: true,
            gfm: true,
            headerIds: false,
            mangle: false,
            extensions: {
                inline: [value => mathToken(value)],
                startInline: [value => mathStart(value)],
                block: [value => mathToken(value, true)],
                startBlock: [value => mathStart(value, true)],
                renderers: { responseMath: renderMath },
            },
        });
        return DOMPurify.sanitize(parsed, {
            FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'img', 'video', 'audio', 'link'],
            FORBID_ATTR: ['src', 'srcset'],
            ALLOW_DATA_ATTR: false,
        });
    } catch {
        return escapeResponseHtml(source).replace(/\n/g, '<br>');
    }
}

export function renderResponseClipboardHtml(content) {
    const container = document.createElement('div');
    container.innerHTML = renderResponseHtml(content);
    // Rich clipboard consumers do not have the app's KaTeX CSS. Keep its native
    // MathML representation so pasting does not duplicate HTML + hidden math.
    for (const formula of container.querySelectorAll('.katex')) {
        const math = formula.querySelector('math');
        if (math) formula.replaceWith(math.cloneNode(true));
    }
    return container.innerHTML;
}

/** Shadow DOM needs KaTeX rules locally; index.html supplies global font faces. */
export function installResponseStyles(root) {
    if (!root || root.querySelector('[data-response-math-styles]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = MATH_STYLESHEET;
    link.setAttribute('data-response-math-styles', '');
    root.appendChild(link);
    const style = document.createElement('style');
    style.textContent = `
        .katex * { font-family: inherit; }
        .katex-display { overflow-x: auto; overflow-y: hidden; padding: 0.2em 0; }
        .math-fallback { white-space: pre-wrap; }
        .message-body.response-markdown { white-space: normal; }
        .response-markdown > :first-child { margin-top: 0; }
        .response-markdown > :last-child { margin-bottom: 0; }
        .response-markdown p { margin: 0.55em 0; }
        .response-markdown pre { overflow-x: auto; white-space: pre; }
        .response-markdown code { font-family: monospace; }
        .response-markdown ul, .response-markdown ol { padding-left: 1.5em; }
        .response-markdown table { border-collapse: collapse; }
        .response-markdown td, .response-markdown th { padding: 0.3em 0.6em; border: 1px solid var(--border); }
        .response-markdown a { color: inherit; text-decoration: underline; }
        .response-markdown strong { font-weight: 700; }
    `;
    root.appendChild(style);
}
