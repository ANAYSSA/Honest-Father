const test = require('node:test');
const assert = require('node:assert/strict');
const { REVIEW_SYSTEM_PROMPT, REVIEW_USER_PROMPT, parseReviewAnswer, mapReviewAnswerToDisplay } = require('../src/utils/testReview');

function response(overrides = {}) {
    return {
        question_box: [100, 200, 900, 800],
        answers: [{ label: 'B', box: [400, 300, 420, 320] }],
        confidence: 0.95,
        ...overrides,
    };
}

test('a complete high-confidence answer preserves normalized coordinates and trims labels', () => {
    const payload = response({ answers: [{ label: '  B. 42  ', box: [400.5, 300.25, 420.75, 320.5] }] });
    assert.deepEqual(parseReviewAnswer(JSON.stringify(payload)), {
        questionBox: [100, 200, 900, 800],
        answers: [{ label: 'B. 42', box: [400.5, 300.25, 420.75, 320.5] }],
        confidence: 0.95,
    });
});

test('the final JSON may be enclosed in one complete JSON or unlabeled code fence', () => {
    const json = JSON.stringify(response());
    for (const text of [json, ` \n${json}\n `, `\`\`\`json\n${json}\n\`\`\``, `\`\`\`\n${json}\n\`\`\``]) {
        assert.equal(parseReviewAnswer(text).answers[0].label, 'B');
    }
});

test('partial streams, malformed JSON, surrounding prose, and additional JSON objects cannot create annotations', () => {
    const json = JSON.stringify(response());
    for (const text of [
        undefined,
        '',
        json.slice(0, -1),
        '{"answers":',
        `${json}\n${json}`,
        `The answer is B.\n${json}`,
        `${json}\nExplanation: B is correct.`,
        `\`\`\`json\n${json}`,
        `\`\`\`json\n${json}\n\`\`\`\nExplanation`,
        `\`\`\`javascript\n${json}\n\`\`\``,
        '[1,2,3]',
        'null',
    ]) {
        assert.throws(() => parseReviewAnswer(text), Error, String(text));
    }
});

test('unexpected fields, missing fields, or structurally invalid answers are rejected', () => {
    const missingQuestion = response();
    delete missingQuestion.question_box;
    for (const payload of [
        missingQuestion,
        response({ explanation: 'B' }),
        response({ answers: 'B' }),
        response({ answers: [null] }),
        response({ answers: [{ label: 'B' }] }),
        response({ answers: [{ label: 'B', box: [400, 300, 420, 320], selected: true }] }),
    ]) {
        assert.throws(() => parseReviewAnswer(JSON.stringify(payload)), Error);
    }
});

test('refusals and low confidence produce a usable retry error without accepting a guessed box', () => {
    for (const confidence of [0, 0.5, 0.79999]) {
        assert.throws(() => parseReviewAnswer(JSON.stringify(response({ confidence }))), /could not be identified confidently/);
    }
    assert.throws(() => parseReviewAnswer('{"question_box":[0,0,0,0],"answers":[],"confidence":0}'), /Show one complete multiple-choice question/);
    assert.equal(parseReviewAnswer(JSON.stringify(response({ confidence: 0.8 }))).confidence, 0.8);
});

test('confidence must be a finite number in the unit interval', () => {
    for (const confidence of [-0.1, 1.1, '0.95', null, true]) {
        assert.throws(() => parseReviewAnswer(JSON.stringify(response({ confidence }))), /invalid confidence/);
    }
    const parsed = parseReviewAnswer(JSON.stringify(response()));
    for (const confidence of [NaN, Infinity, -Infinity]) {
        assert.throws(() => mapReviewAnswerToDisplay({ ...parsed, confidence }, { x: 0, y: 0, width: 1000, height: 1000 }), /invalid confidence/);
    }
});

test('coordinates must be finite numbers in range with positive ordered dimensions', () => {
    for (const box of [
        [-1, 300, 420, 320],
        [400, 300, 1001, 320],
        [400, 300, 400, 320],
        [420, 300, 400, 320],
        [400, 320, 420, 300],
        [400, 300, 420, 300],
        ['400', 300, 420, 320],
        [400, 300, 420],
        [400, 300, 420, 320, 321],
        [400, null, 420, 320],
    ]) {
        assert.throws(() => parseReviewAnswer(JSON.stringify(response({ answers: [{ label: 'B', box }] }))), /invalid control location/);
        assert.throws(() => parseReviewAnswer(JSON.stringify(response({ question_box: box }))), /invalid control location/);
    }
    const parsed = parseReviewAnswer(JSON.stringify(response()));
    for (const coordinate of [NaN, Infinity, -Infinity]) {
        const answers = [{ label: 'B', box: [400, coordinate, 420, 320] }];
        assert.throws(() => mapReviewAnswerToDisplay({ ...parsed, answers }, { x: 0, y: 0, width: 1000, height: 1000 }), /invalid control location/);
    }
});

