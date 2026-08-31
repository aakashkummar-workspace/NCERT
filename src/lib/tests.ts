/**
 * Assembling a dual-track test — one sitting, two tracks.
 *
 * A real CBSE paper is not two exercises. It is one clock over a Section A the
 * machine can mark (objective, one mark apiece) and a Section B it cannot (the
 * student writes on paper, as they will in the hall). The app already has both
 * halves and has kept them apart: /quiz marks objective questions instantly,
 * /practice runs the timed paper the student marks themselves. This module puts
 * them back together without changing either.
 *
 * Everything here is assembled from content that already exists, and nothing is
 * invented:
 *
 *  - **Section A** comes from `data/questions.json`, through `src/lib/quiz.ts`.
 *    Those are the only questions in the app with a known right answer, so they
 *    are the only ones that can be auto-marked. The bank is reached through
 *    `quiz.ts` rather than read again here, which is what makes this module
 *    inherit that file's two rules for free: **a row that cannot be normalised
 *    is dropped rather than shown to a student as a question with no right
 *    answer**, and **class and subject come from `bookCode` via the manifest and
 *    override whatever the row claims.**
 *
 *  - **Section B** comes from a CBSE sample paper's own section table in
 *    `data/papers.json`, through `src/lib/papers.ts` — every question the paper
 *    prints as `vsa`, `sa`, `la` or `case-study`, at the marks the paper prints.
 *    The questions themselves stay in the mirrored PDF, where the student reads
 *    them; what this module carries is the mark grid, which is what a sitting
 *    needs.
 *
 *  - **Rubrics** from `data/rubrics.json` are attached to a Section B question
 *    where one exists. Nothing here grades anything — the rubric is carried so a
 *    later lane can grade a photographed answer against it, and so that a
 *    written answer with a rubric knows which chapter it belongs to. Rubrics get
 *    the same manifest rule, only harder: `data/rubrics.schema.md` makes a
 *    `class` or `subject` the book contradicts a **rejection**, not a
 *    correction, because it means the author was reading the wrong book.
 *
 * A test is therefore identified by its source paper, and its slug *is* that
 * paper's slug: there is exactly one dual-track assembly per paper, and it is
 * deterministic, so `/test/[slug]` can be statically exported and two students
 * with the same slug sit the same paper.
 *
 * A paper that cannot produce both tracks produces no test at all. Half a
 * dual-track test is not a dual-track test, and a Section A of zero questions
 * would silently turn this into a second, worse /practice.
 */
import rubricsJson from "@data/rubrics.json";
import { getBook, getChapter, subjectsForClass, type ClassNum } from "./manifest";
import {
  allPapers,
  isScorable,
  questionsFor,
  type Paper,
  type QuestionType as PaperQuestionType,
} from "./papers";
import { questionsForClass, type QuizQuestion } from "./quiz";

/** Forms the app can mark on its own: everything the bank stores an answer for. */
const AUTO_TYPES: ReadonlySet<PaperQuestionType> = new Set(["mcq", "assertion-reason"]);

/** Forms only a human can mark: the paper's descriptive half. */
const WRITTEN_TYPES: ReadonlySet<PaperQuestionType> = new Set([
  "vsa",
  "sa",
  "la",
  "case-study",
]);

// --- shapes ---------------------------------------------------------------

/** One rubric, reduced to what a test needs and what the grading lane consumes. */
export interface TestRubric {
  id: string;
  /** Present only where the paper prints "attempt either A or B". */
  variant?: string;
  variantsOffered?: string[];
  maxMarks: number;
  /** From the manifest, never from the rubric's own claim. */
  bookCode: string;
  chapter: number;
  classNum: ClassNum;
  subject: string;
  prompt?: string;
  /**
   * True while the conversion from CBSE's prose is unreviewed. The grading lane
   * must not paint anything red against such a rubric; see rubrics.schema.md.
   */
  needsReview: boolean;
}

/** A Section A question: auto-marked, straight out of the quiz bank. */
export interface TestMcqItem {
  /** Position within Section A, 1-based — how this test prints it. */
  n: number;
  question: QuizQuestion;
  marks: number;
}

