/**
 * Unit tests for the dual-track test infrastructure:
 * src/lib/tests.ts (assembly) and src/lib/test-attempts.ts (scoring, revision).
 *
 * Both modules are pure where it matters and that is deliberate, for the same
 * reason src/lib/revision.ts and src/lib/attempts.ts are: a wrong assembly hands
 * a student a question with no right answer, and a wrong combined score feeds a
 * wrong signal into every future revision session. Neither should ship untested,
 * and neither needs a browser to test.
 *
 * `src/lib/test-attempts.ts` is "use client" and imports Dexie, and
 * `src/lib/tests.ts` imports JSON through a bundler alias, so — exactly as
 * scripts/test-sm2.mjs and scripts/test-attempts.mjs do — the logic is mirrored
 * here and the sources are guarded with patterns, so that a mirror which has
 * drifted from the shipped code fails loudly rather than passing quietly. Every
 * assertion below then runs against the *real* content files.
 *
 *   node scripts/test-dualtrack.mjs
 */
import { readFile } from "node:fs/promises";

const read = async (p) => JSON.parse(await readFile(p, "utf8"));

const testsSrc = await readFile("src/lib/tests.ts", "utf8");
const attemptsSrc = await readFile("src/lib/test-attempts.ts", "utf8");
const quizSrc = await readFile("src/lib/quiz.ts", "utf8");

const manifest = await read("data/manifest.json");
const questionsFile = await read("data/questions.json");
const papersFile = await read("data/papers.json");
const rubricsFile = await read("data/rubrics.json");

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ── 0. Guards: the mirror must still describe the shipped code ─────────────

for (const [name, src, pattern] of [
  ["tests.ts drops a rubric whose book the manifest does not know", testsSrc, /if \(!book\) return undefined;/],
  ["tests.ts rejects a class the book contradicts", testsSrc, /declaredClass !== book\.class\) return undefined/],
  ["tests.ts rejects a subject the book contradicts", testsSrc, /declaredSubject\.toLowerCase\(\) !== book\.subject\.toLowerCase\(\)/],
  ["tests.ts needs both tracks", testsSrc, /if \(sectionB\.length === 0\) return undefined;/],
  ["tests.ts assembles from the quiz bank", testsSrc, /questionsForClass\(paper\.class\)/],
  ["tests.ts rotation is deterministic", testsSrc, /hash\(paper\.slug\) % pool\.length/],
  ["test-attempts.ts reuses the attempts.ts clock", attemptsSrc, /from "\.\/attempts"/],
  ["test-attempts.ts re-exports the clock rather than copying it", attemptsSrc, /export \{ formatClock, isExpired, remainingMs \}/],
  ["test-attempts.ts lets a grade supersede the self-report", attemptsSrc, /if \(answer\.handoff\.grade\) return answer\.handoff\.grade\.awarded;/],
  ["test-attempts.ts skips unscored written answers", attemptsSrc, /if \(marks === null\) continue;/],
  ["test-attempts.ts writes one card per chapter", attemptsSrc, /sourceType: "exercise",[\s\S]{0,200}questionNo: bucket\.chapter/],
  ["quiz.ts still lets the manifest decide class and subject", quizSrc, /cls = book\.class;\s*\n\s*subject = book\.subject;/],
]) {
  if (!pattern.test(src)) {
    console.error(`FAIL  ${name}: source no longer matches ${pattern}`);
    process.exit(1);
  }
}

// The whole point of deriving the clock is that nothing accumulates ticks.
if (/setInterval|setTimeout/.test(attemptsSrc)) {
  console.error("FAIL  src/lib/test-attempts.ts must not accumulate time from timers");
  process.exit(1);
}
// A shuffled assembly could not be statically exported: two builds would differ.
if (/Math\.random/.test(testsSrc)) {
  console.error("FAIL  src/lib/tests.ts must assemble deterministically");
  process.exit(1);
}

// ── 1. Mirrored: the manifest ─────────────────────────────────────────────

const books = new Map(manifest.books.map((b) => [b.code, b]));
const getBook = (code) => books.get(code);
const getChapter = (code, n) => getBook(code)?.chapters.find((c) => c.n === n);

