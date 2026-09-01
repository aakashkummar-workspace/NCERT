/**
 * Build data/teacher-review-queue.json — the order one teacher works through.
 *
 *   node scripts/build-teacher-queue.mjs            # write the queue
 *   node scripts/build-teacher-queue.mjs --check    # fail if the file is stale
 *   node scripts/build-teacher-queue.mjs --print    # summary to stdout, write nothing
 *
 * 342 of 353 rubrics are flagged needsReview, and while a rubric carries that
 * flag the grader may not paint anything red on it (data/rubrics.schema.md,
 * "Green, orange, red"). So every unreviewed rubric can only ever be generous,
 * and a teacher's day is the scarcest input this project has. This file decides
 * what that day is spent on.
 *
 * The ordering is DERIVED, never hand-listed: it reads `reviewNotes`,
 * `markSplit`, `maxMarks`, `scheme.excerpt`, `variantsOffered` and the step
 * kinds, and scores each rubric by how much a teacher's decision changes. Add a
 * rubric, or rewrite a review note, and the order moves on its own. Nothing here
 * touches the network or the clock, so two runs over the same inputs produce
 * byte-identical output.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SOURCES = [
  { file: "data/rubrics.json", origin: "hand-authored" },
  { file: "data/rubrics.draft.json", origin: "drafted from the marking scheme" },
];
const PAPERS = "data/papers.json";
const OUT = "data/teacher-review-queue.json";

// --- the scoring model ----------------------------------------------------

/**
 * Each factor is a named, weighted reason a teacher's decision on this rubric
 * matters. A rubric's score is the sum of the factors that fire. The weights
 * encode four orderings, in this order of strength:
 *
 *   1. a rubric that scores a correct answer zero beats everything else;
 *   2. a 3- or 5-mark rubric beats a 1-mark objective, because the grading gate
 *      is measured only on 3- and 5-mark answers (scripts/spike-score.mjs);
 *   3. an alternative nobody modelled, and a mark split CBSE never printed,
 *      beat a conversion whose marks came straight off the scheme's margin;
 *   4. anything above beats a keyword or phrasing tweak.
 */
const FACTORS = [
  {
    key: "correct-answer-scores-zero",
    weight: 50,
    label: "a correct answer scores zero today",
    why: "A review note says an answer the scheme would credit earns nothing under this rubric. Until a teacher rules, the question is mis-marked for every student who answers it that way.",
  },
  {
    key: "unmodelled-alternative",
    weight: 25,
    label: "the other option of a printed choice has no rubric",
    why: "The paper offers a choice and only one option is modelled here, so students who took the other option have nothing to be graded against.",
  },
  {
    key: "gate-sized",
    weight: 30,
    label: "3 or 5 marks — the grading gate is measured on these",
    why: "scripts/spike-score.mjs counts only 3- and 5-mark answers towards the gate. An unreviewed rubric of this size biases the measurement itself.",
  },
  {
    key: "long-answer",
    weight: 12,
    label: "2 or 4 marks — long-form, but outside the gate",
    why: "More than one step can go wrong, so the conversion carries real judgment; it just does not move the gate number.",
  },
  {
    key: "inferred-mark-split",
    weight: 20,
    label: "the split between steps is inferred, not printed",
    why: "CBSE printed one total and this file invented the per-step split. Every step of it is somebody's guess about what each part is worth.",
  },
  {
    key: "no-scheme-excerpt",
    weight: 12,
    label: "the scheme's own words were not carried across",
    why: "With no excerpt, rubric:check cannot compare the conversion against the source, and its figure-mark and alternatives checks both skip this rubric. Only a person reading the PDF can catch an error here.",
  },
  {
    key: "diagram-step-reserved",
    weight: 8,
    label: "a mark is reserved for a drawing",
    why: "A diagram step is never graded automatically, so this mark is withheld from every student until a human marks it. The teacher decides whether the mark belongs on the figure at all.",
  },
  {
    key: "choose-any-n",
    weight: 8,
    label: 'an "any N of the following" group',
    why: "The scheme lists points and asks for some of them. How many, and whether a named-but-unexplained point counts, is a judgment.",
  },
  {
    key: "require-tags",
    weight: 6,
    label: "the group demands a mix of categories",
    why: '"at least one climate and one economic" — which listed point belongs to which category was decided here, not by CBSE.',
  },
  {
    key: "scheme-restates-the-question",
    weight: 4,
    label: "the unrewarded opening is the question, reprinted",
    why: "The warning fired on text the marking scheme copies from the question paper before it starts answering. A student who writes only the question back has indeed earned nothing, so the rubric is right — but a teacher should glance at it once and say so.",
  },
  {
    key: "figure-supplied-by-the-paper",
    weight: 4,
    label: "the figure is printed on the question paper, not drawn by the student",
    why: 'The missing-figure warning fired on a one-mark objective whose answer is a letter — "In the figure below…", not "Draw…". Almost certainly the paper supplies the figure and no mark is owed for a drawing, but a teacher should say so once and be done.',
  },
  {
    key: "keywords-lumped",
    weight: 5,
    label: "all the scheme's terms sit in one concept",
    why: "The step fires on any single listed word, so it currently marks generously. Splitting the terms into real concepts tightens it.",
  },
  {
    key: "chapter-inferred",
    weight: 3,
    label: "the NCERT chapter was guessed by wording",
    why: "Wrong only mis-routes the result into /revise and /progress; it never changes a mark.",
  },
  {
    key: "never-read-by-a-human",
    weight: 2,
    label: "extracted mechanically; nobody has read it",
    why: "Baseline for every drafted rubric.",
  },
  {
    key: "mcq-bare-letter",
    weight: 1,
    label: "an objective question that accepts the bare option letter",
    why: 'The only decision is whether writing "C" alone is a full answer. Cheap to confirm, and it moves one mark.',
  },
];

