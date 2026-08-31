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
 * Three checks here read the provenance text rather than the shape, because
 * three rubrics once validated cleanly while still marking a correct answer
 * wrong: a "Draw and explain" question with no figure mark, an OR inside a
 * sub-part with only one branch modelled, and a mark split the author chose
 * with nothing recorded to say so. They are driven by `scheme.excerpt` — the
 * verbatim scheme text — and by the stem, so a rubric that carries no excerpt
 * is only partly checked. The report says how many those are.
 *
 * Exit code 1 on any error. Warnings (a type the paper disagrees with, a
 * needsReview flag with nothing said about it, a stem that asks for a drawing
 * this rubric does not pay for) do not fail the run, because the rubric is
 * still usable — but a reviewer needs to see them. The line between the two is
 * certainty: a scheme that literally prints "(for correct figure)" or a bare
 * OR is evidence, and fails the run; the same thing guessed from an abbreviated
 * prompt is a heuristic, and only warns.
 */
import { readFile } from "node:fs/promises";

const RUBRICS = "data/rubrics.json";
const MANIFEST = "data/manifest.json";
const PAPERS = "data/papers.json";

const TYPES = new Set(["mcq", "assertion-reason", "vsa", "sa", "la", "case-study"]);
const KINDS = new Set(["step", "choose", "diagram", "alternatives"]);
const MARK_SPLIT = new Set(["printed", "inferred"]);

/**
 * CBSE's internal choice, as it is printed. A scheme marks a whole-question
 * choice with a header ("Students to attempt either option A or B") and a
 * step-level one with nothing but the word OR alone on a line — which is how
 * q28's sub-part B went unmodelled for a while, and why the bare-OR pattern is
 * checked first.
 */
const OR_ALONE = /(^|\n)[\s.)\]]*OR[\s.:(]*(\n|$)/;
const OR_HEADER =
  /\b(attempt either|either option [A-Z]\b|either sub-?part [A-Z]\b|either [A-Z] or [A-Z]\b|internal choice)/i;

/**
 * Words in a stem that ask for something drawn. Deliberately excludes "drawn",
 * which in CBSE Maths nearly always describes a figure the paper supplies
 * ("a quadrilateral ABCD is drawn to circumscribe a circle") rather than one
 * the student must produce.
 */
const DRAW_STEM = /\b(draw|draws|redraw|sketch|diagram|diagrams|figure|labell?ed|labell?ing|label|plot|construct)\b/i;

/** A scheme that prints a figure mark says so in these words, and means it. */
const FIGURE_MARK = /\bfor\s+(?:the\s+|a\s+)?correct\s+(?:figure|diagram)|\bfor\s+(?:the\s+|a\s+)?(?:figure|diagram)\b/i;

/** A reviewNote that says where the per-step marks came from. */
const SPLIT_NOTE =
  /\b(split|inferred|infers?|inference|allots?|not printed|prints only|prints one total|one total|per-step|per step|judgment|judgement)\b/i;
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

/**
 * Every step in a rubric, including the ones inside an `alternatives` branch.
 * The rubric-level checks below ask "does this rubric award a figure mark
 * anywhere?", and a figure mark hidden inside one branch of an OR still counts.
 */
function flattenSteps(steps) {
  const out = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== "object") continue;
    out.push(s);
    if (s.kind === "alternatives") {
      for (const alt of Array.isArray(s.alternatives) ? s.alternatives : []) {
        out.push(...flattenSteps(alt?.steps));
      }
    }
  }
  return out;
}