const subjectByName = new Map();
for (const b of manifest.books) {
  subjectByName.set(`${b.class}:${b.subject.toLowerCase()}`, b.subject);
}

// ── 2. Mirrored: quiz.ts normalisation ────────────────────────────────────

function pick(row, ...keys) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}
const asString = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
function asNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function normaliseAnswer(v, options) {
  if (typeof v === "number" && Number.isInteger(v)) {
    if (v >= 0 && v < options.length) return v;
    if (v >= 1 && v <= options.length) return v - 1;
    return undefined;
  }
  const s = asString(v);
  if (s === undefined) return undefined;
  const exact = options.findIndex((o) => o === s);
  if (exact !== -1) return exact;
  if (/^[A-Za-z]$/.test(s)) {
    const i = s.toUpperCase().charCodeAt(0) - 65;
    if (i >= 0 && i < options.length) return i;
  }
  const n = Number(s);
  if (Number.isInteger(n)) return normaliseAnswer(n, options);
  const loose = s.toLowerCase().replace(/\s+/g, " ");
  const near = options.findIndex((o) => o.toLowerCase().replace(/\s+/g, " ") === loose);
  return near === -1 ? undefined : near;
}

function normaliseQuestion(row) {
  const question = asString(pick(row, "question", "text", "stem", "q"));
  if (!question) return undefined;
  const rawOptions = pick(row, "options", "choices", "opts");
  if (!Array.isArray(rawOptions)) return undefined;
  const options = rawOptions.map((o) => asString(o) ?? "").filter(Boolean);
  if (options.length < 2 || new Set(options).size !== options.length) return undefined;
  const answer = normaliseAnswer(
    pick(row, "answer", "answerIndex", "correct", "correctIndex", "correctAnswer", "correctOption"),
    options,
  );
  if (answer === undefined) return undefined;

  const code = asString(pick(row, "bookCode", "book", "code"));
  const book = code ? getBook(code) : undefined;
  const chapter = asNumber(pick(row, "chapter", "chapterNo", "chapterNumber", "ch"));

  let cls;
  let subject;
  let bookCode;
  let chapterNo;
  if (book) {
    // The manifest decides; the row's own claim is ignored.
    cls = book.class;
    subject = book.subject;
    bookCode = book.code;
    if (chapter !== undefined && getChapter(book.code, chapter)) chapterNo = chapter;
  } else {
    const declared = asNumber(pick(row, "class", "classNum", "grade"));
    const named = asString(pick(row, "subject"));
    cls = declared === 9 || declared === 10 ? declared : undefined;
    subject = named ? subjectByName.get(`${cls}:${named.toLowerCase()}`) : undefined;
    if (cls === undefined || !subject) return undefined;
  }

  const id = asString(pick(row, "id", "qid", "key"));
  if (!id) return undefined;

  return {
    id,
    class: cls,
    subject,
    bookCode,
    chapter: chapterNo,
    type: (asString(pick(row, "type")) ?? "mcq").toLowerCase(),
    question,
    options,
    answer,
    explanation: asString(pick(row, "explanation")),
    marks: asNumber(pick(row, "marks", "mark")) ?? 1,
  };
}

const questionRows = questionsFile.questions ?? questionsFile.items ?? questionsFile;
const bank = [];
const seenQuestions = new Set();
for (const row of questionRows) {
  const q = normaliseQuestion(row);
  if (!q || seenQuestions.has(q.id)) continue;
  seenQuestions.add(q.id);
  bank.push(q);
}

// ── 3. Mirrored: tests.ts rubric normalisation and assembly ───────────────