const WEIGHT = new Map(FACTORS.map((f) => [f.key, f.weight]));
const FACTOR = new Map(FACTORS.map((f) => [f.key, f]));

/**
 * The bands are semantic, not a cut through the score: a teacher stopping after
 * an hour should be able to say what class of problem they finished, not what
 * arbitrary number they got past. Ordering *inside* a band is by score.
 */
const BANDS = [
  {
    band: "A",
    label: "The rubric is wrong today",
    holds:
      "a correct answer earns nothing, or half the students who attempted the question cannot be graded at all",
    minutesEach: 8,
    test: (f) => f.has("correct-answer-scores-zero") || f.has("unmodelled-alternative"),
  },
  {
    band: "B",
    label: "The measurement depends on it",
    holds: "3- and 5-mark questions: the only sizes the grading gate is scored on",
    minutesEach: 6,
    test: (f) => f.has("gate-sized"),
  },
  {
    band: "C",
    label: "Somebody invented a number",
    holds:
      "longer answers whose mark split, group size or figure mark was not printed by CBSE",
    minutesEach: 4,
    test: (f) =>
      f.has("inferred-mark-split") ||
      f.has("choose-any-n") ||
      f.has("require-tags") ||
      f.has("diagram-step-reserved") ||
      f.has("no-scheme-excerpt") ||
      f.has("long-answer"),
  },
  {
    band: "D",
    label: "Wording only",
    holds: "one-mark objective questions and keyword tightening",
    minutesEach: 1,
    // These do not need one decision each. They all ask the same question — does
    // the bare option letter count — so one ruling plus a spot check settles the
    // band. The batched estimate is what a teacher should actually be quoted.
    batch: {
      policyMinutes: 10,
      spotCheckFraction: 0.1,
      note: "one ruling for the whole band, then spot-check one rubric in ten",
    },
    test: () => true,
  },
];

// --- reading --------------------------------------------------------------

async function readJson(rel) {
  return JSON.parse(await readFile(path.join(ROOT, rel), "utf8"));
}

/** Same three shapes data/rubrics.schema.md and spike-grade.mjs accept. */
function rubricList(file) {
  const list = Array.isArray(file) ? file : (file?.rubrics ?? file?.items);
  if (!Array.isArray(list)) {
    throw new Error("rubrics file is not an array, {rubrics:[]} or {items:[]}");
  }
  return list;
}

/** Tolerated spellings, per the schema's own table. */
const pick = (r, ...names) => names.map((n) => r[n]).find((v) => v !== undefined);
const maxMarksOf = (r) => Number(pick(r, "maxMarks", "marks", "totalMarks"));
const paperOf = (r) => pick(r, "paper", "paperSlug", "slug");
const questionNoOf = (r) => pick(r, "questionNo", "qNo", "number");

/** Every step, including the ones inside an `alternatives` branch. */
function everyStep(steps, out = []) {
  for (const s of steps ?? []) {
    out.push(s);
    if (s.kind === "alternatives") for (const b of s.alternatives ?? []) everyStep(b.steps, out);
  }
  return out;
}

