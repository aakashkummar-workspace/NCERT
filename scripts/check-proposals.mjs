/**
 * Validate data/rubric-proposals.json — the drafts written for the fourteen
 * Part A decisions in docs/teacher-review.md.
 *
 *   node scripts/check-proposals.mjs
 *
 * A proposal is not a rubric, and the whole value of keeping it in its own file
 * is that nothing here can mark a student. So this checker's job is narrower
 * than check-rubrics.mjs's and pointed in a different direction. It asks four
 * things:
 *
 *   1. Does every proposal's step list sum to the question's maxMarks, in
 *      half-mark units? A proposal that does not add up is worse than no
 *      proposal, because it is an invitation to a teacher to sign off a
 *      denominator that is wrong.
 *   2. Does every proposal name a rubric that really exists — or, for a new
 *      rubric, an id that does not exist yet and a paper that does?
 *   3. Has a proposal silently been copied into data/rubrics.json or
 *      data/rubrics.draft.json? If a proposal's steps and the live rubric's
 *      steps are the same, the proposal has become live marking and this file
 *      is no longer a proposal file. That is the failure this script exists
 *      for: a draft that quietly stopped being a draft.
 *   4. Does each proposal actually say what it is inferring, what CBSE
 *      printed, what the teacher still has to answer and who it changes? A
 *      proposal with those blank is an assertion, not something to review.
 *
 * Sums are compared in half-marks, exactly as check-rubrics.mjs does, because
 * 1.5 + 1.5 + 1.5 + 0.5 does not land on 5 if you add doubles and hope.
 *
 * Exit code 1 on any error. Warnings do not fail the run.
 */
import { readFile } from "node:fs/promises";

const PROPOSALS = "data/rubric-proposals.json";
const LIVE = ["data/rubrics.json", "data/rubrics.draft.json"];
const PAPERS = "data/papers.json";

const KINDS = new Set(["replace-steps", "new-rubric", "confirm-as-is"]);
const STEP_KINDS = new Set(["step", "choose", "diagram", "alternatives"]);

/** The prose a reviewer needs before a proposal is worth reading at all. */
const REQUIRED_PROSE = [
  "todayAStudentLoses",
  "cbsePrinted",
  "iInferred",
  "teacherQuestion",
  "ifAdopted",
];

const errors = [];
const warnings = [];
const err = (ref, msg) => errors.push(`${ref}: ${msg}`);
const warn = (ref, msg) => warnings.push(`${ref}: ${msg}`);

const asString = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Marks in half-mark units, or undefined if not a positive multiple of 0.5. */
function halves(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const h = n * 2;
  return Number.isInteger(Math.round(h * 1e6) / 1e6) && Math.abs(h - Math.round(h)) < 1e-9
    ? Math.round(h)
    : undefined;
}

const showMarks = (h) => (h % 2 === 0 ? String(h / 2) : `${Math.floor(h / 2) || ""}½`);

/**
 * What one step contributes to the question's total, in half-marks. A `choose`
 * group is worth chooseAtLeast × marksEach; an `alternatives` group is worth
 * its own `marks` once, however many branches it lists.
 */