function normaliseRubric(row) {
  const id = asString(pick(row, "id"));
  const paper = asString(pick(row, "paper", "paperSlug", "slug"));
  const questionNo = asNumber(pick(row, "questionNo", "qNo", "number"));
  const maxMarks = asNumber(pick(row, "maxMarks", "marks", "totalMarks"));
  if (!id || !paper || questionNo === undefined || !Number.isInteger(questionNo)) return undefined;
  if (maxMarks === undefined || maxMarks <= 0) return undefined;

  const code = asString(pick(row, "bookCode", "book", "code"));
  const book = code ? getBook(code) : undefined;
  if (!book) return undefined;

  const chapter = asNumber(pick(row, "chapter", "chapterNo", "chapterNumber", "ch"));
  if (chapter === undefined || !getChapter(book.code, chapter)) return undefined;

  const declaredClass = asNumber(pick(row, "class", "classNum", "grade"));
  if (declaredClass !== undefined && declaredClass !== book.class) return undefined;
  const declaredSubject = asString(pick(row, "subject"));
  if (declaredSubject && declaredSubject.toLowerCase() !== book.subject.toLowerCase()) {
    return undefined;
  }

  return {
    paper,
    questionNo,
    rubric: {
      id,
      variant: asString(pick(row, "variant")),
      maxMarks,
      bookCode: book.code,
      chapter,
      needsReview: pick(row, "needsReview") === true,
    },
  };
}

function buildRubricIndex(file) {
  const rows = file.rubrics ?? file.items ?? file;
  const out = new Map();
  const seen = new Set();
  for (const row of rows) {
    const parsed = normaliseRubric(row);
    if (!parsed || seen.has(parsed.rubric.id)) continue;
    seen.add(parsed.rubric.id);
    const byQuestion = out.get(parsed.paper) ?? new Map();
    const list = byQuestion.get(parsed.questionNo) ?? [];
    list.push(parsed.rubric);
    byQuestion.set(parsed.questionNo, list);
    out.set(parsed.paper, byQuestion);
  }
  for (const byQuestion of out.values()) {
    for (const list of byQuestion.values()) {
      list.sort(
        (a, b) => (a.variant ?? "").localeCompare(b.variant ?? "") || a.id.localeCompare(b.id),
      );
    }
  }
  return out;
}

const rubricIndex = buildRubricIndex(rubricsFile);

const AUTO_TYPES = new Set(["mcq", "assertion-reason"]);
const WRITTEN_TYPES = new Set(["vsa", "sa", "la", "case-study"]);

const isScorable = (paper) => paper.sectionsDerived !== false;

function questionsFor(paper) {
  return [...paper.sections]
    .sort((a, b) => a.from - b.from)
    .flatMap((s) =>
      Array.from({ length: s.to - s.from + 1 }, (_, i) => ({
        n: s.from + i,
        maxMarks: s.marksEach,
        type: s.type,
        section: s.label,
        topic: s.topic,
      })),
    );
}

function bankSubjectFor(paper) {
  const direct = subjectByName.get(`${paper.class}:${paper.subject.toLowerCase()}`);
  if (direct) return direct;
  const stripped = paper.subject.replace(/\s*\([^)]*\)\s*/g, " ").trim().toLowerCase();
  return stripped ? subjectByName.get(`${paper.class}:${stripped}`) : undefined;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function byBookChapter(a, b) {
  return (
    (a.bookCode ?? "￿").localeCompare(b.bookCode ?? "￿") ||
    (a.chapter ?? Number.MAX_SAFE_INTEGER) - (b.chapter ?? Number.MAX_SAFE_INTEGER) ||
    a.id.localeCompare(b.id)
  );
}

function scaledDuration(paper, marks) {
  if (paper.maxMarks <= 0 || marks <= 0) return paper.durationMinutes;
  return Math.max(15, Math.round((paper.durationMinutes * marks) / paper.maxMarks / 5) * 5);
}

