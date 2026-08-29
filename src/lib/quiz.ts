/**
 * Single access point for the quiz question bank.
 *
 * The bank is hand- or agent-authored rather than generated from the PDFs (the
 * textbooks carry no answer keys, so nothing can be extracted), which means it
 * arrives from a producer this module does not control. Two consequences shape
 * everything below:
 *
 *  1. **Every question is normalised, and anything that cannot be normalised is
 *     dropped.** A malformed row must not reach a student as a question with no
 *     right answer. `scripts/check-questions.mjs` is where problems are reported
 *     loudly; this module's job is only to keep the app correct.
 *
 *  2. **Class and subject are taken from the book, not from the row.** A
 *     question tagged with the wrong class would file itself under the wrong
 *     student and nothing in the UI could reveal it. `data/manifest.json`
 *     already knows that `jesc1` is Class 10 Science, so the manifest decides
 *     and the row's own claim is ignored. See data/questions.schema.md.
 *
 * The file is imported at build time, so a server component can slice out one
 * chapter's questions and hand only those to the client — the whole bank is
 * never shipped to a phone.
 */
import questionsJson from "@data/questions.json";
import {
  CLASSES,
  getBook,
  getChapter,
  slugify,
  subjectsForClass,
  type Book,
  type ClassNum,
} from "./manifest";

export type QuestionType = "mcq" | "assertion-reason" | "true-false";
export type Difficulty = "easy" | "medium" | "hard";

export interface QuizQuestion {
  id: string;
  class: ClassNum;
  subject: string;
  /** Absent when the row named no book we recognise; then it belongs to no chapter. */
  bookCode?: string;
  chapter?: number;
  type: QuestionType;
  question: string;
  options: string[];
  /** 0-based index into `options`. */
  answer: number;
  explanation?: string;
  marks: number;
  difficulty: Difficulty;
  origin?: string;
}

// --- normalisation -------------------------------------------------------

type Raw = Record<string, unknown>;

/** First present, non-empty value among the accepted spellings of a field. */
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

function normaliseType(v: unknown): QuestionType {
  const s = asString(v)?.toLowerCase().replace(/[\s_]+/g, "-") ?? "";
  if (s.startsWith("assertion")) return "assertion-reason";
  if (s === "tf" || s === "true-false" || s === "boolean") return "true-false";
  return "mcq";
}

function normaliseDifficulty(v: unknown): Difficulty {
  const s = asString(v)?.toLowerCase() ?? "";
  return s === "easy" || s === "hard" ? s : "medium";
}

/**
 * Resolve the correct option to a 0-based index.
 *
 * Producers express this four different ways and all four are unambiguous on
 * their own; the ordering here is what settles the overlap. A number is read as
 * an index first, because that is the documented form — only a number that
 * cannot be an index is reconsidered as a 1-based position. Text is matched
 * exactly against the options before anything else, so an option that happens
 * to read "B" is matched as text rather than mistaken for a letter.
 */
function normaliseAnswer(v: unknown, options: string[]): number | undefined {
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

  // Last resort: a case- and whitespace-insensitive match on the option text.
  const loose = s.toLowerCase().replace(/\s+/g, " ");
  const near = options.findIndex((o) => o.toLowerCase().replace(/\s+/g, " ") === loose);
  return near === -1 ? undefined : near;
}

/** Known subject names, lower-cased, so a row's spelling can be matched to one. */
const SUBJECT_BY_NAME = new Map<string, string>();
for (const cls of CLASSES) {
  for (const s of subjectsForClass(cls)) {
    SUBJECT_BY_NAME.set(s.name.toLowerCase(), s.name);
    SUBJECT_BY_NAME.set(s.slug, s.name);
  }
}

/**
 * One raw row to a usable question, or `undefined` if it cannot be trusted.
 * The rejection reasons here are mirrored by scripts/check-questions.mjs, which
 * is what tells a producer *why* something was dropped.
 */
function normalise(row: Raw): QuizQuestion | undefined {
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
  const book: Book | undefined = code ? getBook(code) : undefined;
  const chapter = asNumber(pick(row, "chapter", "chapterNo", "chapterNumber", "ch"));

  // The manifest is the authority on class and subject; see the module comment.
  let cls: ClassNum | undefined;
  let subject: string | undefined;
  let bookCode: string | undefined;
  let chapterNo: number | undefined;

  if (book) {
    cls = book.class;
    subject = book.subject;
    bookCode = book.code;
    // A chapter number the book does not have is worse than none: it would file
    // the question under a chapter the student cannot open.
    if (chapter !== undefined && getChapter(book.code, chapter)) chapterNo = chapter;
  } else {
    const declared = asNumber(pick(row, "class", "classNum", "grade"));
    const named = asString(pick(row, "subject"));
    cls = declared === 9 || declared === 10 ? declared : undefined;
    subject = named ? SUBJECT_BY_NAME.get(named.toLowerCase()) : undefined;
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
    type: normaliseType(pick(row, "type", "questionType", "format")),
    question,
    options,
    answer,
    explanation: asString(pick(row, "explanation", "solution", "reason", "rationale")),
    marks: asNumber(pick(row, "marks", "mark")) ?? 1,
    difficulty: normaliseDifficulty(pick(row, "difficulty", "level")),
    origin: asString(pick(row, "origin", "source")),
  };
}