function stepHalves(ref, step, where) {
  if (!step || typeof step !== "object") {
    err(ref, `${where} is not an object`);
    return 0;
  }
  const kind = asString(step.kind) ?? "step";
  if (!STEP_KINDS.has(kind)) {
    err(ref, `${where} has kind "${kind}", which is not one of ${[...STEP_KINDS].join(", ")}`);
    return 0;
  }
  if (kind === "choose") {
    const each = halves(step.marksEach);
    const atLeast = Number(step.chooseAtLeast);
    if (each === undefined) {
      err(ref, `${where} is a choose group whose marksEach (${step.marksEach}) is not a positive multiple of 0.5`);
      return 0;
    }
    if (!Number.isInteger(atLeast) || atLeast < 1) {
      err(ref, `${where} is a choose group with chooseAtLeast ${step.chooseAtLeast}; it must be a whole number of at least 1`);
      return 0;
    }
    const options = Array.isArray(step.options) ? step.options : [];
    if (options.length < atLeast) {
      err(ref, `${where} asks for any ${atLeast} but lists only ${options.length} option(s) — a student cannot reach full marks`);
    }
    return each * atLeast;
  }
  const marks = halves(step.marks);
  if (marks === undefined) {
    err(ref, `${where} has marks ${step.marks}, which is not a positive multiple of 0.5`);
    return 0;
  }
  if (kind === "diagram" && step.autoGradable === true) {
    err(ref, `${where} is a diagram step claiming autoGradable: true — a drawing is never graded automatically`);
  }
  if (kind === "alternatives") {
    const branches = Array.isArray(step.alternatives) ? step.alternatives : [];
    if (branches.length < 2) {
      err(ref, `${where} is an alternatives group with ${branches.length} branch(es); it needs at least two`);
    }
    branches.forEach((b, i) => {
      const inner = Array.isArray(b?.steps) ? b.steps : [];
      const sum = inner.reduce((n, s, j) => n + stepHalves(ref, s, `${where} branch ${b?.id ?? i} step ${j + 1}`), 0);
      if (sum !== marks) {
        err(
          ref,
          `${where} branch "${b?.id ?? i}" sums to ${showMarks(sum)} but the group is worth ${showMarks(marks)} — ` +
            `a student who chose that branch would be graded out of a different total from one who chose the other`,
        );
      }
    });
  }
  // `partial` awards must be positive multiples of 0.5, strictly under the
  // step's marks. CBSE has no quarter mark, so a ½-mark step cannot be
  // partially credited at all — that is the trap this catches.
  const partials = Array.isArray(step.partial) ? step.partial : [];
  for (const p of partials) {
    const award = halves(p?.award);
    if (award === undefined) {
      err(ref, `${where} has a partial rule awarding ${p?.award}, which is not a positive multiple of 0.5`);
    } else if (award >= marks) {
      err(ref, `${where} has a partial rule awarding ${showMarks(award)} on a ${showMarks(marks)}-mark step — a partial award must be strictly less`);
    }
  }
  if (marks === 1 && partials.length) {
    err(
      ref,
      `${where} is a ½-mark step with ${partials.length} partial rule(s). CBSE awards no quarter mark, so a ½-mark step is green or red with nothing between — delete the partial`,
    );
  }
  return marks;
}