function assembleTest(paper, pool = bank) {
  if (!isScorable(paper)) return undefined;
  const subject = bankSubjectFor(paper);
  if (!subject) return undefined;

  const candidates = pool.filter((q) => q.class === paper.class && q.subject === subject)
    .slice()
    .sort(byBookChapter);
  if (candidates.length === 0) return undefined;

  const printed = paper.sections
    .filter((s) => AUTO_TYPES.has(s.type))
    .reduce((n, s) => n + Math.max(0, s.to - s.from + 1), 0);
  const wanted = Math.min(printed, candidates.length);
  if (wanted === 0) return undefined;

  let picked;
  if (wanted >= candidates.length) {
    picked = candidates;
  } else {
    const offset = hash(paper.slug) % candidates.length;
    picked = Array.from({ length: wanted }, (_, i) => candidates[(offset + i) % candidates.length]);
    picked.sort(byBookChapter);
  }

  const sectionA = picked.map((question, i) => ({ n: i + 1, question, marks: question.marks }));

  const sectionB = questionsFor(paper)
    .filter((q) => WRITTEN_TYPES.has(q.type))
    .map((q) => {
      const rubrics = rubricIndex.get(paper.slug)?.get(q.n) ?? [];
      const first = rubrics[0];
      const agreed =
        first && rubrics.every((r) => r.bookCode === first.bookCode && r.chapter === first.chapter)
          ? first
          : undefined;
      return {
        n: q.n,
        section: q.section,
        topic: q.topic,
        type: q.type,
        maxMarks: q.maxMarks,
        rubrics,
        bookCode: agreed?.bookCode,
        chapter: agreed?.chapter,
      };
    });
  if (sectionB.length === 0) return undefined;

  const sectionAMarks = sectionA.reduce((n, i) => n + i.marks, 0);
  const sectionBMarks = sectionB.reduce((n, i) => n + i.maxMarks, 0);
  const maxMarks = sectionAMarks + sectionBMarks;

  return {
    slug: paper.slug,
    paperSlug: paper.slug,
    classNum: paper.class,
    subject,
    session: paper.session,
    durationMinutes: scaledDuration(paper, maxMarks),
    sectionA,
    sectionB,
    sectionAMarks,
    sectionBMarks,
    maxMarks,
    rubricCount: sectionB.filter((i) => i.rubrics.length > 0).length,
  };
}

const allPapers = [...papersFile.papers].sort(
  (a, b) => a.class - b.class || a.subject.localeCompare(b.subject),
);
const tests = allPapers.map((p) => assembleTest(p)).filter(Boolean);

// ── 4. Mirrored: test-attempts.ts scoring ─────────────────────────────────

function markSectionA(responses) {
  let correct = 0;
  let answered = 0;
  let marks = 0;
  let maxMarks = 0;
  const wrong = [];
  for (const r of responses) {
    maxMarks += r.maxMarks;
    if (r.chosen !== null) answered++;
    if (r.chosen !== null && r.chosen === r.correct) {
      correct++;
      marks += r.maxMarks;
    } else {
      wrong.push(r.questionId);
    }
  }
  return { correct, answered, total: responses.length, marks, maxMarks, wrong };
}

function writtenMarks(answer) {
  if (answer.status === "unattempted") return 0;
  if (answer.handoff.grade) return answer.handoff.grade.awarded;
  return answer.selfMarks;
}

function scoreTest(attempt) {
  const a = markSectionA(attempt.sectionA);
  let sectionBMarks = 0;
  let sectionBMax = 0;
  let unscored = 0;
  for (const w of attempt.sectionB) {
    sectionBMax += w.maxMarks;
    const marks = writtenMarks(w);
    if (marks === null) unscored++;
    else sectionBMarks += marks;
  }
  return {
    sectionAMarks: a.marks,
    sectionAMax: a.maxMarks,
    sectionBMarks,
    sectionBMax,
    total: a.marks + sectionBMarks,
    maxMarks: a.maxMarks + sectionBMax,
    unscored,
  };
}

function confidenceFor(score, maxMarks) {
  if (score <= 0) return "again";
  const ratio = maxMarks > 0 ? score / maxMarks : 0;
  if (ratio >= 0.9) return "easy";
  if (ratio >= 0.6) return "good";
  return "hard";
}