test('choices outside the question and duplicate controls cannot be annotated', () => {
    assert.throws(() => parseReviewAnswer(JSON.stringify(response({ answers: [{ label: 'B', box: [50, 300, 80, 320] }] }))), /outside the question/);
    const sameBox = [400, 300, 420, 320];
    assert.throws(
        () =>
            parseReviewAnswer(
                JSON.stringify(
                    response({
                        answers: [
                            { label: 'A', box: sameBox },
                            { label: 'B', box: sameBox },
                        ],
                    })
                )
            ),
        /repeats the same control/
    );
});

test('oversized boxes cannot mask answer text or changed question content', () => {
    for (const box of [
        [400, 300, 481, 320],
        [400, 300, 420, 381],
    ]) {
        assert.throws(() => parseReviewAnswer(JSON.stringify(response({ answers: [{ label: 'B', box }] }))), /control is too large/);
    }
    assert.equal(parseReviewAnswer(JSON.stringify(response({ answers: [{ label: 'B', box: [400, 300, 480, 380] }] }))).answers.length, 1);
});

test('one to eight correct choices are accepted and empty or oversized answer lists are refused', () => {
    const answers = Array.from({ length: 8 }, (_, index) => ({ label: String(index + 1), box: [200 + index * 50, 300, 220 + index * 50, 320] }));
    assert.equal(parseReviewAnswer(JSON.stringify(response({ answers }))).answers.length, 8);
    for (const choices of [[], [...answers, { label: '9', box: [700, 300, 720, 320] }]]) {
        assert.throws(() => parseReviewAnswer(JSON.stringify(response({ answers: choices }))), /between one and eight/);
    }
});

test('option labels are bounded nonempty strings without control characters', () => {
    for (const label of [null, 5, '', '   ', 'B\nClick here', 'B\u0000', 'B\u007f', 'A'.repeat(161)]) {
        assert.throws(() => parseReviewAnswer(JSON.stringify(response({ answers: [{ label, box: [400, 300, 420, 320] }] }))), /invalid option label/);
    }
    assert.equal(
        parseReviewAnswer(JSON.stringify(response({ answers: [{ label: 'Вариант Б — 42', box: [400, 300, 420, 320] }] }))).answers[0].label,
        'Вариант Б — 42'
    );
    assert.throws(() => parseReviewAnswer(' '.repeat(20001)), /complete answer/);
});

test('mapping uses local display DIP coordinates even for a negative monitor origin and Retina scale', () => {
    const answer = parseReviewAnswer(JSON.stringify(response()));
    const mapped = mapReviewAnswerToDisplay(answer, { x: -1440, y: -200, width: 1440, height: 900, scaleFactor: 2 });
    assert.deepEqual(mapped, {
        questionBox: { x: 288, y: 90, width: 864, height: 720 },
        answers: [{ label: 'B', box: { x: 432, y: 360, width: 28.8, height: 18 } }],
        confidence: 0.95,
    });
    assert.deepEqual(answer.questionBox, [100, 200, 900, 800]);
    assert.deepEqual(answer.answers[0].box, [400, 300, 420, 320]);
});

test('observed control sizes and proportions survive screenshot normalization without a fixed control template', () => {
    const fixtures = [
        {
            screenshot: { width: 3000, height: 1800 },
            display: { x: -1500, y: -300, width: 1500, height: 900, scaleFactor: 2 },
            controls: [
                { x: 420, y: 360, width: 48, height: 48 },
                { x: 850, y: 500, width: 144, height: 36 },
                { x: 1600, y: 700, width: 30, height: 96 },
                { x: 2200, y: 1200, width: 120, height: 120 },
                { x: 600, y: 1000, width: 8, height: 8 },
            ],
        },
        {
            screenshot: { width: 960, height: 1600 },
            display: { x: 1500, y: 100, width: 480, height: 800, scaleFactor: 2 },
            controls: [
                { x: 200, y: 320, width: 20, height: 20 },
                { x: 600, y: 650, width: 64, height: 16 },
                { x: 400, y: 1100, width: 16, height: 96 },
            ],
        },
    ];
    const approximately = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);
    for (const { screenshot, display, controls } of fixtures) {
        const answers = controls.map((control, index) => ({
            label: String(index + 1),
            box: [
                (control.y / screenshot.height) * 1000,
                (control.x / screenshot.width) * 1000,
                ((control.y + control.height) / screenshot.height) * 1000,
                ((control.x + control.width) / screenshot.width) * 1000,
            ],
        }));
        const parsed = parseReviewAnswer(JSON.stringify(response({ question_box: [0, 0, 1000, 1000], answers })));
        assert.deepEqual(parsed.answers, answers);
        const mapped = mapReviewAnswerToDisplay(parsed, display);
        assert.equal(mapped.answers.length, controls.length);
        mapped.answers.forEach(({ label, box }, index) => {
            const control = controls[index];
            assert.equal(label, answers[index].label);
            approximately(box.x, control.x / 2);
            approximately(box.y, control.y / 2);
            approximately(box.width, control.width / 2);
            approximately(box.height, control.height / 2);
            approximately(box.x + box.width / 2, (control.x + control.width / 2) / 2);
            approximately(box.y + box.height / 2, (control.y + control.height / 2) / 2);
        });
    }
});