// --- scoring --------------------------------------------------------------

/** The first review note matching a pattern, so the queue can quote its evidence. */
function noteMatching(rubric, re) {
  return (rubric.reviewNotes ?? []).find((n) => re.test(n)) ?? null;
}

const RE = {
  scoresZero: /scores? zero|earns no (?:separate )?mark/i,
  missingDiagram: /no diagram step/i,
  openingUnrewarded: /earns no (?:separate )?mark/i,
  inferred: /\b(?:is|are|was|were) inferred\b|split is inferred|every split of it is inferred/i,
  chapterInferred: /was inferred by matching this question/i,
  keywordsLumped: /Keywords are the most distinctive terms/i,
  neverRead: /No human has read it/i,
  mcqLetter: /The scheme gives option [A-D]\b/,
  schemeOffersChoice: /\bOR\b|attempt either|either option/,
  openingQuote: /opening text \(["'“‘](.*?)["'”’](?:…)?\)/s,
};

/**
 * Is the "opening text earns no mark" warning about the marking scheme copying
 * the question paper's own words before it starts answering? Several CBSE
 * schemes reprint the whole stem; a rubric that pays nothing for it is correct,
 * not broken. Loose word overlap gets this wrong — a scheme's first answer
 * sentence reuses the stem's vocabulary — so the test is the longest run of
 * CONSECUTIVE words the quoted opening shares with the question stem.
 */
// CBSE's schemes retype the stem, and retyping turns "three lists" into
// "3 lists". Without this the run breaks on the digit and a reprinted question
// reads as a lost mark.
const NUMBER_WORD = new Map(
  ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].map(
    (w, i) => [w, String(i)],
  ),
);

const words = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUMBER_WORD.get(w) ?? w);

function longestSharedRun(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = prev[j - 1] + 1;
        if (row[j] > best) best = row[j];
      }
    }
    prev = row;
  }
  return best;
}

const RESTATEMENT_THRESHOLD = 0.7;

function quotesTheQuestionBack(note, prompt) {
  const m = RE.openingQuote.exec(note ?? "");
  if (!m || !prompt) return false;
  const quoted = words(m[1]);
  if (quoted.length < 5) return false;
  return longestSharedRun(quoted, words(prompt)) / quoted.length >= RESTATEMENT_THRESHOLD;
}