/**
 * A Section B question: the student writes it on paper.
 *
 * `n` is the number **the source paper prints**, not a position in this list.
 * That is deliberate: the student reads the question out of the mirrored PDF and
 * marks it against the mirrored scheme, and every rubric, scan and grade
 * downstream is keyed on the paper's own numbering.
 */
export interface TestWrittenItem {
  n: number;
  section: string;
  topic?: string;
  type: PaperQuestionType;
  maxMarks: number;
  /** Every rubric the file holds for this question, variants included. */
  rubrics: TestRubric[];
  /**
   * The chapter this question is graded into, when the rubrics agree on one.
   * Undefined where there is no rubric, or where two variants sit in different
   * chapters — attributing a mark to the wrong chapter is worse than to none.
   */
  bookCode?: string;
  chapter?: number;
}

export interface DualTrackTest {
  /** The source paper's slug; a test is one assembly of one paper. */
  slug: string;
  paperSlug: string;
  title: string;
  classNum: ClassNum;
  /** Manifest subject — what the question bank is filed under. */
  subject: string;
  /** Subject as the paper prints it: "Mathematics (Basic)". */
  paperSubject: string;
  session: string;
  durationMinutes: number;
  sectionA: TestMcqItem[];
  sectionB: TestWrittenItem[];
  sectionAMarks: number;
  sectionBMarks: number;
  maxMarks: number;
  /** How many Section B questions carry a rubric — the grading lane's reach. */
  rubricCount: number;
}

// --- rubrics --------------------------------------------------------------

type Raw = Record<string, unknown>;

function pick(row: Raw, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function rowsOf(file: unknown, ...keys: string[]): Raw[] {
  if (Array.isArray(file)) return file as Raw[];
  if (file && typeof file === "object") {
    const o = file as Record<string, unknown>;
    for (const key of keys) if (Array.isArray(o[key])) return o[key] as Raw[];
  }
  return [];
}

/**
 * One raw rubric to a usable one, or `undefined`.
 *
 * The manifest decides class and subject, exactly as in quiz.ts — but where a
 * mis-tagged quiz question is still a usable question once the book has
 * overruled it, a mis-tagged rubric is thrown away. rubrics.schema.md says why:
 * the keywords underneath may be off another syllabus entirely, and a rubric
 * nobody can trust would mark a correct answer wrong in the student's own
 * handwriting.
 */
function normaliseRubric(row: Raw): { paper: string; rubric: TestRubric } | undefined {
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

  // Advisory fields that the book contradicts are a rejection, not a repair.
  const declaredClass = asNumber(pick(row, "class", "classNum", "grade"));
  if (declaredClass !== undefined && declaredClass !== book.class) return undefined;
  const declaredSubject = asString(pick(row, "subject"));
  if (declaredSubject && declaredSubject.toLowerCase() !== book.subject.toLowerCase()) {
    return undefined;
  }

  const offered = pick(row, "variantsOffered");
  const variantsOffered = Array.isArray(offered)
    ? offered.map((v) => asString(v)).filter((v): v is string => Boolean(v))
    : undefined;

  return {
    paper,
    rubric: {
      id,
      variant: asString(pick(row, "variant")),
      variantsOffered: variantsOffered?.length ? variantsOffered : undefined,
      maxMarks,
      bookCode: book.code,
      chapter,
      classNum: book.class,
      subject: book.subject,
      prompt: asString(pick(row, "prompt")),
      needsReview: pick(row, "needsReview") === true,
    },
  };
}

/** `paperSlug -> questionNo -> rubrics`, built once; the file is static. */
const rubricsByPaper: Map<string, Map<number, TestRubric[]>> = (() => {
  const out = new Map<string, Map<number, TestRubric[]>>();
  const seen = new Set<string>();

  for (const row of rowsOf(rubricsJson, "rubrics", "items")) {
    const parsed = normaliseRubric(row);
    // A duplicate id means two rubrics claim to be the same conversion; the
    // first wins, as it does for a duplicate question id in quiz.ts.
    if (!parsed || seen.has(parsed.rubric.id)) continue;
    seen.add(parsed.rubric.id);

    const questionNo = asNumber(pick(row, "questionNo", "qNo", "number"));
    if (questionNo === undefined) continue;

    const byQuestion = out.get(parsed.paper) ?? new Map<number, TestRubric[]>();
    const list = byQuestion.get(questionNo) ?? [];
    list.push(parsed.rubric);
    byQuestion.set(questionNo, list);
    out.set(parsed.paper, byQuestion);
  }

  // Variants in a stable printed order: unlabelled first, then A, B, …
  for (const byQuestion of out.values()) {
    for (const list of byQuestion.values()) {
      list.sort((a, b) => (a.variant ?? "").localeCompare(b.variant ?? "") || a.id.localeCompare(b.id));
    }
  }
  return out;
})();

/** Every rubric the file holds for one question of one paper. */
export function rubricsFor(paperSlug: string, questionNo: number): TestRubric[] {
  return rubricsByPaper.get(paperSlug)?.get(questionNo) ?? [];
}

// --- assembly -------------------------------------------------------------

/** Manifest subject names by every spelling a paper might use. */
const SUBJECT_BY_NAME = new Map<string, string>();
for (const cls of [9, 10] as const) {
  for (const s of subjectsForClass(cls)) {
    SUBJECT_BY_NAME.set(`${cls}:${s.name.toLowerCase()}`, s.name);
    SUBJECT_BY_NAME.set(`${cls}:${s.slug}`, s.name);
  }
}

/**
 * The manifest subject a paper's printed subject belongs to.
 *
 * CBSE sets two Mathematics papers — "Mathematics (Basic)" and "Mathematics
 * (Standard)" — over one NCERT book, so the qualifier in brackets is dropped
 * before matching. A paper whose subject the manifest does not know (Computer
 * Applications, say) has no question bank behind it and gets no test.
 */
export function bankSubjectFor(paper: Paper): string | undefined {
  const cls = paper.class;
  const direct = SUBJECT_BY_NAME.get(`${cls}:${paper.subject.toLowerCase()}`);
  if (direct) return direct;
  const stripped = paper.subject.replace(/\s*\([^)]*\)\s*/g, " ").trim().toLowerCase();
  return stripped ? SUBJECT_BY_NAME.get(`${cls}:${stripped}`) : undefined;
}