test('full-screen normalized edges map to the display size without rounding or a global origin', () => {
    const answer = parseReviewAnswer(JSON.stringify(response({ question_box: [0, 0, 1000, 1000] })));
    assert.deepEqual(mapReviewAnswerToDisplay(answer, { x: 2560, y: 240, width: 1920, height: 1080 }).questionBox, {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    });
});

test('invalid display bounds and unvalidated mapped answers are refused', () => {
    const answer = parseReviewAnswer(JSON.stringify(response()));
    for (const bounds of [
        null,
        {},
        { x: 0, y: 0, width: 0, height: 900 },
        { x: 0, y: 0, width: 1440, height: -1 },
        { x: NaN, y: 0, width: 1440, height: 900 },
    ]) {
        assert.throws(() => mapReviewAnswerToDisplay(answer, bounds), /captured display/);
    }
    assert.throws(() => mapReviewAnswerToDisplay({ ...answer, confidence: 0.3 }, { x: 0, y: 0, width: 1000, height: 1000 }), /confidently/);
    assert.throws(() => mapReviewAnswerToDisplay(response(), { x: 0, y: 0, width: 1000, height: 1000 }), /required format/);
});

test('review prompts require complete structured visual controls and an explicit uncertainty refusal', () => {
    assert.match(REVIEW_SYSTEM_PROMPT, /ENTIRE screenshot/);
    assert.match(REVIEW_SYSTEM_PROMPT, /radio button or checkbox/);
    assert.match(REVIEW_SYSTEM_PROMPT, /round, square, or styled differently/);
    assert.match(REVIEW_SYSTEM_PROMPT, /actual visible bounding boxes/);
    assert.match(REVIEW_SYSTEM_PROMPT, /not shape alone/);
    assert.match(REVIEW_SYSTEM_PROMPT, /single-selection\/radio-button questions return exactly one/);
    assert.match(REVIEW_SYSTEM_PROMPT, /explicitly allowing multiple selections/);
    assert.match(REVIEW_SYSTEM_PROMPT, /confidence is at least 0\.8/);
    assert.match(REVIEW_SYSTEM_PROMPT, /Do not click, select, submit/);
    assert.match(REVIEW_SYSTEM_PROMPT, /"answers":\[\],"confidence":0/);
    assert.match(REVIEW_USER_PROMPT, /complete JSON/);
});

test('review prompts solve before locating and distinguish chosen answers from all visible controls', () => {
    assert.match(REVIEW_SYSTEM_PROMPT, /Solve the question first.*before locating its control/);
    assert.match(REVIEW_SYSTEM_PROMPT, /answers array is ONLY the chosen correct option or options, not a list of all visible choices or controls/);
    assert.match(REVIEW_SYSTEM_PROMPT, /Omit every incorrect or unchosen option/);
    assert.match(REVIEW_SYSTEM_PROMPT, /Assume single selection unless the visible question explicitly allows multiple selections/);
    assert.match(REVIEW_SYSTEM_PROMPT, /multiple selection is not explicitly allowed, refuse rather than return several answers/);
    assert.match(REVIEW_SYSTEM_PROMPT, /2 \+ 2\?.*exactly one answers entry, for B's control/);
    assert.match(REVIEW_SYSTEM_PROMPT, /Do not include A's or C's controls/);
    assert.match(REVIEW_USER_PROMPT, /Solve.*first/);
    assert.match(REVIEW_USER_PROMPT, /never all visible choices/);
    assert.match(REVIEW_USER_PROMPT, /exactly one answer unless the question explicitly allows multiple selections/);
});
