/**
 * Validate data/questions.json against the manifest, and print what the app
 * will actually show, class by class.
 *
 *   npm run quiz:check
 *
 * This exists because the app *silently drops* any question it cannot trust —
 * that is the right behaviour for a student, and the wrong behaviour for whoever
 * is writing the questions, who would otherwise see a chapter quietly missing
 * five of its ten questions with no clue why. Every rejection rule here mirrors
 * one in src/lib/quiz.ts; when one changes, both change.
 *
 * Exit code 1 on any error. Warnings (a missing explanation, a class tag the
 * manifest disagrees with) do not fail the run, because the question is still
 * usable — but they are printed, because both are worth fixing at source.
 */
import { readFile } from "node:fs/promises";

/**
 * The banks the app actually serves, validated together.
 *
 * `src/lib/quiz.ts` reads several files and concatenates them, so validating
 * only the first left the great majority of questions unchecked — and the
 * unchecked ones are the generated and drafted banks, which are exactly the
 * ones most likely to be wrong. Checking them as one set also catches an id or
 * a stem colliding *across* files, which no per-file run ever could.
 *
 * Pass paths to override, e.g. `node scripts/check-questions.mjs data/mine.json`.
 */
const DEFAULT_BANKS = [
  "data/questions.json",
  "data/questions.exemplar.json",
  "data/questions.socialscience9.json",
];
const BANKS = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_BANKS;
const QUESTIONS = BANKS.join(", ");
const MANIFEST = "data/manifest.json";

const errors = [];
const warnings = [];

function err(id, msg) {
  errors.push(`${id}: ${msg}`);
}
function warn(id, msg) {
  warnings.push(`${id}: ${msg}`);
}

function pick(row, ...keys) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

const asString = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const asNumber = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

/** Mirrors normaliseAnswer in src/lib/quiz.ts, and reports how it read the value. */
function resolveAnswer(v, options) {
  if (typeof v === "number" && Number.isInteger(v)) {
    if (v >= 0 && v < options.length) return { index: v, how: "0-based index" };
    if (v >= 1 && v <= options.length) return { index: v - 1, how: "1-based position" };
    return undefined;
  }
  const s = asString(v);
  if (s === undefined) return undefined;

  const exact = options.indexOf(s);
  if (exact !== -1) return { index: exact, how: "exact option text" };

  if (/^[A-Za-z]$/.test(s)) {
    const i = s.toUpperCase().charCodeAt(0) - 65;
    if (i >= 0 && i < options.length) return { index: i, how: `letter "${s}"` };
  }

  const n = Number(s);
  if (Number.isInteger(n)) {
    const r = resolveAnswer(n, options);
    if (r) return { index: r.index, how: `numeric string (${r.how})` };
  }

  const loose = s.toLowerCase().replace(/\s+/g, " ");
  const near = options.findIndex((o) => o.toLowerCase().replace(/\s+/g, " ") === loose);
  return near === -1 ? undefined : { index: near, how: "loose option-text match" };
}

function rowsOf(file) {
  if (Array.isArray(file)) return file;
  for (const key of ["questions", "items"]) {
    if (Array.isArray(file?.[key])) return file[key];
  }
  return null;
}