/**
 * FNV-1a. Only ever used to rotate the Section A pool by paper, so that two
 * papers in the same subject do not draw the identical slice while the bank is
 * smaller than a paper's objective section. Deterministic by construction —
 * a shuffle here would make the static export differ between builds.
 */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Book order, then chapter, then id: how a student scans for "chapter 7". */
function byBookChapter(a: QuizQuestion, b: QuizQuestion): number {
  return (
    (a.bookCode ?? "￿").localeCompare(b.bookCode ?? "￿") ||
    (a.chapter ?? Number.MAX_SAFE_INTEGER) - (b.chapter ?? Number.MAX_SAFE_INTEGER) ||
    a.id.localeCompare(b.id)
  );
}

/** How many objective questions the source paper itself prints. */
function objectiveCount(paper: Paper): number {
  return paper.sections
    .filter((s) => AUTO_TYPES.has(s.type))
    .reduce((n, s) => n + Math.max(0, s.to - s.from + 1), 0);
}

/**
 * Time for a shortened paper.
 *
 * Section A is capped by how many questions the bank actually holds, so a test
 * is usually shorter than the paper it came from. CBSE's own minutes-per-mark
 * is the only honest ratio to scale by; the result is rounded to five minutes,
 * because a clock reading "2:37:00" claims a precision the derivation has not
 * got, and floored at a quarter of an hour so a two-question test is still a
 * sitting rather than a countdown.
 */
export function scaledDuration(paper: Paper, marks: number): number {
  if (paper.maxMarks <= 0 || marks <= 0) return paper.durationMinutes;
  const raw = (paper.durationMinutes * marks) / paper.maxMarks;
  return Math.max(15, Math.round(raw / 5) * 5);
}