/** Mirrors writeRevisionCards: the cards a finished sitting would write. */
function revisionWrites(attempt) {
  const buckets = new Map();
  const pour = (bookCode, chapter, score, maxMarks) => {
    const key = `${bookCode}:${chapter}`;
    const b = buckets.get(key) ?? { bookCode, chapter, score: 0, maxMarks: 0 };
    b.score += score;
    b.maxMarks += maxMarks;
    buckets.set(key, b);
  };

  for (const r of attempt.sectionA) {
    if (!r.bookCode || r.chapter === undefined) continue;
    pour(r.bookCode, r.chapter, r.chosen === r.correct ? r.maxMarks : 0, r.maxMarks);
  }

  const loose = [];
  for (const w of attempt.sectionB) {
    const marks = writtenMarks(w);
    if (marks === null) continue;
    const { bookCode, chapter } = w.handoff;
    if (bookCode && chapter !== undefined) pour(bookCode, chapter, marks, w.maxMarks);
    else loose.push(w);
  }

  const cards = [...buckets.values()].map((b) => ({
    id: `exercise:${b.bookCode}:${b.chapter}`,
    score: b.score,
    maxMarks: b.maxMarks,
    confidence: confidenceFor(b.score, b.maxMarks),
  }));
  for (const w of loose) {
    const marks = writtenMarks(w) ?? 0;
    cards.push({
      id: `paper:${attempt.paperSlug}:${w.n}`,
      score: marks,
      maxMarks: w.maxMarks,
      confidence: confidenceFor(marks, w.maxMarks),
    });
  }
  return cards;
}

/** Mirrors startTestAttempt's projection of a test onto a blank attempt. */
function blankAttempt(test, id = "t:1") {
  return {
    id,
    paperSlug: test.paperSlug,
    sectionA: test.sectionA.map((item) => ({
      n: item.n,
      questionId: item.question.id,
      bookCode: item.question.bookCode,
      chapter: item.question.chapter,
      maxMarks: item.marks,
      correct: item.question.answer,
      chosen: null,
    })),
    sectionB: test.sectionB.map((item) => ({
      n: item.n,
      section: item.section,
      maxMarks: item.maxMarks,
      status: "unattempted",
      selfMarks: null,
      handoff: {
        id: `${id}#${item.n}`,
        attemptId: id,
        paperSlug: test.paperSlug,
        questionNo: item.n,
        maxMarks: item.maxMarks,
        rubricIds: item.rubrics.map((r) => r.id),
        bookCode: item.bookCode,
        chapter: item.chapter,
      },
    })),
    maxMarks: test.maxMarks,
  };
}

// ── 5. Assembly ───────────────────────────────────────────────────────────

console.log(`\n— assembly (${tests.length} tests from ${allPapers.length} papers) —`);

check("at least one dual-track test assembles from the shipped content", tests.length > 0);

// Determinism is what makes /test/[slug] statically exportable: the same input
// must give byte-identical output, run after run.
const again = allPapers.map((p) => assembleTest(p)).filter(Boolean);
check(
  "assembly is deterministic",
  JSON.stringify(tests) === JSON.stringify(again),
  `${tests.length} tests`,
);

check(
  "every test has both tracks",
  tests.every((t) => t.sectionA.length > 0 && t.sectionB.length > 0),
);

check(
  "marks add up: A + B = total",
  tests.every((t) => Math.abs(t.sectionAMarks + t.sectionBMarks - t.maxMarks) < 1e-9),
);

check(
  "no Section A question is shown without a right answer",
  tests.every((t) =>
    t.sectionA.every(
      (i) =>
        Number.isInteger(i.question.answer) &&
        i.question.answer >= 0 &&
        i.question.answer < i.question.options.length,
    ),
  ),
);

check(
  "Section A is only ever auto-markable forms",
  tests.every((t) => t.sectionA.every((i) => i.question.options.length >= 2)),
);

check(
  "Section B is only ever descriptive forms",
  tests.every((t) => t.sectionB.every((i) => WRITTEN_TYPES.has(i.type))),
);

check(
  "Section B keeps the paper's own question numbers, ascending",
  tests.every((t) => t.sectionB.every((i, k, all) => k === 0 || i.n > all[k - 1].n)),
);

check(
  "Section A questions belong to the test's own class and subject",
  tests.every((t) =>
    t.sectionA.every((i) => i.question.class === t.classNum && i.question.subject === t.subject),
  ),
);

check(
  "no test is longer than the paper it came from",
  tests.every((t) => {
    const paper = allPapers.find((p) => p.slug === t.paperSlug);
    return t.durationMinutes <= paper.durationMinutes;
  }),
);

check(
  "every attached rubric points at a chapter the manifest has",
  tests.every((t) =>
    t.sectionB.every((i) => i.rubrics.every((r) => Boolean(getChapter(r.bookCode, r.chapter)))),
  ),
);