/** Accepts `{questions: []}`, `{items: []}` or a bare array. */
function rowsOf(file: unknown): Raw[] {
  if (Array.isArray(file)) return file as Raw[];
  if (file && typeof file === "object") {
    const o = file as Record<string, unknown>;
    for (const key of ["questions", "items"]) {
      if (Array.isArray(o[key])) return o[key] as Raw[];
    }
  }
  return [];
}

/** Built once at module load; the file is static, so there is nothing to invalidate. */
const questions: QuizQuestion[] = (() => {
  const seen = new Set<string>();
  const out: QuizQuestion[] = [];
  for (const row of rowsOf(questionsJson)) {
    const q = normalise(row);
    // A duplicate id would give two questions the same React key and the same
    // result-sheet row; the first one wins.
    if (!q || seen.has(q.id)) continue;
    seen.add(q.id);
    out.push(q);
  }
  return out;
})();

// --- lookups -------------------------------------------------------------

export function allQuestions(): QuizQuestion[] {
  return questions;
}

export function questionsForClass(cls: ClassNum): QuizQuestion[] {
  return questions.filter((q) => q.class === cls);
}

export function questionsForSubject(cls: ClassNum, subjectSlug: string): QuizQuestion[] {
  return questions.filter((q) => q.class === cls && slugify(q.subject) === subjectSlug);
}

export interface SubjectQuizSummary {
  name: string;
  slug: string;
  questionCount: number;
  chapterCount: number;
}

export interface ClassQuizSummary {
  cls: ClassNum;
  questionCount: number;
  subjects: SubjectQuizSummary[];
}

/**
 * The class-wise index.
 *
 * Every subject the class *has* is listed, including those with no questions
 * yet — a subject that vanishes from the list reads as "not in my syllabus"
 * rather than "nothing written for it yet", and the second is the truth.
 */
export function quizIndex(): ClassQuizSummary[] {
  return CLASSES.map((cls) => {
    const mine = questionsForClass(cls);
    const subjects = subjectsForClass(cls).map((s) => {
      const qs = mine.filter((q) => q.subject === s.name);
      const chapters = new Set(
        qs.filter((q) => q.bookCode && q.chapter !== undefined).map((q) => `${q.bookCode}:${q.chapter}`),
      );
      return {
        name: s.name,
        slug: s.slug,
        questionCount: qs.length,
        chapterCount: chapters.size,
      };
    });
    return { cls, questionCount: mine.length, subjects };
  });
}

export interface ChapterQuizGroup {
  bookCode: string;
  bookTitle: string;
  chapter: number;
  chapterTitle: string;
  questions: QuizQuestion[];
}

/**
 * A subject's questions grouped by chapter, in book then chapter order — the
 * order a student scans for "chapter 7", never by question count.
 */
export function chapterGroups(cls: ClassNum, subjectSlug: string): ChapterQuizGroup[] {
  const mine = questionsForSubject(cls, subjectSlug);
  const groups = new Map<string, ChapterQuizGroup>();

  for (const q of mine) {
    if (!q.bookCode || q.chapter === undefined) continue;
    const key = `${q.bookCode}:${q.chapter}`;
    let g = groups.get(key);
    if (!g) {
      const book = getBook(q.bookCode);
      g = {
        bookCode: q.bookCode,
        bookTitle: book?.title ?? q.bookCode,
        chapter: q.chapter,
        chapterTitle: getChapter(q.bookCode, q.chapter)?.title ?? `Chapter ${q.chapter}`,
        questions: [],
      };
      groups.set(key, g);
    }
    g.questions.push(q);
  }

  return [...groups.values()].sort(
    (a, b) => a.bookCode.localeCompare(b.bookCode) || a.chapter - b.chapter,
  );
}

/** Questions in a subject that could not be tied to a chapter. */
export function looseQuestions(cls: ClassNum, subjectSlug: string): QuizQuestion[] {
  return questionsForSubject(cls, subjectSlug).filter(
    (q) => !q.bookCode || q.chapter === undefined,
  );
}

export function totalQuestions(): number {
  return questions.length;
}