/**
 * Build the dual-track test for one paper, or `undefined` where it cannot be
 * both tracks: no mark grid, no manifest subject, no objective section printed,
 * an empty bank for the subject, or nothing descriptive to write.
 */
export function assembleTest(paper: Paper): DualTrackTest | undefined {
  if (!isScorable(paper)) return undefined;

  const subject = bankSubjectFor(paper);
  if (!subject) return undefined;

  const pool = questionsForClass(paper.class)
    .filter((q) => q.subject === subject)
    .sort(byBookChapter);
  if (pool.length === 0) return undefined;

  const printed = objectiveCount(paper);
  const wanted = Math.min(printed, pool.length);
  if (wanted === 0) return undefined;

  let picked: QuizQuestion[];
  if (wanted >= pool.length) {
    picked = pool;
  } else {
    const offset = hash(paper.slug) % pool.length;
    picked = Array.from({ length: wanted }, (_, i) => pool[(offset + i) % pool.length]);
    picked.sort(byBookChapter);
  }

  const sectionA: TestMcqItem[] = picked.map((question, i) => ({
    n: i + 1,
    question,
    marks: question.marks,
  }));

  const sectionB: TestWrittenItem[] = questionsFor(paper)
    .filter((q) => WRITTEN_TYPES.has(q.type))
    .map((q) => {
      const rubrics = rubricsFor(paper.slug, q.n);
      // Two variants of one question may sit in different chapters. Where they
      // do, the question belongs to neither until the grader knows which
      // variant was answered, so it carries no chapter at all.
      const first = rubrics[0];
      const agreed =
        first &&
        rubrics.every((r) => r.bookCode === first.bookCode && r.chapter === first.chapter)
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

  const sectionAMarks = sectionA.reduce((n, item) => n + item.marks, 0);
  const sectionBMarks = sectionB.reduce((n, item) => n + item.maxMarks, 0);
  const maxMarks = sectionAMarks + sectionBMarks;

  return {
    slug: paper.slug,
    paperSlug: paper.slug,
    title: paper.title,
    classNum: paper.class,
    subject,
    paperSubject: paper.subject,
    session: paper.session,
    durationMinutes: scaledDuration(paper, maxMarks),
    sectionA,
    sectionB,
    sectionAMarks,
    sectionBMarks,
    maxMarks,
    rubricCount: sectionB.filter((item) => item.rubrics.length > 0).length,
  };
}

/** Built once at module load, in the order /practice lists its papers. */
const tests: DualTrackTest[] = allPapers()
  .map(assembleTest)
  .filter((t): t is DualTrackTest => t !== undefined);

export function allTests(): DualTrackTest[] {
  return tests;
}

export function getTest(slug: string): DualTrackTest | undefined {
  return tests.find((t) => t.slug === slug);
}

export interface TestClassGroup {
  cls: ClassNum;
  subjects: { subject: string; tests: DualTrackTest[] }[];
}

/**
 * Class ascending, then subject, then newest session first — the same reading
 * order as /practice, so a student who knows one list knows the other.
 */
export function testIndex(): TestClassGroup[] {
  const byClass = new Map<ClassNum, DualTrackTest[]>();
  for (const t of tests) {
    const list = byClass.get(t.classNum) ?? [];
    list.push(t);
    byClass.set(t.classNum, list);
  }

  return [...byClass.entries()]
    .map(([cls, list]) => {
      const bySubject = new Map<string, DualTrackTest[]>();
      for (const t of list) {
        const group = bySubject.get(t.paperSubject) ?? [];
        group.push(t);
        bySubject.set(t.paperSubject, group);
      }
      return {
        cls,
        subjects: [...bySubject.entries()]
          .map(([subject, group]) => ({
            subject,
            tests: [...group].sort((a, b) => b.session.localeCompare(a.session)),
          }))
          .sort((a, b) => a.subject.localeCompare(b.subject)),
      };
    })
    .sort((a, b) => a.cls - b.cls);
}

export function totalTests(): number {
  return tests.length;
}

/** "3", "1.5" — never "3.0", which reads as a precision the marks have not got. */
export function formatMarks(marks: number): string {
  return Number.isInteger(marks) ? String(marks) : marks.toFixed(1);
}