function scoreRubric(rubric, byQuestion) {
  const marks = maxMarksOf(rubric);
  const steps = everyStep(rubric.steps);
  const excerpt = rubric.scheme?.excerpt ?? "";
  const found = [];
  const add = (key, evidence) => found.push({ key, weight: WEIGHT.get(key), evidence });

  // 1. Does a correct answer score nothing? The notes say so in three shapes.
  //    One of them is a false alarm worth separating out: the missing-figure
  //    warning is raised from the stem's wording, and on a one-mark objective
  //    the stem says "in the figure below" about a figure the PAPER prints. The
  //    answer there is a letter; no student draws anything, so no mark is owed.
  //    The note itself hedges on exactly this ("if the drawing is the student's
  //    to produce rather than the paper's to supply"), so the rubric is not
  //    wrong today — it just wants one cheap confirmation.
  const zeroNote = noteMatching(rubric, RE.scoresZero);
  const objective = marks === 1 && (rubric.type === "mcq" || rubric.type === "assertion-reason");
  if (zeroNote && RE.missingDiagram.test(zeroNote) && objective) {
    add("figure-supplied-by-the-paper", zeroNote);
  } else if (zeroNote && quotesTheQuestionBack(zeroNote, rubric.prompt)) {
    add("scheme-restates-the-question", zeroNote);
  } else if (zeroNote) {
    const kind = RE.missingDiagram.test(zeroNote)
      ? "no mark is reserved for the drawing the question asks for"
      : RE.openingUnrewarded.test(zeroNote)
        ? "the scheme's opening sentence earns nothing here"
        : "an answer the scheme credits earns nothing here";
    add("correct-answer-scores-zero", `${kind} — ${zeroNote}`);
  }

  // 2. A printed choice with only one side modelled. Two witnesses: the rubric
  //    naming an option this file has no rubric for, and the scheme's own words
  //    offering an alternative that nothing in the steps models.
  const orphans = (rubric.variantsOffered ?? []).filter(
    (v) => !byQuestion.has(`${paperOf(rubric)}#${questionNoOf(rubric)}#${v}`),
  );
  const modelsAnAlternative = steps.some((s) => s.kind === "alternatives") || !!rubric.variant;
  if (orphans.length > 0) {
    add(
      "unmodelled-alternative",
      `the paper prints option ${orphans.join(" and ")} for this question and no rubric covers it`,
    );
  } else if (excerpt && RE.schemeOffersChoice.test(excerpt) && !modelsAnAlternative) {
    add("unmodelled-alternative", "the scheme's own words offer an alternative that no step models");
  }

  // 3. Size. Only 3- and 5-mark answers are scored against the gate.
  if (marks === 3 || marks === 5) add("gate-sized", `${marks} marks`);
  else if (marks === 2 || marks === 4) add("long-answer", `${marks} marks`);

  // 4. A split CBSE never printed. The flag is authoritative; the notes catch
  //    the rubrics that describe an inferred split without declaring one.
  if (rubric.markSplit === "inferred") {
    add("inferred-mark-split", noteMatching(rubric, RE.inferred) ?? 'markSplit is "inferred"');
  } else {
    const n = noteMatching(rubric, RE.inferred);
    if (n && !RE.chapterInferred.test(n)) add("inferred-mark-split", n);
  }

  // 5. No excerpt: rubric:check's figure-mark and alternatives checks skip it.
  if (!excerpt) add("no-scheme-excerpt", "this rubric carries no excerpt from the scheme");

  // 6..9. Step kinds that are conversions rather than transcriptions.
  const diagrams = steps.filter((s) => s.kind === "diagram");
  if (diagrams.length > 0) {
    const held = diagrams.reduce((a, s) => a + Number(s.marks ?? 0), 0);
    add(
      "diagram-step-reserved",
      `${held} of the ${marks} marks sit on a figure no grader may award`,
    );
  }
  const chooses = steps.filter((s) => s.kind === "choose");
  if (chooses.length > 0) {
    add(
      "choose-any-n",
      chooses
        .map((s) => `any ${s.chooseAtLeast} of ${(s.options ?? []).length} at ${s.marksEach} each`)
        .join("; "),
    );
  }
  if (steps.some((s) => s.requireTags)) {
    const tags = steps.flatMap((s) => Object.keys(s.requireTags ?? {}));
    add("require-tags", `the group demands ${[...new Set(tags)].join(" and ")}`);
  }

  // 10..13. Cheap confirmations.
  const lumped = noteMatching(rubric, RE.keywordsLumped);
  if (lumped) add("keywords-lumped", lumped);
  const chapter = noteMatching(rubric, RE.chapterInferred);
  if (chapter) add("chapter-inferred", chapter);
  if (noteMatching(rubric, RE.neverRead)) {
    add("never-read-by-a-human", "drafted by extract-rubrics.ts");
  }
  const mcq = noteMatching(rubric, RE.mcqLetter);
  if (mcq) add("mcq-bare-letter", mcq);

  // Report factors in the model's own order, so two rubrics read alike.
  const order = new Map(FACTORS.map((f, i) => [f.key, i]));
  found.sort((a, b) => order.get(a.key) - order.get(b.key));
  return { factors: found, score: found.reduce((a, f) => a + f.weight, 0) };
}

/** The one sentence a teacher is being asked to answer. Derived from the top factor. */
function decisionFor(factors) {
  const has = new Set(factors.map((f) => f.key));
  if (has.has("correct-answer-scores-zero")) {
    const note = factors.find((f) => f.key === "correct-answer-scores-zero").evidence;
    return RE.missingDiagram.test(note)
      ? "Does the drawing carry a mark of its own? If yes, say which mark comes out of the written steps to pay for it."
      : "Should the answer that currently earns nothing be worth a mark? If yes, say how many, and which step gives them up.";
  }
  if (has.has("unmodelled-alternative")) {
    return "The paper offers a choice here and only one option is written up. Confirm the missing option needs its own marking, or that no student is expected to take it.";
  }
  if (has.has("inferred-mark-split")) {
    return "CBSE printed one total. Confirm the split between the steps below, or write the split you would use.";
  }
  if (has.has("choose-any-n") || has.has("require-tags")) {
    return "Confirm how many points earn full marks, and whether a point that is named but not explained counts.";
  }
  if (has.has("diagram-step-reserved")) {
    return "Confirm the figure is worth the mark reserved for it, and that a human will mark it.";
  }
  if (has.has("no-scheme-excerpt")) {
    return "Nothing from the scheme was copied across for this question. Read it in the PDF and confirm the steps below say the same thing.";
  }
  if (has.has("scheme-restates-the-question")) {
    return "The scheme reprints the question before answering it, and this rubric pays nothing for it. Confirm that is right — a student who copies the question out has earned nothing.";
  }
  if (has.has("figure-supplied-by-the-paper")) {
    return "This question shows a figure. Confirm the paper prints it and the student is not asked to draw one — if the student draws it, a mark has to be moved onto the drawing.";
  }
  if (has.has("keywords-lumped")) {
    return "The step accepts any one of the listed terms. Confirm that is right, or name the terms an answer must have together.";
  }
  if (has.has("mcq-bare-letter")) {
    return "Confirm that writing the option letter alone is a full answer.";
  }
  return "Read the steps against the scheme and confirm they say the same thing.";
}