/** A stable shape for two step lists, so "has this been copied across?" is answerable. */
function fingerprint(steps) {
  const norm = (s) => {
    if (!s || typeof s !== "object") return null;
    const kind = asString(s.kind) ?? "step";
    const base = { kind, marks: s.marks ?? null, awardFor: asString(s.awardFor) ?? "" };
    if (kind === "choose") {
      return {
        ...base,
        chooseAtLeast: s.chooseAtLeast ?? null,
        marksEach: s.marksEach ?? null,
        options: (Array.isArray(s.options) ? s.options : []).map((o) => asString(o?.awardFor) ?? "").sort(),
      };
    }
    if (kind === "alternatives") {
      return {
        ...base,
        alternatives: (Array.isArray(s.alternatives) ? s.alternatives : []).map((b) => ({
          id: asString(b?.id) ?? "",
          steps: (Array.isArray(b?.steps) ? b.steps : []).map(norm),
        })),
      };
    }
    return {
      ...base,
      keywords: (Array.isArray(s.keywords) ? s.keywords : []).map((c) =>
        (Array.isArray(c?.any) ? c.any : []).map((w) => String(w).toLowerCase().trim()).sort(),
      ),
    };
  };
  return JSON.stringify((Array.isArray(steps) ? steps : []).map(norm));
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const rubricsOf = (doc) =>
  Array.isArray(doc) ? doc : Array.isArray(doc?.rubrics) ? doc.rubrics : Array.isArray(doc?.items) ? doc.items : [];

const main = async () => {
  const doc = await readJson(PROPOSALS);
  const proposals = Array.isArray(doc?.proposals) ? doc.proposals : null;
  if (!proposals) {
    console.log(`${PROPOSALS}: no "proposals" array. Nothing to check.`);
    process.exit(1);
  }

  // Every live rubric, by id, and which file it lives in.
  const live = new Map();
  for (const path of LIVE) {
    for (const r of rubricsOf(await readJson(path))) {
      const id = asString(r?.id);
      if (id) live.set(id, { file: path, rubric: r });
    }
  }

  const paperSlugs = new Set(
    rubricsOf(await readJson(PAPERS).then((d) => (Array.isArray(d?.papers) ? { rubrics: d.papers } : d))).map(
      (p) => asString(p?.slug) ?? asString(p?.paper),
    ),
  );

  const seenRefs = new Set();
  let steppedProposals = 0;
  let diagramMarks = 0;
  let inferredSplits = 0;
  const perRef = [];

  for (const [i, p] of proposals.entries()) {
    const ref = asString(p?.ref) ?? `proposal ${i + 1}`;
    if (seenRefs.has(ref)) err(ref, "duplicate ref — two proposals answer the same Part A entry");
    seenRefs.add(ref);

    const kind = asString(p?.kind);
    if (!KINDS.has(kind)) {
      err(ref, `kind "${p?.kind}" is not one of ${[...KINDS].join(", ")}`);
      continue;
    }

    for (const field of REQUIRED_PROSE) {
      if (!asString(p?.[field])) {
        err(ref, `${field} is empty. A proposal a teacher cannot check the reasoning of is an assertion, not a proposal`);
      }
    }

    const rubricId = asString(p?.targets?.rubricId);
    if (!rubricId) {
      err(ref, "targets.rubricId is missing — nothing says which rubric this is about");
      continue;
    }
    const hit = live.get(rubricId);

    if (kind === "new-rubric") {
      if (hit) {
        err(
          ref,
          `proposes a NEW rubric "${rubricId}", but a rubric with that id already exists in ${hit.file}. ` +
            `Either it has been adopted — in which case delete this proposal — or the id collides and must be changed`,
        );
      }
      const slug = asString(p?.paper);
      if (slug && paperSlugs.size && !paperSlugs.has(slug)) {
        err(ref, `paper "${slug}" is not in ${PAPERS}, so this rubric could never be loaded`);
      }
      const inner = asString(p?.proposed?.id);
      if (inner && inner !== rubricId) {
        err(ref, `targets.rubricId is "${rubricId}" but proposed.id is "${inner}" — they must agree or the wrong thing gets copied`);
      }
    } else if (!hit) {
      err(
        ref,
        `names rubric "${rubricId}", which exists in neither ${LIVE.join(" nor ")}. ` +
          `A proposal against a rubric that is not there cannot be applied to anything`,
      );
      continue;
    } else if (asString(p?.targets?.file) && asString(p.targets.file) !== hit.file) {
      warn(ref, `says the rubric lives in ${p.targets.file}, but it was found in ${hit.file}`);
    }

    if (kind === "confirm-as-is") {
      if (p?.proposed !== null && p?.proposed !== undefined) {
        err(ref, "is a confirm-as-is proposal but carries a proposed block. Confirming a rubric means changing nothing — delete it or change the kind");
      }
      perRef.push({ ref, kind, rubricId, marks: null });
      continue;
    }

    // --- 1. Does it add up? ---
    const steps = p?.proposed?.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      err(ref, "proposed.steps is missing or empty — there is nothing here for a teacher to approve");
      continue;
    }
    const want = halves(p?.maxMarks);
    if (want === undefined) {
      err(ref, `maxMarks ${p?.maxMarks} is not a positive multiple of 0.5`);
      continue;
    }
    if (hit && halves(hit.rubric?.maxMarks) !== want) {
      err(
        ref,
        `says the question is worth ${p.maxMarks}, but ${rubricId} in ${hit.file} says ${hit.rubric?.maxMarks}. ` +
          `One of them is grading out of the wrong denominator`,
      );
    }
    const got = steps.reduce((n, s, j) => n + stepHalves(ref, s, `proposed step ${j + 1} (${asString(s?.id) ?? "no id"})`), 0);
    if (got !== want) {
      err(
        ref,
        `proposed steps sum to ${showMarks(got)} but the question is worth ${showMarks(want)}. ` +
          `Every attempt at this question would be graded out of the wrong total`,
      );
    }

    // A step id used twice means a graded answer cannot say which step it matched.
    const ids = [];
    const collect = (list) => {
      for (const s of list) {
        if (asString(s?.id)) ids.push(asString(s.id));
        if (Array.isArray(s?.alternatives)) for (const b of s.alternatives) collect(Array.isArray(b?.steps) ? b.steps : []);
      }
    };
    collect(steps);
    const dupes = ids.filter((id, n) => ids.indexOf(id) !== n);
    if (dupes.length) err(ref, `step id(s) used more than once: ${[...new Set(dupes)].join(", ")}`);

    // --- Provenance: an inferred split has to admit it. ---
    const split = asString(p?.proposed?.markSplit);
    if (split && !["printed", "inferred"].includes(split)) {
      err(ref, `proposed.markSplit is "${split}"; it must be "printed" or "inferred"`);
    }
    if (split === "inferred") {
      inferredSplits += 1;
      if (p?.proposed?.needsReview !== true) {
        err(ref, "proposes an inferred mark split without needsReview: true. An invented split that reads as an official one is a rubric nobody can review");
      }
    }
    if (p?.proposed?.needsReview === true && !(Array.isArray(p?.proposed?.reviewNotes) && p.proposed.reviewNotes.length)) {
      err(ref, "sets needsReview: true with no reviewNotes saying what needs reviewing");
    }
    if (p?.proposed?.needsReview !== true) {
      err(
        ref,
        "does not set needsReview: true. Nothing proposed in this file has been read by a teacher, so nothing copied out of it may paint a student's answer red",
      );
    }

    // --- 3. Has it silently gone live? ---
    if (hit) {
      const before = fingerprint(hit.rubric?.steps);
      const after = fingerprint(steps);
      if (before === after) {
        err(
          ref,
          `the steps proposed here are already the steps of "${rubricId}" in ${hit.file}. ` +
            `This proposal has been adopted into live marking, and leaving it in this file makes an approved decision look like an open one. Delete the proposal`,
        );
      }
    }

    steppedProposals += 1;
    const dsum = steps.filter((s) => asString(s?.kind) === "diagram").reduce((n, s) => n + (halves(s.marks) ?? 0), 0);
    if (dsum) diagramMarks += 1;
    perRef.push({ ref, kind, rubricId, marks: want, diagram: dsum });
  }

  // ---- report ----
  console.log(`${PROPOSALS} — ${proposals.length} proposal(s) for docs/teacher-review.md Part A.\n`);
  console.log("These are drafts. Nothing here marks anybody until a teacher copies it into data/rubrics.json.\n");
  for (const r of perRef) {
    const shape =
      r.marks === null
        ? "no change proposed"
        : `${showMarks(r.marks)} marks` + (r.diagram ? `, ${showMarks(r.diagram)} of them on a drawing a person must mark` : "");
    console.log(`  ${r.ref.padEnd(5)} ${r.kind.padEnd(14)} ${r.rubricId.padEnd(48)} ${shape}`);
  }

  console.log(
    `\n${steppedProposals} proposal(s) carry a step breakdown; ${inferredSplits} of those infer the split rather than reading it off CBSE's margin; ` +
      `${diagramMarks} reserve at least one mark for a drawing, which no grader will ever award.`,
  );

  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  if (errors.length) {
    console.log(`\n${errors.length} error(s) — these proposals must not be put in front of a teacher as they stand:`);
    for (const e of errors) console.log(`  x ${e}`);
    console.log("\nSee data/rubrics.schema.md for the shape a proposal has to be expressible in.");
    process.exit(1);
  }

  console.log("\nAll proposals add up, name a rubric that exists, and are still proposals.");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
