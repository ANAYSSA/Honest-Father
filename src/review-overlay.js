(() => {
    const annotations = document.getElementById('annotations');
    const notice = document.getElementById('notice');
    const SVG_NS = 'http://www.w3.org/2000/svg';

    function clear() {
        annotations.replaceChildren();
        notice.hidden = true;
        notice.textContent = '';
    }

    const unsubscribe = window.reviewOverlay.onUpdate(payload => {
        clear();
        if (!payload || typeof payload !== 'object') return;
        if (payload.kind === 'status') {
            if (typeof payload.text !== 'string' || payload.text.length > 500) return;
            notice.textContent = payload.text;
            notice.hidden = false;
            return;
        }
        if (payload.kind !== 'answer' || !Array.isArray(payload.answers) || payload.answers.length > 8) return;
        for (const answer of payload.answers) {
            const box = answer?.box;
            if (
                !box ||
                !['x', 'y', 'width', 'height'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key])) ||
                box.x < 0 ||
                box.y < 0 ||
                box.width <= 0 ||
                box.height <= 0
            ) {
                clear();
                return;
            }
            const ring = document.createElementNS(SVG_NS, 'ellipse');
            ring.setAttribute('cx', String(box.x + box.width / 2));
            ring.setAttribute('cy', String(box.y + box.height / 2));
            ring.setAttribute('rx', String(Math.max(8, box.width / 2 + 5)));
            ring.setAttribute('ry', String(Math.max(8, box.height / 2 + 5)));
            ring.setAttribute('class', 'answer-ring');
            annotations.append(ring);
        }
    });
    window.addEventListener('unload', unsubscribe, { once: true });
})();