function bandFor(factors) {
  const keys = new Set(factors.map((f) => f.key));
  return BANDS.find((b) => b.test(keys));
}

// --- assembling -----------------------------------------------------------

export async function buildQueue() {
  const papersFile = await readJson(PAPERS);
  const papers = new Map((papersFile.papers ?? papersFile).map((p) => [p.slug, p]));

  const rubrics = [];
  const sources = [];
  for (const s of SOURCES) {
    const file = await readJson(s.file);
    const list = rubricList(file);
    rubrics.push(...list.map((r) => ({ r, source: s.file, origin: s.origin })));
    sources.push({
      file: s.file,
      origin: s.origin,
      generatedAt: file?.generatedAt ?? null,
      rubrics: list.length,
      needsReview: list.filter((x) => x.needsReview).length,
    });
  }

  const byQuestion = new Set(
    rubrics.map(({ r }) => `${paperOf(r)}#${questionNoOf(r)}#${r.variant ?? ""}`),
  );

  const queue = [];
  for (const { r, source, origin } of rubrics) {
    if (!r.needsReview) continue;
    const { factors, score } = scoreRubric(r, byQuestion);
    const band = bandFor(factors);
    const paper = papers.get(paperOf(r));
    queue.push({
      band: band.band,
      score,
      id: r.id,
      source,
      origin,
      paper: paperOf(r),
      paperTitle: paper?.title ?? null,
      session: r.session ?? paper?.session ?? null,
      subject: paper?.subject ?? r.subject ?? null,
      questionNo: questionNoOf(r),
      variant: r.variant ?? null,
      variantsOffered: r.variantsOffered ?? null,
      type: r.type ?? null,
      maxMarks: maxMarksOf(r),
      gateSized: [3, 5].includes(maxMarksOf(r)),
      bookCode: pick(r, "bookCode", "book", "code") ?? null,
      chapter: pick(r, "chapter", "chapterNo", "chapterNumber", "ch") ?? null,
      markSplit: r.markSplit ?? null,
      prompt: r.prompt ?? null,
      schemeFile: r.scheme?.file ?? paper?.schemeFile ?? null,
      schemePdf: paper?.schemeFile ? `public/papers/${paper.schemeFile}` : null,
      schemePage: r.scheme?.page ?? null,
      schemeExcerpt: r.scheme?.excerpt ?? null,
      stepSummary: everyStep(r.steps).map((s) => ({
        id: s.id ?? null,
        kind: s.kind ?? "step",
        marks: s.marks ?? (s.chooseAtLeast != null ? s.chooseAtLeast * s.marksEach : null),
        awardFor: s.awardFor ?? null,
        autoGradable: s.kind !== "diagram",
      })),
      estimatedMinutes: band.minutesEach,
      decision: decisionFor(factors),
      factors: factors.map((f) => ({
        key: f.key,
        weight: f.weight,
        label: FACTOR.get(f.key).label,
        why: FACTOR.get(f.key).why,
        evidence: f.evidence,
      })),
      reviewNotes: r.reviewNotes ?? [],
    });
  }

  // Band, then score, then paper and question number: a stable total order, so
  // two runs over the same inputs are byte-identical, and a teacher working a
  // band stays inside one marking scheme PDF for as long as possible.
  const bandIndex = new Map(BANDS.map((b, i) => [b.band, i]));
  queue.sort(
    (a, b) =>
      bandIndex.get(a.band) - bandIndex.get(b.band) ||
      b.score - a.score ||
      String(a.paper).localeCompare(String(b.paper)) ||
      Number(a.questionNo) - Number(b.questionNo) ||
      a.id.localeCompare(b.id),
  );
  queue.forEach((row, i) => {
    row.rank = i + 1;
  });

  const bandRows = BANDS.map((b) => {
    const rows = queue.filter((q) => q.band === b.band);
    const oneByOne = rows.length * b.minutesEach;
    const batched = b.batch
      ? b.batch.policyMinutes +
        Math.ceil(rows.length * b.batch.spotCheckFraction) * b.minutesEach
      : oneByOne;
    return {
      band: b.band,
      label: b.label,
      holds: b.holds,
      rubrics: rows.length,
      gateSized: rows.filter((q) => q.gateSized).length,
      minutesEach: b.minutesEach,
      estimatedMinutes: oneByOne,
      batchedMinutes: batched,
      batch: b.batch ?? null,
      papers: [...new Set(rows.map((q) => q.paper))].sort(),
    };
  });

  const factorRows = FACTORS.map((f) => ({
    ...f,
    rubrics: queue.filter((q) => q.factors.some((x) => x.key === f.key)).length,
  }));

  const totalMinutes = bandRows.reduce((a, b) => a + b.estimatedMinutes, 0);
  const batchedMinutes = bandRows.reduce((a, b) => a + b.batchedMinutes, 0);
  const unblockMinutes = bandRows
    .filter((b) => b.band === "A" || b.band === "B")
    .reduce((a, b) => a + b.estimatedMinutes, 0);
  const hours = (m) => Math.round((m / 60) * 10) / 10;

  return {
    generator: "scripts/build-teacher-queue.mjs",
    // No wall clock anywhere: this file is regenerated from the rubrics and must
    // diff cleanly when the rubrics have not changed.
    sources,
    totals: {
      rubrics: rubrics.length,
      needsReview: queue.length,
      signedOff: rubrics.length - queue.length,
      gateSizedRubrics: rubrics.filter(({ r }) => [3, 5].includes(maxMarksOf(r))).length,
      gateSizedNeedingReview: queue.filter((q) => q.gateSized).length,
      estimatedMinutes: totalMinutes,
      estimatedHours: hours(totalMinutes),
      // What a teacher is actually quoted: band D settled by one ruling.
      batchedMinutes,
      batchedHours: hours(batchedMinutes),
      // Bands A and B alone — enough to unblock the grading gate.
      unblockMinutes,
      unblockHours: hours(unblockMinutes),
    },
    model: {
      note: "score = sum of the factor weights that fire. Bands are semantic; ordering inside a band is by score, then paper, then question number.",
      factors: factorRows,
      bands: bandRows,
    },
    queue,
  };
}