check(
  "a written question carries a chapter only when its rubrics agree on one",
  tests.every((t) =>
    t.sectionB.every((i) =>
      i.chapter === undefined
        ? true
        : i.rubrics.length > 0 &&
          i.rubrics.every((r) => r.bookCode === i.bookCode && r.chapter === i.chapter),
    ),
  ),
);

const withRubrics = tests.reduce((n, t) => n + t.rubricCount, 0);
check("rubrics reach the tests that have them", withRubrics > 0, `${withRubrics} attached`);

// ── 6. Malformed input is dropped, never shown ────────────────────────────

console.log("\n— malformed input —");

const goodQuestion = {
  id: "x1",
  bookCode: "jesc1",
  chapter: 1,
  question: "Which is it?",
  options: ["A thing", "Another thing"],
  answer: 1,
  marks: 1,
};
check("a sound question survives", normaliseQuestion(goodQuestion) !== undefined);
check(
  "an answer index past the options is dropped",
  normaliseQuestion({ ...goodQuestion, answer: 9 }) === undefined,
);
check(
  "a question with one option is dropped",
  normaliseQuestion({ ...goodQuestion, options: ["Only this"] }) === undefined,
);
check(
  "a question with no answer at all is dropped",
  normaliseQuestion({ ...goodQuestion, answer: undefined }) === undefined,
);
check(
  "duplicate options are dropped — two of them cannot both be right",
  normaliseQuestion({ ...goodQuestion, options: ["Same", "Same"] }) === undefined,
);
check(
  "the manifest overrides a mis-tagged class",
  normaliseQuestion({ ...goodQuestion, class: 9, subject: "Mathematics" })?.class === 10,
);
check(
  "the manifest overrides a mis-tagged subject",
  normaliseQuestion({ ...goodQuestion, subject: "Mathematics" })?.subject === "Science",
);
check(
  "a chapter the book does not have is refused rather than guessed",
  normaliseQuestion({ ...goodQuestion, chapter: 999 })?.chapter === undefined,
);

const goodRubric = {
  id: "r1",
  paper: "class10-science-2025-26",
  questionNo: 10,
  maxMarks: 2,
  bookCode: "jesc1",
  chapter: 5,
  class: 10,
  subject: "Science",
};
check("a sound rubric survives", normaliseRubric(goodRubric) !== undefined);
check(
  "a rubric with an unknown book is rejected",
  normaliseRubric({ ...goodRubric, bookCode: "nosuch" }) === undefined,
);
check(
  "a rubric with a chapter the book has not got is rejected",
  normaliseRubric({ ...goodRubric, chapter: 999 }) === undefined,
);
check(
  "a rubric whose class the book contradicts is rejected, not corrected",
  normaliseRubric({ ...goodRubric, class: 9 }) === undefined,
);
check(
  "a rubric whose subject the book contradicts is rejected",
  normaliseRubric({ ...goodRubric, subject: "Mathematics" }) === undefined,
);
check(
  "a rubric with no marks is rejected",
  normaliseRubric({ ...goodRubric, maxMarks: 0 }) === undefined,
);
check(
  "tolerated spellings are accepted",
  normaliseRubric({
    id: "r2",
    paperSlug: "class10-science-2025-26",
    qNo: 10,
    marks: 2,
    book: "jesc1",
    ch: 5,
  }) !== undefined,
);

// A bank of nothing but malformed rows must assemble no test at all, rather
// than a test of questions with no right answer.
const rotten = [{ id: "bad", bookCode: "jesc1", question: "?", options: ["one"], answer: 4 }]
  .map(normaliseQuestion)
  .filter(Boolean);
check("a bank of only malformed rows assembles nothing", rotten.length === 0);
const science = allPapers.find((p) => p.slug === "class10-science-2025-26");
check(
  "a paper with no usable Section A yields no test",
  assembleTest(science, []) === undefined,
);

// ── 7. Section A marking ──────────────────────────────────────────────────

console.log("\n— Section A marking —");