const main = async () => {
  // A bank that does not exist yet is skipped rather than fatal: the generated
  // ones are absent on a fresh clone until their script has been run.
  const present = [];
  for (const path of BANKS) {
    try {
      present.push({ path, raw: JSON.parse(await readFile(path, "utf8")) });
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      console.log(`  (${path} not present — skipped)`);
    }
  }
  const raw = present.flatMap(({ path, raw: r }) => {
    const rows = rowsOf(r);
    if (rows === null) {
      console.error(`${path}: expected an array, or an object with a "questions" array.`);
      process.exit(1);
    }
    return rows;
  });
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));

  const books = new Map(manifest.books.map((b) => [b.code, b]));

  const rows = rowsOf(raw);
  if (rows === null) {
    console.error(
      `${QUESTIONS}: expected an array, or an object with a "questions" array. See data/questions.schema.md.`,
    );
    process.exit(1);
  }

  const seenIds = new Set();
  const seenStems = new Map();
  const howCounts = new Map();
  /** bookCode:chapter -> count, for the class-wise summary. */
  const accepted = [];

  rows.forEach((row, i) => {
    const id = asString(pick(row, "id", "qid", "key")) ?? `#${i} (no id)`;

    if (!asString(pick(row, "id", "qid", "key"))) err(id, "has no id");
    else if (seenIds.has(id)) err(id, "duplicate id");
    else seenIds.add(id);

    const question = asString(pick(row, "question", "text", "stem", "q"));
    if (!question) {
      err(id, "has no question text");
      return;
    }

    const stemKey = question.toLowerCase().replace(/\s+/g, " ");
    if (seenStems.has(stemKey)) warn(id, `same question text as ${seenStems.get(stemKey)}`);
    else seenStems.set(stemKey, id);

    const rawOptions = pick(row, "options", "choices", "opts");
    if (!Array.isArray(rawOptions)) {
      err(id, "has no options array");
      return;
    }
    const options = rawOptions.map((o) => asString(o) ?? "").filter(Boolean);
    if (options.length !== rawOptions.length) err(id, "has a blank option");
    if (options.length < 2) {
      err(id, `has ${options.length} usable option(s); at least 2 are needed`);
      return;
    }
    if (options.length > 6) warn(id, `has ${options.length} options; more than 6 is hard to tap`);
    if (new Set(options).size !== options.length) {
      err(id, "has two identical options");
      return;
    }

    const rawAnswer = pick(
      row,
      "answer",
      "answerIndex",
      "correct",
      "correctIndex",
      "correctAnswer",
      "correctOption",
    );
    const resolved = resolveAnswer(rawAnswer, options);
    if (!resolved) {
      err(id, `answer ${JSON.stringify(rawAnswer)} does not identify one of the ${options.length} options`);
      return;
    }
    howCounts.set(resolved.how, (howCounts.get(resolved.how) ?? 0) + 1);

    const code = asString(pick(row, "bookCode", "book", "code"));
    const book = code ? books.get(code) : undefined;
    const chapter = asNumber(pick(row, "chapter", "chapterNo", "chapterNumber", "ch"));

    let cls;
    let subject;
    let chapterNo;

    if (code && !book) {
      err(id, `bookCode "${code}" is not in ${MANIFEST}`);
      return;
    }

    if (book) {
      cls = book.class;
      subject = book.subject;

      const declaredClass = asNumber(pick(row, "class", "classNum", "grade"));
      if (declaredClass !== undefined && declaredClass !== book.class) {
        warn(
          id,
          `says class ${declaredClass} but book ${book.code} is Class ${book.class}; the book wins`,
        );
      }
      const declaredSubject = asString(pick(row, "subject"));
      if (declaredSubject && declaredSubject !== book.subject) {
        warn(
          id,
          `says subject "${declaredSubject}" but book ${book.code} is ${book.subject}; the book wins`,
        );
      }

      if (chapter === undefined) {
        warn(id, `names no chapter, so it will not count towards ${book.subject} progress`);
      } else if (!book.chapters.some((c) => c.n === chapter)) {
        err(
          id,
          `chapter ${chapter} does not exist in ${book.code} (it has 1-${book.chapters.length})`,
        );
        return;
      } else {
        chapterNo = chapter;
      }
    } else {
      cls = asNumber(pick(row, "class", "classNum", "grade"));
      subject = asString(pick(row, "subject"));
      if (cls !== 9 && cls !== 10) {
        err(id, "has no usable bookCode and no class of 9 or 10");
        return;
      }
      const known = manifest.books.some((b) => b.class === cls && b.subject === subject);
      if (!known) {
        err(id, `has no usable bookCode, and subject "${subject}" is not a Class ${cls} subject`);
        return;
      }
      warn(id, "names no book, so it will not count towards any chapter's progress");
    }

    if (!asString(pick(row, "explanation", "solution", "reason", "rationale"))) {
      warn(id, "has no explanation; the student is told the right answer but not why");
    }

    const marks = asNumber(pick(row, "marks", "mark"));
    if (marks !== undefined && marks <= 0) err(id, `carries ${marks} marks`);

    accepted.push({ id, cls, subject, bookCode: code, chapter: chapterNo });
  });

  // --- report ------------------------------------------------------------

  console.log(`${QUESTIONS}: ${rows.length} rows, ${accepted.length} usable\n`);

  for (const cls of [9, 10]) {
    const mine = accepted.filter((q) => q.cls === cls);
    console.log(`Class ${cls} — ${mine.length} questions`);
    if (mine.length === 0) {
      console.log("  (none)");
      continue;
    }
    const bySubject = new Map();
    for (const q of mine) {
      const list = bySubject.get(q.subject) ?? [];
      list.push(q);
      bySubject.set(q.subject, list);
    }
    for (const [subject, list] of [...bySubject].sort()) {
      const chapters = new Set(
        list.filter((q) => q.chapter !== undefined).map((q) => `${q.bookCode}:${q.chapter}`),
      );
      console.log(
        `  ${subject.padEnd(16)} ${String(list.length).padStart(4)} questions  ${chapters.size} chapters`,
      );
    }
  }

  if (howCounts.size > 1) {
    console.log("\nAnswers were read as:");
    for (const [how, n] of howCounts) console.log(`  ${how}: ${n}`);
  }

  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  if (errors.length) {
    console.log(`\n${errors.length} error(s) — these questions will NOT appear in the app:`);
    for (const e of errors) console.log(`  x ${e}`);
    console.log("\nSee data/questions.schema.md for the expected shape.");
    process.exit(1);
  }

  console.log("\nAll questions validate.");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
