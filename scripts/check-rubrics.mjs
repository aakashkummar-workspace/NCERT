/**
 * Validate data/rubrics.json against the manifest and the paper index, and
 * print what a grader would actually be able to mark with it.
 *
 *   npm run rubric:check
 *
 * A rubric is worse than a quiz question when it is wrong. A malformed
 * question goes missing; a malformed rubric goes to work, and marks a correct
 * answer red in the student's own handwriting. So the rule inherited from
 * src/lib/quiz.ts — anything that cannot be trusted is dropped — is enforced
 * here at author time rather than left to a loader, and the first thing
 * checked is the one error that would corrupt every attempt at a question:
 * steps that do not sum to maxMarks.
 *
 * Class and subject come from bookCode via data/manifest.json and override
 * whatever the rubric claims, exactly as in check-questions.mjs. Sums are done
 * in half-marks, because CBSE's grain is ½ and adding doubles does not land on
 * 5 reliably.
 *
 * Exit code 1 on any error. Warnings (a type the paper disagrees with, a
 * needsReview flag with nothing said about it) do not fail the run, because
 * the rubric is still usable — but a reviewer needs to see them.
 */
import { readFile } from "node:fs/promises";

const RUBRICS = "data/rubrics.json";
const MANIFEST = "data/manifest.json";
const PAPERS = "data/papers.json";

const TYPES = new Set(["mcq", "assertion-reason", "vsa", "sa", "la", "case-study"]);
const KINDS = new Set(["step", "choose", "diagram"]);
const PARTIAL_WHEN = new Set([
  "unit-missing",
  "unit-wrong",
  "order-broken",
  "keywords-partial",
  "arithmetic-slip",
  "formula-only",
  "sign-error",
  "unrounded",
]);

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

/**
 * Marks in half-mark units, or undefined if the value is not a positive
 * multiple of 0.5. Everything downstream adds integers, so 1.5 + 1.5 + 1.5 +
 * 0.5 lands on 5 rather than on 4.999999999999999.
 */
function halves(v) {
  const n = asNumber(v);
  if (n === undefined || n <= 0) return undefined;
  const h = n * 2;
  return Number.isInteger(h) ? h : undefined;
}

const showMarks = (h) => (h % 2 === 0 ? String(h / 2) : `${h === 1 ? "" : Math.floor(h / 2)}½`);

/** A `keywords` array: a list of concepts, each a non-empty set of phrasings. */
function checkKeywords(id, where, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) {
    err(id, `${where} has no keywords; nothing could ever match it`);
    return;
  }
  keywords.forEach((concept, i) => {
    if (!concept || typeof concept !== "object" || Array.isArray(concept)) {
      err(id, `${where} keyword concept #${i} is not an object with an "any" array`);
      return;
    }
    const any = concept.any;
    if (!Array.isArray(any) || any.length === 0) {
      err(id, `${where} keyword concept #${i} has an empty "any"; it can never be satisfied`);
      return;
    }
    const phrases = any.map((p) => asString(p)).filter(Boolean);
    if (phrases.length !== any.length) {
      err(id, `${where} keyword concept #${i} has a blank phrasing`);
    }
    if (new Set(phrases).size !== phrases.length) {
      warn(id, `${where} keyword concept #${i} lists the same phrasing twice`);
    }
  });
}

function checkPartial(id, where, partial, stepHalves) {
  if (partial === undefined) return;
  if (!Array.isArray(partial)) {
    err(id, `${where} has a "partial" that is not an array`);
    return;
  }
  for (const rule of partial) {
    const when = asString(rule?.when);
    if (!when || !PARTIAL_WHEN.has(when)) {
      err(
        id,
        `${where} has partial.when ${JSON.stringify(rule?.when)}; expected one of ${[...PARTIAL_WHEN].join(", ")}`,
      );
    }
    const award = halves(rule?.award);
    if (award === undefined) {
      err(id, `${where} partial "${when}" awards ${JSON.stringify(rule?.award)}; expected a positive multiple of 0.5`);
      continue;
    }
    if (award >= stepHalves) {
      err(
        id,
        `${where} partial "${when}" awards ${showMarks(award)} of a ${showMarks(stepHalves)} step; partial credit must be strictly less than the step`,
      );
      if (stepHalves === 1) {
        err(id, `${where} is a ½-mark step, so it cannot be partially credited at all — CBSE has no quarter mark`);
      }
    }
    if (!asString(rule?.note)) {
      warn(id, `${where} partial "${when}" has no note saying what the student did`);
    }
  }
}