// --- CLI ------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const built = await buildQueue();
const json = `${JSON.stringify(built, null, 2)}\n`;

if (args.has("--print")) {
  const t = built.totals;
  console.log(`${t.needsReview} of ${t.rubrics} rubrics need review`);
  console.log(
    `${t.gateSizedNeedingReview} of ${t.gateSizedRubrics} 3- and 5-mark rubrics are unreviewed`,
  );
  for (const b of built.model.bands) {
    console.log(
      `  ${b.band}  ${String(b.rubrics).padStart(3)} rubrics  ` +
        `${String(b.gateSized).padStart(2)} gate-sized  ` +
        `${String(b.estimatedMinutes).padStart(4)} min` +
        (b.batch ? ` (${b.batchedMinutes} batched)` : "         ") +
        `  ${b.label}`,
    );
  }
  console.log(
    `  total ${t.estimatedMinutes} min (${t.estimatedHours} h); ` +
      `${t.batchedMinutes} min (${t.batchedHours} h) with band D batched; ` +
      `bands A+B alone ${t.unblockMinutes} min (${t.unblockHours} h)`,
  );
  for (const row of built.queue.slice(0, 15)) {
    console.log(`  #${row.rank} [${row.band}] ${row.score} ${row.id} — ${row.decision}`);
  }
} else if (args.has("--check")) {
  let current = null;
  try {
    current = await readFile(path.join(ROOT, OUT), "utf8");
  } catch {
    console.error(`${OUT} does not exist; run: node scripts/build-teacher-queue.mjs`);
    process.exit(1);
  }
  if (current !== json) {
    console.error(`${OUT} is stale; run: node scripts/build-teacher-queue.mjs`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date (${built.totals.needsReview} rubrics)`);
} else {
  await writeFile(path.join(ROOT, OUT), json);
  console.log(
    `wrote ${OUT}: ${built.totals.needsReview} rubrics, ${built.totals.estimatedHours} h of review`,
  );
}