const responses = [
  { n: 1, questionId: "q1", maxMarks: 1, correct: 2, chosen: 2 },
  { n: 2, questionId: "q2", maxMarks: 1, correct: 0, chosen: 3 },
  { n: 3, questionId: "q3", maxMarks: 1, correct: 1, chosen: null },
  { n: 4, questionId: "q4", maxMarks: 2, correct: 0, chosen: 0 },
];
const marked = markSectionA(responses);
check("correct answers counted", marked.correct === 2, `${marked.correct}`);
check("marks follow the question's own weight", marked.marks === 3, `${marked.marks}`);
check("max marks is the section's own total", marked.maxMarks === 5, `${marked.maxMarks}`);
check("a blank scores nothing but is still out of its marks", marked.answered === 3);
check(
  "the wrong list is what a retry would use",
  JSON.stringify(marked.wrong) === JSON.stringify(["q2", "q3"]),
);
check("an empty section is 0 out of 0, not NaN", markSectionA([]).maxMarks === 0);
// index 0 is a real answer, and `chosen: 0` must not be read as "unanswered"
check(
  "option A is not mistaken for a blank",
  markSectionA([{ n: 1, questionId: "z", maxMarks: 1, correct: 0, chosen: 0 }]).correct === 1,
);

// ── 8. The combined score ─────────────────────────────────────────────────

console.log("\n— the combined score —");

const written = (n, maxMarks, extra) => ({
  n,
  section: "B",
  maxMarks,
  status: "written",
  selfMarks: null,
  handoff: { id: `t:1#${n}`, attemptId: "t:1", paperSlug: "p", questionNo: n, maxMarks, rubricIds: [] },
  ...extra,
});

const sitting = {
  paperSlug: "p",
  sectionA: responses,
  sectionB: [
    written(10, 2, { selfMarks: 2 }),
    written(11, 3, { selfMarks: 1.5 }),
    written(12, 5, { status: "unattempted" }),
    written(13, 4, {}), // written, not yet marked
  ],
};

const s = scoreTest(sitting);
check("Section A total", s.sectionAMarks === 3, `${s.sectionAMarks}`);
check("Section B total", s.sectionBMarks === 3.5, `${s.sectionBMarks}`);
check("one sitting, one score", s.total === 6.5, `${s.total}`);
check("out of both sections together", s.maxMarks === 19, `${s.maxMarks}`);
check("an unmarked written answer is counted as unscored, not as zero", s.unscored === 1);
check("an unattempted written answer is a hard zero", writtenMarks(sitting.sectionB[2]) === 0);
check("an unmarked written answer has no mark yet", writtenMarks(sitting.sectionB[3]) === null);

// The grading lane's write must beat the student's own marking.
const graded = {
  ...sitting,
  sectionB: sitting.sectionB.map((w) =>
    w.n === 11
      ? {
          ...w,
          handoff: {
            ...w.handoff,
            grade: { awarded: 3, maxMarks: 3, gradedAt: 1, source: "rubric" },
          },
        }
      : w,
  ),
};
check("a rubric grade supersedes the self-report", scoreTest(graded).sectionBMarks === 5);
check("and the sitting's total moves with it", scoreTest(graded).total === 8);

// The handoff key must be stable and unambiguous, since another lane writes on it.
const assembled = tests.find((t) => t.slug === "class10-science-2025-26") ?? tests[0];
const blank = blankAttempt(assembled);
check(
  "one handoff per Section B question",
  blank.sectionB.length === assembled.sectionB.length,
  `${blank.sectionB.length}`,
);
check(
  "handoff ids are unique and resolve back to their attempt",
  new Set(blank.sectionB.map((w) => w.handoff.id)).size === blank.sectionB.length &&
    blank.sectionB.every((w) => w.handoff.id.split("#")[0] === blank.id),
);
check(
  "a handoff carries the paper's own question number",
  blank.sectionB.every((w) => w.handoff.questionNo === w.n),
);
check(
  "a handoff carries every rubric for its question",
  blank.sectionB.every(
    (w, i) => w.handoff.rubricIds.length === assembled.sectionB[i].rubrics.length,
  ),
);
check("a fresh sitting scores zero, not NaN", scoreTest(blank).total === 0);
check(
  "a fresh sitting is out of the test's own marks",
  Math.abs(scoreTest(blank).maxMarks - assembled.maxMarks) < 1e-9,
);