/** One entry of `steps`. Returns its contribution in half-marks, or 0. */
function checkStep(id, entry, index, seenStepIds, depth = 0) {
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

  // --- kind: "alternatives" — CBSE's OR inside a question ------------------
  //
  // The student answers one branch and it is worth the group's full marks, so
  // every branch has to sum to the same number. A branch that sums to less is
  // the defect this kind exists to stop: it grades the student who chose that
  // option out of a smaller total than the one who chose the other.
  if (kind === "alternatives") {
    if (depth > 0) {
      err(
        id,
        `${where} nests one alternatives group inside another; CBSE does not nest internal choice, and a grader can only pick one branch at one level`,
      );
      return 0;
    }

    const alternatives = Array.isArray(entry.alternatives) ? entry.alternatives : null;
    if (!alternatives) {
      err(id, `${where} has kind "alternatives" but no "alternatives" array; there is nothing for a student to have chosen between`);
      return 0;
    }
    if (alternatives.length < 2) {
      err(
        id,
        `${where} offers ${alternatives.length} alternative(s); a choice needs at least two, and a single one is a plain step`,
      );
      return 0;
    }

    if (entry.keywords !== undefined) {
      warn(id, `${where} is an alternatives group with keywords; they will never be matched — they belong on the steps inside each branch`);
    }
    if (entry.partial !== undefined) {
      warn(id, `${where} is an alternatives group with a "partial"; partial credit is declared on the steps inside each branch, not on the group`);
    }

    const seenAltIds = new Set();
    alternatives.forEach((alt, i) => {
      const aWhere = `${where} alternative ${asString(alt?.id) ?? `#${i}`}`;
      if (!alt || typeof alt !== "object" || Array.isArray(alt)) {
        err(id, `${aWhere} is not an object`);
        return;
      }

      const altId = asString(alt.id);
      if (!altId) err(id, `${aWhere} has no id`);
      else if (seenAltIds.has(altId)) err(id, `${where} has two alternatives with id "${altId}"`);
      else seenAltIds.add(altId);

      if (!asString(alt.awardFor)) {
        err(id, `${aWhere} has no awardFor; nobody reviewing this rubric could tell which printed option it is`);
      }

      const altSteps = Array.isArray(alt.steps) ? alt.steps : null;
      if (!altSteps || altSteps.length === 0) {
        err(id, `${aWhere} has no steps, so a student who answered that option would score zero`);
        return;
      }

      let altTotal = 0;
      altSteps.forEach((s, j) => {
        altTotal += checkStep(id, s, j, seenStepIds, depth + 1);
      });
      if (altTotal !== marks) {
        err(
          id,
          `${aWhere} sums to ${showMarks(altTotal)} but the group is worth ${showMarks(marks)}; a student who answered that option would be graded out of a different total than one who answered the other`,
        );
      }
    });

    return marks;
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
  const declaredVariants = [];
  let schemeExcerpts = 0;
  let markSplitInferred = 0;
  let markSplitPrinted = 0;

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

    // --- provenance text, and the checks that read it -----------------------
    //
    // Everything below asks the same question in three ways: is there anything
    // in this question that a correct answer could satisfy and this rubric
    // could not pay for? A figure the stem asks for and no step awards; a
    // branch of an OR that is not modelled; a mark split nobody recorded as a
    // guess. All three shipped once.

    const scheme = row.scheme;
    let excerpt;
    if (scheme !== undefined) {
      if (typeof scheme !== "object" || scheme === null || Array.isArray(scheme)) {
        err(id, `has a "scheme" that is not an object; expected { file, page, excerpt? }`);
      } else if (scheme.excerpt !== undefined) {
        excerpt = asString(scheme.excerpt);
        if (!excerpt) err(id, `has a scheme.excerpt that is not a non-empty string`);
      }
    }
    if (excerpt) schemeExcerpts += 1;

    const prompt = asString(row.prompt) ?? "";
    const allSteps = flattenSteps(row.steps);
    const topSteps = Array.isArray(row.steps) ? row.steps : [];
    const hasDiagram = allSteps.some((s) => s?.kind === "diagram");
    const hasAlternatives = topSteps.some((s) => s?.kind === "alternatives");

    // 1. "Draw and explain", and not a mark for the drawing anywhere.
    if (excerpt && FIGURE_MARK.test(excerpt) && !hasDiagram) {
      err(
        id,
        `the scheme excerpt prints a figure mark ("${(excerpt.match(FIGURE_MARK) ?? [""])[0].trim()}") but this rubric has no diagram step; the mark CBSE pays for the drawing is unpayable here`,
      );
    } else if (DRAW_STEM.test(prompt) && !hasDiagram) {
      warn(
        id,
        `the stem asks for something drawn ("${(prompt.match(DRAW_STEM) ?? [""])[0]}") but no step is kind "diagram", so a student who draws a correct labelled figure and writes nothing scores zero. Either add the figure mark or say in reviewNotes why the scheme gives none`,
      );
    }

    // 2. An OR in the scheme with no alternative modelled at either level.
    const modelsChoice = Boolean(variant) || hasAlternatives;
    if (!modelsChoice) {
      if (excerpt && (OR_ALONE.test(excerpt) || OR_HEADER.test(excerpt))) {
        err(
          id,
          `the scheme excerpt offers an alternative (${OR_ALONE.test(excerpt) ? "a bare OR" : `"${(excerpt.match(OR_HEADER) ?? [""])[0]}"`}) but this rubric declares neither a "variant" nor a kind:"alternatives" step; a student who answered the other option scores zero on every step of it`,
        );
      } else if (OR_ALONE.test(prompt) || /\bOR\b/.test(prompt) || OR_HEADER.test(prompt)) {
        warn(
          id,
          `the prompt reads as if the paper offers a choice here, but this rubric declares neither a "variant" nor a kind:"alternatives" step; check the scheme before a student who answered the other option is marked zero`,
        );
      }
    }

    // 3. A mark split the author decided on, with nothing in reviewNotes saying so.
    const markSplit = asString(row.markSplit);
    const notesExplainSplit = reviewNotes.some((n) => SPLIT_NOTE.test(n));
    if (markSplit !== undefined) {
      if (!MARK_SPLIT.has(markSplit)) {
        err(id, `has markSplit ${JSON.stringify(row.markSplit)}; expected one of ${[...MARK_SPLIT].join(", ")}`);
      } else {
        if (markSplit === "inferred") {
          markSplitInferred += 1;
          if (!needsReview) {
            err(
              id,
              `declares markSplit "inferred" but is not flagged needsReview; a split the author decided is exactly the conversion judgment needsReview exists to hold back`,
            );
          }
          if (!notesExplainSplit) {
            err(
              id,
              `declares markSplit "inferred" but no reviewNotes entry says where the per-step marks came from; the reviewer has to be told which numbers CBSE printed and which this file invented`,
            );
          }
        } else {
          markSplitPrinted += 1;
        }
      }
    } else if (needsReview && topSteps.length > 1 && !notesExplainSplit) {
      warn(
        id,
        `is flagged needsReview and splits ${showMarks(halves(pick(row, "maxMarks", "marks", "totalMarks")) ?? 0)} marks across ${topSteps.length} steps, but no reviewNotes entry says whether CBSE printed that split. Add markSplit: "printed" or "inferred", and a note`,
      );
    }

    // 4. Whole-question internal choice, declared rather than left implicit.
    const variantsOffered = row.variantsOffered;
    if (variantsOffered !== undefined) {
      if (!Array.isArray(variantsOffered) || variantsOffered.length < 2) {
        err(
          id,
          `has variantsOffered ${JSON.stringify(variantsOffered)}; expected an array of at least two labels, one per option the paper prints`,
        );
      } else {
        const labels = variantsOffered.map(asString);
        if (labels.some((l) => !l)) {
          err(id, `has a blank entry in variantsOffered`);
        } else if (!variant) {
          err(id, `lists variantsOffered ${JSON.stringify(labels)} but declares no "variant" of its own, so nothing says which option it grades`);
        } else if (!labels.includes(variant)) {
          err(
            id,
            `is variant "${variant}" but variantsOffered is ${JSON.stringify(labels)}; the option this rubric grades is not one the paper offers`,
          );
        } else if (paperSlug && questionNo !== undefined) {
          for (const label of labels) {
            declaredVariants.push({ id, key: `${paperSlug}#${questionNo}/${label}`, label });
          }
        }
      }
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

  // A rubric that names the options its question offers is saying the paper
  // prints a choice here. If a sibling option has no rubric of its own, the
  // question is only half covered — a warning, not an error, because authoring
  // one option at a time is how this file gets written.
  for (const { id, key, label } of declaredVariants) {
    if (!seenQuestions.has(key)) {
      warn(id, `names option "${label}" as offered for this question, but no rubric in this file grades it`);
    }
  }

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
    flattenSteps(r.steps).some((s) => isHalf(s?.marks) || isHalf(s?.marksEach)),
  ).length;
  const chooseGroups = rows.filter((r) => flattenSteps(r.steps).some((s) => s?.kind === "choose")).length;
  const diagrams = rows.filter((r) => flattenSteps(r.steps).some((s) => s?.kind === "diagram")).length;
  const stepChoices = rows.filter((r) =>
    (Array.isArray(r.steps) ? r.steps : []).some((s) => s?.kind === "alternatives"),
  ).length;
  const wholeChoices = rows.filter((r) => asString(r.variant)).length;
  console.log(
    `\nAwkward shapes covered: ${chooseGroups} with an "any N of" group, ${halfMarkSteps} with a half-mark award, ${diagrams} with a diagram mark, ${wholeChoices} grading one option of a whole-question choice, ${stepChoices} with an OR inside a question.`,
  );

  // How far the two text-driven checks above could actually see. A rubric with
  // no scheme.excerpt is not checked for an unmodelled OR or a printed figure
  // mark at all, and one with no markSplit is taken on trust.
  const noExcerpt = rows.length - schemeExcerpts;
  if (noExcerpt > 0) {
    console.log(
      `\n${noExcerpt} of ${rows.length} rubric(s) carry no scheme.excerpt, so the unmodelled-OR and printed-figure-mark checks could not run on them.`,
    );
  }
  const noSplit = rows.length - markSplitInferred - markSplitPrinted;
  if (noSplit > 0) {
    console.log(
      `${noSplit} of ${rows.length} rubric(s) declare no markSplit, so nothing records whether CBSE printed their per-step marks or the author chose them.`,
    );
  }

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