/** One entry of `steps`. Returns its contribution in half-marks, or 0. */
function checkStep(id, entry, index, seenStepIds) {
  const where = `step ${asString(entry?.id) ?? `#${index}`}`;

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    err(id, `${where} is not an object`);
    return 0;
  }

  const stepId = asString(entry.id);
  if (!stepId) err(id, `${where} has no id`);
  else if (seenStepIds.has(stepId)) err(id, `has two steps with id "${stepId}"`);
  else seenStepIds.add(stepId);

  const kind = asString(entry.kind) ?? "step";
  if (!KINDS.has(kind)) {
    err(id, `${where} has kind "${kind}"; expected one of ${[...KINDS].join(", ")}`);
    return 0;
  }

  if (!asString(entry.awardFor)) {
    err(id, `${where} has no awardFor; nobody reviewing this rubric could tell what it pays for`);
  }

  if (kind === "choose") {
    const chooseAtLeast = asNumber(entry.chooseAtLeast);
    const marksEach = halves(entry.marksEach);

    if (chooseAtLeast === undefined || !Number.isInteger(chooseAtLeast) || chooseAtLeast < 1) {
      err(id, `${where} has chooseAtLeast ${JSON.stringify(entry.chooseAtLeast)}; expected a whole number of 1 or more`);
      return 0;
    }
    if (marksEach === undefined) {
      err(id, `${where} has marksEach ${JSON.stringify(entry.marksEach)}; expected a positive multiple of 0.5`);
      return 0;
    }

    const options = Array.isArray(entry.options) ? entry.options : [];
    if (options.length === 0) {
      err(id, `${where} has no options`);
      return 0;
    }
    if (options.length < chooseAtLeast) {
      err(
        id,
        `${where} asks for ${chooseAtLeast} of ${options.length} option(s); a student could never score it in full`,
      );
    }

    const seenOptionIds = new Set();
    const tagCounts = new Map();
    options.forEach((option, i) => {
      const oWhere = `${where} option ${asString(option?.id) ?? `#${i}`}`;
      const optionId = asString(option?.id);
      if (!optionId) err(id, `${oWhere} has no id`);
      else if (seenOptionIds.has(optionId)) err(id, `${where} has two options with id "${optionId}"`);
      else seenOptionIds.add(optionId);

      if (!asString(option?.awardFor)) err(id, `${oWhere} has no awardFor`);
      checkKeywords(id, oWhere, option?.keywords);

      const tags = option?.tags;
      if (tags !== undefined) {
        if (!Array.isArray(tags)) {
          err(id, `${oWhere} has tags that are not an array`);
        } else {
          for (const tag of tags) {
            const t = asString(tag);
            if (!t) err(id, `${oWhere} has a blank tag`);
            else tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
          }
        }
      }
    });

    const requireTags = entry.requireTags;
    if (requireTags !== undefined) {
      if (typeof requireTags !== "object" || requireTags === null || Array.isArray(requireTags)) {
        err(id, `${where} has requireTags that is not a tag-to-count object`);
      } else {
        let demanded = 0;
        for (const [tag, rawMin] of Object.entries(requireTags)) {
          const min = asNumber(rawMin);
          if (min === undefined || !Number.isInteger(min) || min < 1) {
            err(id, `${where} requireTags."${tag}" is ${JSON.stringify(rawMin)}; expected a whole number of 1 or more`);
            continue;
          }
          demanded += min;
          const available = tagCounts.get(tag) ?? 0;
          if (available < min) {
            err(
              id,
              `${where} requires ${min} option(s) tagged "${tag}" but only ${available} carry that tag; no answer could satisfy it`,
            );
          }
        }
        if (demanded > chooseAtLeast) {
          err(
            id,
            `${where} requires ${demanded} tagged option(s) but only ${chooseAtLeast} are chosen; no answer could satisfy it`,
          );
        }
      }
    }

    if (entry.partial !== undefined) {
      warn(id, `${where} is a choose group with a "partial"; partial credit is declared per option-worth, not per group`);
    }

    return chooseAtLeast * marksEach;
  }

  const marks = halves(entry.marks);
  if (marks === undefined) {
    err(id, `${where} has marks ${JSON.stringify(entry.marks)}; expected a positive multiple of 0.5`);
    return 0;
  }

  if (kind === "diagram") {
    if (entry.autoGradable === true) {
      err(id, `${where} is a diagram claiming autoGradable: true; a figure cannot be graded from keywords`);
    }
    if (entry.keywords !== undefined) {
      warn(id, `${where} is a diagram with keywords; they will never be matched`);
    }
    if (!Array.isArray(entry.labels) || entry.labels.length === 0) {
      warn(id, `${where} is a diagram with no labels, so a reviewer has nothing to check the drawing against`);
    }
    if (entry.partial !== undefined) {
      err(id, `${where} is a diagram with partial credit; an ungraded step has no partial outcome`);
    }
    return marks;
  }

  checkKeywords(id, where, entry.keywords);

  const match = asString(entry.match) ?? "all";
  if (match !== "all" && match !== "any") {
    err(id, `${where} has match "${match}"; expected "all" or "any"`);
  }

  const unit = entry.unit;
  if (unit !== undefined) {
    if (typeof unit !== "object" || unit === null || Array.isArray(unit)) {
      err(id, `${where} has a "unit" that is not an object`);
    } else {
      if (typeof unit.required !== "boolean") {
        err(id, `${where} unit has no boolean "required"`);
      }
      const accepted = Array.isArray(unit.accepted) ? unit.accepted.map(asString).filter(Boolean) : [];
      if (unit.required === true && accepted.length === 0) {
        err(id, `${where} requires a unit but lists none as accepted`);
      }
    }
  }

  checkPartial(id, where, entry.partial, marks);

  return marks;
}