// ── 9. Revision cards ─────────────────────────────────────────────────────

console.log("\n— revision cards —");

const revisionSitting = {
  paperSlug: "class10-science-2025-26",
  sectionA: [
    { n: 1, questionId: "a1", bookCode: "jesc1", chapter: 1, maxMarks: 1, correct: 0, chosen: 0 },
    { n: 2, questionId: "a2", bookCode: "jesc1", chapter: 1, maxMarks: 1, correct: 0, chosen: 1 },
    { n: 3, questionId: "a3", bookCode: "jesc1", chapter: 2, maxMarks: 1, correct: 1, chosen: 1 },
    { n: 4, questionId: "a4", maxMarks: 1, correct: 1, chosen: 1 }, // no chapter at all
  ],
  sectionB: [
    written(10, 2, {
      selfMarks: 2,
      handoff: {
        id: "t:1#10",
        attemptId: "t:1",
        paperSlug: "class10-science-2025-26",
        questionNo: 10,
        maxMarks: 2,
        rubricIds: ["r"],
        bookCode: "jesc1",
        chapter: 1,
      },
    }),
    written(20, 5, { selfMarks: 1 }), // no rubric, so no chapter
    written(21, 3, {}), // written, unmarked — must not be assumed zero
  ],
};

const cards = revisionWrites(revisionSitting);
const byId = new Map(cards.map((c) => [c.id, c]));

check("one card per chapter, not per question", byId.has("exercise:jesc1:1"), `${cards.length} cards`);
check(
  "the card is the same one ChapterRating and /quiz write",
  /^exercise:jesc1:1$/.test([...byId.keys()].find((k) => k === "exercise:jesc1:1") ?? ""),
);
check(
  "both tracks pour into the same chapter bucket",
  byId.get("exercise:jesc1:1").score === 3 && byId.get("exercise:jesc1:1").maxMarks === 4,
  JSON.stringify(byId.get("exercise:jesc1:1")),
);
check(
  "a second chapter is rated on its own slice",
  byId.get("exercise:jesc1:2").score === 1 && byId.get("exercise:jesc1:2").maxMarks === 1,
);
check(
  "a chapterless written answer falls back to the per-question paper card /practice writes",
  byId.get("paper:class10-science-2025-26:20")?.score === 1,
);
check(
  "an unmarked written answer writes no card at all",
  !byId.has("paper:class10-science-2025-26:21"),
);
check(
  "a Section A question with no chapter writes no chapter card",
  cards.filter((c) => c.id.startsWith("exercise:")).length === 2,
);
check(
  "a chapter is rated on the marks it earned across both tracks",
  byId.get("exercise:jesc1:1").confidence === "good",
  `3/4 -> ${byId.get("exercise:jesc1:1").confidence}`,
);
check("a chapter all right is pushed out", byId.get("exercise:jesc1:2").confidence === "easy");
check(
  "a chapter mostly dropped comes back soon",
  revisionWrites({
    paperSlug: "p",
    sectionA: [
      { n: 1, questionId: "z", bookCode: "jesc1", chapter: 4, maxMarks: 1, correct: 0, chosen: 1 },
    ],
    sectionB: [
      written(9, 3, {
        selfMarks: 1,
        handoff: {
          id: "t:2#9",
          attemptId: "t:2",
          paperSlug: "p",
          questionNo: 9,
          maxMarks: 3,
          rubricIds: [],
          bookCode: "jesc1",
          chapter: 4,
        },
      }),
    ],
  })[0].confidence === "hard",
);
check(
  "a chapter scoring nothing is relearned tomorrow",
  revisionWrites({
    paperSlug: "p",
    sectionA: [
      { n: 1, questionId: "z", bookCode: "jesc1", chapter: 3, maxMarks: 1, correct: 0, chosen: 1 },
    ],
    sectionB: [],
  })[0].confidence === "again",
);

// ── done ──────────────────────────────────────────────────────────────────

console.log(`\n${failed === 0 ? "All dual-track checks passed." : `${failed} check(s) failed.`}`);
process.exit(failed === 0 ? 0 : 1);