function rowsOf(file) {
  if (Array.isArray(file)) return file;
  for (const key of ["rubrics", "items"]) {
    if (Array.isArray(file?.[key])) return file[key];
  }
  return null;
}

const main = async () => {
  const raw = JSON.parse(await readFile(RUBRICS, "utf8"));
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const paperFile = JSON.parse(await readFile(PAPERS, "utf8"));

  const books = new Map(manifest.books.map((b) => [b.code, b]));
  const papers = new Map((paperFile.papers ?? []).map((p) => [p.slug, p]));

  const rows = rowsOf(raw);
  if (rows === null) {
    console.error(
      `${RUBRICS}: expected an array, or an object with a "rubrics" array. See data/rubrics.schema.md.`,
    );
    process.exit(1);
  }

  const seenIds = new Set();
  const seenQuestions = new Map();
  const accepted = [];

  rows.forEach((row, i) => {
    const id = asString(pick(row, "id")) ?? `#${i} (no id)`;

    if (!asString(row.id)) err(id, "has no id");
    else if (seenIds.has(id)) err(id, "duplicate id");
    else seenIds.add(id);

    // --- provenance ------------------------------------------------------

    const paperSlug = asString(pick(row, "paper", "paperSlug", "slug"));
    const paper = paperSlug ? papers.get(paperSlug) : undefined;
    if (!paperSlug) {
      err(id, `names no paper; it cannot be traced back to a marking scheme`);
    } else if (!paper) {
      err(id, `paper "${paperSlug}" is not in ${PAPERS}`);
    }

    const questionNo = asNumber(pick(row, "questionNo", "qNo", "number"));
    const variant = asString(row.variant);
    if (questionNo === undefined) {
      err(id, "names no questionNo");
    } else if (paper && (questionNo < 1 || questionNo > paper.questionCount)) {
      err(id, `question ${questionNo} is outside ${paper.slug}, which has 1-${paper.questionCount}`);
    }

    if (paperSlug && questionNo !== undefined) {
      const key = `${paperSlug}#${questionNo}${variant ? `/${variant}` : ""}`;
      if (seenQuestions.has(key)) {
        err(id, `is a second rubric for ${key}, already covered by ${seenQuestions.get(key)}`);
      } else {
        seenQuestions.set(key, id);
      }
    }

    // --- class and subject: the book decides ------------------------------

    const code = asString(pick(row, "bookCode", "book", "code"));
    const book = code ? books.get(code) : undefined;
    if (!code) {
      err(id, "names no bookCode, so a graded answer would have no chapter to count towards");
      return;
    }
    if (!book) {
      err(id, `bookCode "${code}" is not in ${MANIFEST}`);
      return;
    }

    // check-questions.mjs only warns here, because a mis-tagged question is
    // still a usable question once the book has overruled it. A rubric is not:
    // a rubric that names the wrong class is a rubric whose author was reading
    // the wrong book, and its keywords may be off another syllabus entirely.
    // The manifest still supplies the values below; the disagreement itself is
    // the bug, and it fails the run.
    const declaredClass = asNumber(row.class);
    if (declaredClass !== undefined && declaredClass !== book.class) {
      err(id, `says class ${declaredClass} but book ${book.code} is Class ${book.class}; the book wins, so one of the two is wrong`);
    }
    const declaredSubject = asString(row.subject);
    if (declaredSubject && declaredSubject !== book.subject) {
      err(id, `says subject "${declaredSubject}" but book ${book.code} is ${book.subject}; the book wins, so one of the two is wrong`);
    }
    if (paper && paper.class !== book.class) {
      err(
        id,
        `is on ${paper.slug} (Class ${paper.class}) but book ${book.code} is Class ${book.class}; one of the two is mis-filed`,
      );
    }

    const chapter = asNumber(pick(row, "chapter", "chapterNo", "chapterNumber", "ch"));
    if (chapter === undefined) {
      err(id, `names no chapter in ${book.code}, so it would count towards no chapter's progress`);
      return;
    }
    if (!book.chapters.some((c) => c.n === chapter)) {
      err(id, `chapter ${chapter} does not exist in ${book.code} (it has 1-${book.chapters.length})`);
      return;
    }

    // --- shape ------------------------------------------------------------

    const type = asString(row.type);
    if (!type || !TYPES.has(type)) {
      err(id, `has type ${JSON.stringify(row.type)}; expected one of ${[...TYPES].join(", ")}`);
    } else if (paper && questionNo !== undefined) {
      const section = (paper.sections ?? []).find((s) => questionNo >= s.from && questionNo <= s.to);
      if (section && section.type !== type) {
        warn(id, `says type "${type}" but ${paper.slug} puts question ${questionNo} in a "${section.type}" section`);
      }
      if (section && asNumber(pick(row, "maxMarks", "marks", "totalMarks")) !== section.marksEach) {
        warn(
          id,
          `carries ${pick(row, "maxMarks", "marks", "totalMarks")} marks but ${paper.slug} allots ${section.marksEach} to question ${questionNo}`,
        );
      }
    }

    const ordering = asString(row.ordering) ?? "unordered";
    if (ordering !== "ordered" && ordering !== "unordered") {
      err(id, `has ordering "${ordering}"; expected "ordered" or "unordered"`);
    }

    if (!asString(row.prompt)) {
      warn(id, "has no prompt, so a reviewer has nothing to check the steps against");
    }

    const needsReview = row.needsReview === true;
    const reviewNotes = Array.isArray(row.reviewNotes) ? row.reviewNotes.map(asString).filter(Boolean) : [];
    if (needsReview && reviewNotes.length === 0) {
      warn(id, "is flagged needsReview but says nothing about what needs reviewing");
    }
    if (!needsReview && reviewNotes.length > 0) {
      warn(id, "has reviewNotes but is not flagged needsReview");
    }

    // --- the sum ----------------------------------------------------------

    const maxMarks = halves(pick(row, "maxMarks", "marks", "totalMarks"));
    if (maxMarks === undefined) {
      err(
        id,
        `has maxMarks ${JSON.stringify(pick(row, "maxMarks", "marks", "totalMarks"))}; expected a positive multiple of 0.5`,
      );
      return;
    }

    const steps = Array.isArray(row.steps) ? row.steps : null;
    if (!steps || steps.length === 0) {
      err(id, `has no steps, so every answer to a ${showMarks(maxMarks)}-mark question would score zero`);
      return;
    }

    const seenStepIds = new Set();
    let total = 0;
    steps.forEach((entry, index) => {
      total += checkStep(id, entry, index, seenStepIds);
    });

    if (total !== maxMarks) {
      err(
        id,
        `steps sum to ${showMarks(total)} but maxMarks is ${showMarks(maxMarks)}; every attempt would be graded out of the wrong total`,
      );
      return;
    }

    accepted.push({
      id,
      cls: book.class,
      subject: book.subject,
      bookCode: book.code,
      chapter,
      paper: paperSlug,
      type: type ?? "?",
      maxMarks,
      needsReview,
      reviewNotes,
    });
  });

  // --- report ------------------------------------------------------------

  console.log(`${RUBRICS}: ${rows.length} rows, ${accepted.length} usable\n`);

  const byPaper = new Map();
  for (const r of accepted) {
    const list = byPaper.get(r.paper) ?? [];
    list.push(r);
    byPaper.set(r.paper, list);
  }
  for (const [slug, list] of [...byPaper].sort()) {
    const marks = list.reduce((n, r) => n + r.maxMarks, 0);
    const chapters = new Set(list.map((r) => `${r.bookCode}:${r.chapter}`));
    console.log(
      `${slug.padEnd(38)} ${String(list.length).padStart(3)} rubrics  ${showMarks(marks).padStart(4)} marks  ${chapters.size} chapters`,
    );
  }

  console.log("\nBy question type:");
  for (const type of TYPES) {
    const mine = accepted.filter((r) => r.type === type);
    if (mine.length === 0) continue;
    const marks = [...new Set(mine.map((r) => showMarks(r.maxMarks)))].sort();
    console.log(`  ${type.padEnd(16)} ${String(mine.length).padStart(3)}   ${marks.join(", ")} mark(s) each`);
  }

  const isHalf = (v) => {
    const n = asNumber(v);
    return n !== undefined && n % 1 !== 0;
  };
  const halfMarkSteps = rows.filter((r) =>
    (Array.isArray(r.steps) ? r.steps : []).some((s) => isHalf(s?.marks) || isHalf(s?.marksEach)),
  ).length;
  const chooseGroups = rows.filter((r) =>
    (Array.isArray(r.steps) ? r.steps : []).some((s) => s?.kind === "choose"),
  ).length;
  const diagrams = rows.filter((r) =>
    (Array.isArray(r.steps) ? r.steps : []).some((s) => s?.kind === "diagram"),
  ).length;
  console.log(
    `\nAwkward shapes covered: ${chooseGroups} with an "any N of" group, ${halfMarkSteps} with a half-mark award, ${diagrams} with a diagram mark.`,
  );

  const review = accepted.filter((r) => r.needsReview);
  if (review.length) {
    console.log(`\n${review.length} of ${accepted.length} rubric(s) await a teacher's review:`);
    for (const r of review) {
      console.log(`  ? ${r.id}`);
      for (const note of r.reviewNotes) console.log(`      ${note}`);
    }
    console.log("\n  Until these are signed off, a grader must not paint a missed step red on them.");
  }

  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  if (errors.length) {
    console.log(`\n${errors.length} error(s) — these rubrics will NOT be used to grade anything:`);
    for (const e of errors) console.log(`  x ${e}`);
    console.log("\nSee data/rubrics.schema.md for the expected shape.");
    process.exit(1);
  }

  console.log("\nAll rubrics validate.");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
