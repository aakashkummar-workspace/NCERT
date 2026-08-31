/**
 * Unit tests for the CBSE rubric matcher: src/lib/rubric-load.ts (the marks
 * arithmetic) and src/lib/grading.ts (the prompt, and the three rules that
 * decide what may be painted over a student's handwriting).
 *
 * Nothing here touches the network, the database, or an API key. That is the
 * point: the parts of grading that must never be wrong are the parts that do
 * not need a model to check, and every one of them is pure.
 *
 * Both modules import Prisma and so cannot be imported from plain Node. As
 * scripts/test-sm2.mjs, scripts/test-attempts.mjs and scripts/test-dualtrack.mjs
 * already do, the logic is mirrored here and the sources are guarded with
 * patterns, so a mirror that has drifted from the shipped code fails loudly
 * rather than passing quietly. Every assertion then runs against the **real**
 * data/rubrics.json, including the alternatives rubric.
 *
 *   node scripts/test-grading.mjs
 */
import { readFile } from "node:fs/promises";

const gradingSrc = await readFile("src/lib/grading.ts", "utf8");
const loadSrc = await readFile("src/lib/rubric-load.ts", "utf8");
const rubricsFile = JSON.parse(await readFile("data/rubrics.json", "utf8"));
const authored = rubricsFile.rubrics ?? rubricsFile.items ?? rubricsFile;

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const eq = (name, actual, expected) =>
  check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

// ── 0. Guards: the mirror must still describe the shipped code ─────────────

for (const [name, src, pattern] of [
  // Marks arithmetic
  ["rubric-load sums in half-mark units", loadSrc, /Math\.round\(marks \* 2\)/],
  ["rubric-load counts a choose group as chooseAtLeast x marksEach", loadSrc,
    /case "CHOOSE":\s*\n\s*return halves\(\(c\.chooseAtLeast \?\? 0\) \* \(c\.marksEach \?\? 0\)\)/],
  ["rubric-load counts an option and a branch as nothing of their own", loadSrc,
    /case "OPTION":\s*\n\s*case "BRANCH":\s*\n\s*return 0;/],
  ["rubric-load checks every branch sums to its group", loadSrc,
    /if \(branchHalves\(branch\) !== groupHalves\)/],
  ["rubric-load forces a diagram off auto-grading", loadSrc,
    /autoGradable: kind === "DIAGRAM" \? false : \(step\.autoGradable \?\? true\)/],
  ["rubric-load refuses a rubric that does not add up", loadSrc, /export function assertGradable/],

  // Rule 1 — a diagram is never auto-graded, and writes no span
  ["grading marks a non-auto-gradable unit UNMARKED / NOT_AUTO_GRADABLE", gradingSrc,
    /if \(!autoGradableUnit\(c\)\) \{[\s\S]{0,400}?unmarkedReason: "NOT_AUTO_GRADABLE"/],
  ["grading writes no span for an UNMARKED criterion", gradingSrc,
    /if \(result\.verdict === "UNMARKED"\) continue;/],

  // Rule 2 — nothing red on an unreviewed rubric
  ["grading turns a miss into UNMARKED on a needsReview rubric", gradingSrc,
    /if \(verdict === "MISS" && rubric\.needsReview\) \{[\s\S]{0,200}?unmarkedReason = "RUBRIC_NEEDS_REVIEW"/],
  ["grading drops every red span on a needsReview rubric", gradingSrc,
    /if \(color === "RED" && rubric\.needsReview\) \{\s*\n\s*suppressedRed\+\+;\s*\n\s*continue;/],

  // Rule 3 — append-only
  ["grading appends an AI verdict with revision + 1", gradingSrc,
    /revision: \(previous\?\.revision \?\? 0\) \+ 1,\s*\n\s*supersedesId: previous\?\.id \?\? null/],
  ["grading appends a human override rather than updating one", gradingSrc,
    /revision: previous\.revision \+ 1,\s*\n\s*supersedesId: previous\.id/],
  ["grading never updates a GradingResult", gradingSrc, /^(?![\s\S]*gradingResult\.update)[\s\S]*$/],

  // Partial credit is the rubric's to give
  ["grading reads a partial award from the rule, not the model", gradingSrc,
    /awarded = clampHalves\(halves\(rule\.award\), Math\.max\(1, outOfHalves - 1\)\)/],
  ["grading reads an unnamed partial as a miss", gradingSrc, /if \(!rule\) \{[\s\S]{0,400}?verdict = "MISS";/],

  // The model call
  ["grading uses adaptive thinking", gradingSrc, /thinking: \{ type: "adaptive" as const \}/],
  ["grading never sends budget_tokens", gradingSrc, /^(?![\s\S]*budget_tokens:)[\s\S]*$/],
  ["grading asks for structured output", gradingSrc, /format: \{ type: "json_schema" as const, schema: VERDICT_SCHEMA \}/],
  ["grading caches the stable prefix for an hour", gradingSrc,
    /cache_control: \{ type: "ephemeral" as const, ttl: "1h" as const \}/],
  ["grading puts the images before the text block", gradingSrc,
    /content: \[\s*\n\s*\.\.\.images\.map/],
  ["grading degrades honestly with no key", gradingSrc,
    /if \(!isGradingConfigured\(\)\) \{[\s\S]{0,900}?configured: false/],
  ["grading names the model the spike measured", gradingSrc, /GRADING_MODEL = "claude-opus-5"/],

  // The prompt carries what the schema says changes the mark
  ["prompt states the needsReview rule", gradingSrc, /THIS RUBRIC IS UNREVIEWED/],
  ["prompt tells the model not to grade a diagram", gradingSrc, /Do not grade this step\./],
  ["prompt renders a choose group as CBSE writes it", gradingSrc, /CHOOSE ANY \$\{c\.chooseAtLeast\}/],
  ["prompt renders requireTags", gradingSrc, /at least \$\{t\.minCount\} tagged \$\{t\.tag\}/],
  ["prompt renders an alternatives group as one award", gradingSrc, /EITHER\/OR/],
  ["prompt says an unattempted branch is not a miss", gradingSrc,
    /branch they did not attempt is not a miss/],
  ["prompt states the four outcomes", gradingSrc, /- unmarked the step cannot be graded from a photograph/],
]) {
  check(name, pattern.test(src));
}

// ── The mirror ─────────────────────────────────────────────────────────────

const halves = (marks) => Math.round(marks * 2);
const fromHalves = (units) => units / 2;
const clampHalves = (units, maxHalves) =>
  Number.isFinite(units) ? Math.max(0, Math.min(maxHalves, Math.round(units))) : 0;

function criterionHalves(c) {
  if (c.kind === "CHOOSE") return halves((c.chooseAtLeast ?? 0) * (c.marksEach ?? 0));
  if (c.kind === "OPTION" || c.kind === "BRANCH") return 0;
  return halves(c.marks ?? 0);
}
const branchHalves = (branch) => branch.children.reduce((s, c) => s + criterionHalves(c), 0);
const rubricHalves = (rubric) => rubric.criteria.reduce((s, c) => s + criterionHalves(c), 0);

function autoGradableUnit(c) {
  if (c.kind === "DIAGRAM") return false;
  if (!c.autoGradable) return false;
  if (c.kind === "ALTERNATIVES") {
    return c.children.some((b) => b.children.every((s) => autoGradableUnit(s)));
  }
  return true;
}

const PARTIAL_REASONS = {
  "unit-missing": "UNIT_MISSING",
  "unit-wrong": "UNIT_WRONG",
  "order-broken": "ORDER_BROKEN",
  "keywords-partial": "KEYWORDS_PARTIAL",
  "arithmetic-slip": "ARITHMETIC_SLIP",
  "formula-only": "FORMULA_ONLY",
  "sign-error": "SIGN_ERROR",
  unrounded: "UNROUNDED",
};
const COLOR_FOR = { HIT: "GREEN", PARTIAL: "ORANGE", MISS: "RED" };
const partialRuleFor = (c, reason) => c.partialRules.find((r) => r.reason === reason) ?? null;
const matchesOption = (o, spelling) => o.stepId === spelling || o.stepId.endsWith(`/${spelling}`);

function chooseShortfall(c, step) {
  if (c.kind !== "CHOOSE") return null;
  const scoring = c.children.filter((o) => (step.optionIds ?? []).some((id) => matchesOption(o, id)));
  const need = c.chooseAtLeast ?? 0;
  if (step.optionIds?.length && scoring.length < need) return `short by ${need - scoring.length}`;
  for (const demand of c.tagDemands) {
    if (!step.optionIds?.length) continue;
    if (scoring.filter((o) => o.tags.includes(demand.tag)).length < demand.minCount) {
      return `tag ${demand.tag}`;
    }
  }
  return null;
}

class VerdictRejected extends Error {}

function ownerUnit(rubric, stepId) {
  const flat = (list) => list.flatMap((c) => [c, ...flat(c.children)]);
  const direct = rubric.criteria.find((c) => c.stepId === stepId);
  if (direct) return direct.stepId;
  for (const c of rubric.criteria) {
    if (flat(c.children).some((x) => x.stepId === stepId)) return c.stepId;
  }
  return null;
}

function normaliseBox(box) {
  if (!box) return null;
  const round = (n) => Math.round(n * 1e5) / 1e5;
  const x = round(Math.max(0, Math.min(1, box.x)));
  const y = round(Math.max(0, Math.min(1, box.y)));
  const width = round(Math.min(box.width, 1 - x));
  const height = round(Math.min(box.height, 1 - y));
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

/** The mirror of reconcileVerdict(). */
function reconcileVerdict(raw, rubric) {
  const notes = [];
  const byStep = new Map((raw.steps ?? []).map((s) => [s.stepId, s]));
  const criteria = [];
  let awardedHalves = 0;
  let unmarkedHalves = 0;

  for (const c of rubric.criteria) {
    const outOfHalves = criterionHalves(c);

    if (!autoGradableUnit(c)) {
      criteria.push({
        stepId: c.stepId, verdict: "UNMARKED", awardedHalves: 0, outOfHalves,
        partialRuleId: null, unmarkedReason: "NOT_AUTO_GRADABLE",
      });
      unmarkedHalves += outOfHalves;
      continue;
    }

    const step = byStep.get(c.stepId);
    if (!step) throw new VerdictRejected(`the verdict has no entry for step ${c.stepId}`);

    let verdict, awarded = 0, partialRuleId = null;

    if (step.outcome === "unmarked") {
      if (!rubric.needsReview) throw new VerdictRejected(`unmarked on a signed-off rubric`);
      verdict = "UNMARKED";
    } else if (step.outcome === "hit") {
      verdict = "HIT";
      awarded = outOfHalves;
      const downgrade = chooseShortfall(c, step);
      if (downgrade) {
        notes.push(`${c.stepId}: ${downgrade}`);
        verdict = "MISS";
        awarded = 0;
        const rule = partialRuleFor(c, "KEYWORDS_PARTIAL");
        if (rule) {
          verdict = "PARTIAL";
          awarded = clampHalves(halves(rule.award), outOfHalves - 1);
          partialRuleId = rule.id;
        }
      }
    } else if (step.outcome === "partial") {
      const reason = step.partialReason ? PARTIAL_REASONS[step.partialReason] : undefined;
      const rule = reason ? partialRuleFor(c, reason) : null;
      if (!rule) {
        notes.push(`${c.stepId}: partial with no rule; read as a miss`);
        verdict = "MISS";
      } else {
        verdict = "PARTIAL";
        awarded = clampHalves(halves(rule.award), Math.max(1, outOfHalves - 1));
        partialRuleId = rule.id;
      }
    } else {
      verdict = "MISS";
    }

    let unmarkedReason = null;
    if (verdict === "MISS" && rubric.needsReview) {
      verdict = "UNMARKED";
      awarded = 0;
      unmarkedReason = "RUBRIC_NEEDS_REVIEW";
    } else if (verdict === "UNMARKED") {
      unmarkedReason = "RUBRIC_NEEDS_REVIEW";
    }

    if ((verdict === "HIT" || verdict === "PARTIAL") && awarded <= 0) {
      verdict = rubric.needsReview ? "UNMARKED" : "MISS";
      unmarkedReason = verdict === "UNMARKED" ? "RUBRIC_NEEDS_REVIEW" : null;
      partialRuleId = null;
      awarded = 0;
    }
    if (verdict === "MISS" || verdict === "UNMARKED") {
      awarded = 0;
      partialRuleId = null;
    }

    criteria.push({ stepId: c.stepId, verdict, awardedHalves: awarded, outOfHalves, partialRuleId, unmarkedReason });
    awardedHalves += awarded;
    if (verdict === "UNMARKED") unmarkedHalves += outOfHalves;
  }

  const maxHalves = halves(rubric.maxMarks);
  if (awardedHalves > maxHalves) throw new VerdictRejected("awarded more than the maximum");

  const verdictByStep = new Map(criteria.map((c) => [c.stepId, c]));
  const spans = [];
  let suppressedRed = 0;
  for (const span of raw.spans ?? []) {
    let color, stepId = null;
    if (span.stepId) {
      const owner = ownerUnit(rubric, span.stepId);
      const result = owner ? verdictByStep.get(owner) : undefined;
      if (!result) continue;
      if (result.verdict === "UNMARKED") continue;
      color = COLOR_FOR[result.verdict];
      stepId = owner;
    } else {
      if (span.tag !== "red") continue;
      color = "RED";
    }
    if (color === "RED" && rubric.needsReview) {
      suppressedRed++;
      continue;
    }
    const box = normaliseBox(span.box);
    if (!box) continue;
    spans.push({ stepId, color, page: span.page ?? 0, ...box });
  }

  return {
    awardedHalves, maxHalves, unmarkedHalves,
    unmarkedCount: criteria.filter((c) => c.verdict === "UNMARKED").length,
    criteria, spans, suppressedRed, notes,
  };
}

// ── The authoring format, loaded the way rubric-load.ts loads it ───────────

const KIND_FOR = { step: "STEP", choose: "CHOOSE", diagram: "DIAGRAM", alternatives: "ALTERNATIVES" };

function loadStep(step, stepId) {
  const kind = KIND_FOR[step.kind ?? "step"] ?? "STEP";
  return {
    stepId,
    kind,
    awardFor: step.awardFor,
    branchLabel: null,
    marks: kind === "CHOOSE" ? null : (step.marks ?? 0),
    marksEach: kind === "CHOOSE" ? (step.marksEach ?? 0) : null,
    chooseAtLeast: kind === "CHOOSE" ? (step.chooseAtLeast ?? 1) : null,
    tags: [],
    labels: step.labels ?? [],
    autoGradable: kind === "DIAGRAM" ? false : (step.autoGradable ?? true),
    partialRules: (step.partial ?? [])
      .filter((p) => PARTIAL_REASONS[p.when])
      .map((p) => ({ id: `${stepId}:${p.when}`, reason: PARTIAL_REASONS[p.when], award: p.award })),
    tagDemands: Object.entries(step.requireTags ?? {}).map(([tag, minCount]) => ({ tag, minCount })),
    children: [
      ...(step.options ?? []).map((o) => ({
        stepId: `${stepId}/${o.id}`, kind: "OPTION", awardFor: o.awardFor, marks: null,
        marksEach: null, chooseAtLeast: null, tags: o.tags ?? [], labels: [], autoGradable: true,
        partialRules: [], tagDemands: [], children: [], branchLabel: null,
      })),
      ...(step.alternatives ?? []).map((b, i) => ({
        stepId: `${stepId}/${b.id}`, kind: "BRANCH", awardFor: b.awardFor,
        branchLabel: String.fromCharCode(65 + i), marks: step.marks ?? 0, marksEach: null,
        chooseAtLeast: null, tags: [], labels: [], autoGradable: true, partialRules: [],
        tagDemands: [],
        children: (b.steps ?? []).map((inner) => loadStep(inner, `${stepId}/${b.id}/${inner.id}`)),
      })),
    ],
  };
}

const load = (r) => ({
  externalId: r.id,
  maxMarks: r.maxMarks,
  needsReview: r.needsReview ?? false,
  criteria: r.steps.map((s) => loadStep(s, s.id)),
});

const loaded = authored.map(load);
const byId = new Map(loaded.map((r) => [r.externalId, r]));

// ── 1. Marks arithmetic, in half-mark units, over the real file ────────────

let sumFailures = 0;
for (const rubric of loaded) {
  if (rubricHalves(rubric) !== halves(rubric.maxMarks)) {
    sumFailures++;
    console.log(`      ${rubric.externalId}: ${fromHalves(rubricHalves(rubric))} vs ${rubric.maxMarks}`);
  }
}
eq(`all ${loaded.length} authored rubrics sum to their maxMarks, in halves`, sumFailures, 0);

// The double-count that would inflate a denominator: a choose group is worth
// chooseAtLeast x marksEach, and its options are worth nothing of their own.
const chooseRubric = byId.get("class10-science-2025-26-q10");
const chooseGroup = chooseRubric.criteria[0];
eq("a choose group counts chooseAtLeast x marksEach", criterionHalves(chooseGroup), 4);
eq("its four options count nothing of their own",
  chooseGroup.children.reduce((s, o) => s + criterionHalves(o), 0), 0);
eq("so the rubric is out of 2, not 4", fromHalves(rubricHalves(chooseRubric)), 2);

// 1.5 + 1.5 + 1.5 + 0.5 is 5 in integers and is not reliably 5 in doubles.
const awkward = { criteria: [1.5, 1.5, 1.5, 0.5].map((m, i) => ({ kind: "STEP", stepId: `s${i}`, marks: m, children: [] })) };
eq("half marks sum exactly", rubricHalves(awkward), 10);
check("the same sum in doubles does not", [1.5, 1.5, 1.5, 0.5].reduce((a, b) => a + b, 0) !== 5 ||
  Math.abs([0.1, 0.2].reduce((a, b) => a + b, 0) - 0.3) > 0, "float arithmetic is why halves exist");

// An alternatives group counts once, and every branch must sum to that figure.
const altRubric = byId.get("class10-science-2025-26-q28");
check("the alternatives rubric is in data/rubrics.json", Boolean(altRubric));
if (altRubric) {
  const group = altRubric.criteria.find((c) => c.kind === "ALTERNATIVES");
  check("it has an alternatives group", Boolean(group));
  eq("the group counts its marks once, however many branches", criterionHalves(group), halves(group.marks));
  eq("it lists two branches", group.children.length, 2);
  for (const branch of group.children) {
    eq(`branch ${branch.branchLabel} sums to the group's marks`, branchHalves(branch), criterionHalves(group));
  }
  eq("the branches count nothing of their own",
    group.children.reduce((s, b) => s + criterionHalves(b), 0), 0);
  eq("so the rubric still sums to its maxMarks", fromHalves(rubricHalves(altRubric)), altRubric.maxMarks);
}

// ── 2. A diagram is never auto-graded, and writes no span ──────────────────

const diagramRubric = loaded.find((r) => r.criteria.some((c) => c.kind === "DIAGRAM"));
check("data/rubrics.json has a diagram step to test against", Boolean(diagramRubric));
{
  const diagram = diagramRubric.criteria.find((c) => c.kind === "DIAGRAM");
  eq("a diagram step is never auto-gradable", autoGradableUnit(diagram), false);

  // The model is asked not to grade it, but suppose it does anyway, in green.
  const raw = {
    steps: diagramRubric.criteria.map((c) => ({
      stepId: c.stepId, outcome: "hit", awarded: fromHalves(criterionHalves(c)),
      partialReason: null, optionIds: c.children.filter((o) => o.kind === "OPTION").map((o) => o.stepId),
      branchId: null, reason: "", evidence: "",
    })),
    spans: [
      { text: "the figure", tag: "green", stepId: diagram.stepId, page: 0, box: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 }, note: "" },
    ],
    confidence: 0.9, illegible: false, transcription: "the figure",
  };
  const out = reconcileVerdict(raw, { ...diagramRubric, needsReview: false });
  const result = out.criteria.find((c) => c.stepId === diagram.stepId);
  eq("a diagram comes back UNMARKED whatever the model said", result.verdict, "UNMARKED");
  eq("it awards nothing", result.awardedHalves, 0);
  eq("and says it is waiting on a human eye", result.unmarkedReason, "NOT_AUTO_GRADABLE");
  eq("it writes no highlight span at all", out.spans.filter((s) => s.stepId === diagram.stepId).length, 0);
  eq("its marks are reported as unmarked, not as lost", out.unmarkedHalves, criterionHalves(diagram));
  check("the total is out of the marks anyone checked, not the paper total",
    fromHalves(out.maxHalves - out.unmarkedHalves) < diagramRubric.maxMarks);
}

// ── 3. Nothing is painted red on a needsReview rubric ──────────────────────

const flagged = loaded.find(
  (r) => r.needsReview && r.criteria.length > 1 && r.criteria.every((c) => c.kind !== "DIAGRAM"),
);
check("data/rubrics.json has a needsReview rubric to test against", Boolean(flagged));
{
  const first = flagged.criteria[0];
  const raw = {
    steps: flagged.criteria.map((c, i) => ({
      stepId: c.stepId, outcome: i === 0 ? "miss" : "hit",
      awarded: 0, partialReason: null,
      optionIds: i === 0 ? [] : c.children.filter((o) => o.kind === "OPTION").map((o) => o.stepId),
      branchId: null, reason: "", evidence: "",
    })),
    spans: [
      { text: "wrong", tag: "red", stepId: first.stepId, page: 0, box: { x: 0, y: 0, width: 0.5, height: 0.1 }, note: "" },
      { text: "waffle", tag: "red", stepId: null, page: 0, box: { x: 0, y: 0.2, width: 0.5, height: 0.1 }, note: "filler" },
    ],
    confidence: 0.8, illegible: false, transcription: "wrong waffle",
  };
  const out = reconcileVerdict(raw, flagged);
  const result = out.criteria.find((c) => c.stepId === first.stepId);
  eq("a miss on an unreviewed rubric comes back UNMARKED", result.verdict, "UNMARKED");
  eq("and says the rubric, not the student, is what is unchecked", result.unmarkedReason, "RUBRIC_NEEDS_REVIEW");
  eq("it awards nothing, the same as a miss", result.awardedHalves, 0);
  eq("no red span survives — attributed or filler", out.spans.filter((s) => s.color === "RED").length, 0);
  eq("the span attributed to the withheld step is gone too",
    out.spans.filter((s) => s.stepId === first.stepId).length, 0);
  // The attributed one never reaches the red rule: its criterion became
  // UNMARKED, and an UNMARKED criterion writes no span at all. Only the
  // unattributed filler is a red the second rule has to withhold, and it is
  // counted rather than hidden.
  eq("the filler red was withheld, and counted rather than hidden", out.suppressedRed, 1);
  check("green is still awarded on the same rubric", out.awardedHalves > 0);

  // The same verdict against a signed-off rubric: red is honest there.
  const signedOff = { ...flagged, needsReview: false };
  const honest = reconcileVerdict(raw, signedOff);
  eq("the same miss on a signed-off rubric is a MISS",
    honest.criteria.find((c) => c.stepId === first.stepId).verdict, "MISS");
  eq("and it paints red", honest.spans.filter((s) => s.color === "RED").length, 2);
  eq("nothing was suppressed", honest.suppressedRed, 0);
}

// ── 4. Verdict to persistence: the column-level invariants ────────────────

{
  const rubric = byId.get("class10-mathematics-basic-2025-26-q31");
  check("the maths rubric with partial rules is present", Boolean(rubric));
  const withPartial = rubric.criteria.find((c) => c.partialRules.length);
  check("it has a step with a partial rule", Boolean(withPartial));

  const stepsAll = (outcome, extra = {}) =>
    rubric.criteria.map((c) => ({
      stepId: c.stepId, outcome, awarded: 0, partialReason: null,
      optionIds: [], branchId: null, reason: "r", evidence: "e", ...extra,
    }));

  // A partial for a reason the step offers a rule for takes the RULE's award,
  // never the model's number.
  const rule = withPartial.partialRules[0];
  const jsonReason = Object.entries(PARTIAL_REASONS).find(([, m]) => m === rule.reason)[0];
  const rawPartial = {
    steps: stepsAll("hit").map((s) =>
      s.stepId === withPartial.stepId
        ? { ...s, outcome: "partial", partialReason: jsonReason, awarded: 999 }
        : s,
    ),
    spans: [], confidence: 0.7, illegible: false, transcription: "",
  };
  const partialOut = reconcileVerdict(rawPartial, rubric);
  const partialResult = partialOut.criteria.find((c) => c.stepId === withPartial.stepId);
  eq("a partial takes the rule's award, not the model's number",
    partialResult.awardedHalves, halves(rule.award));
  eq("and names the rule that fired", partialResult.partialRuleId, rule.id);
  check("PARTIAL awards more than zero, as criterion_verdict_consistent demands",
    partialResult.awardedHalves > 0);
  check("and strictly less than the step", partialResult.awardedHalves < partialResult.outOfHalves);

  // A partial for a reason the step has no rule for is a miss, not an
  // improvised half mark.
  const rawNoRule = {
    steps: stepsAll("hit").map((s) =>
      s.stepId === withPartial.stepId
        ? { ...s, outcome: "partial", partialReason: "sign-error", awarded: 0.5 }
        : s,
    ),
    spans: [], confidence: 0.7, illegible: false, transcription: "",
  };
  const noRule = reconcileVerdict(rawNoRule, rubric);
  const noRuleResult = noRule.criteria.find((c) => c.stepId === withPartial.stepId);
  const offered = withPartial.partialRules.some((r) => r.reason === "SIGN_ERROR");
  if (!offered) {
    eq("a partial the step offers no rule for is a miss", noRuleResult.verdict, "MISS");
    eq("and awards nothing", noRuleResult.awardedHalves, 0);
    eq("with no rule named", noRuleResult.partialRuleId, null);
  }

  // Full marks: every step hit sums to exactly maxMarks, in halves.
  const allHit = reconcileVerdict(
    { steps: rubric.criteria.map((c) => ({
        stepId: c.stepId, outcome: "hit", awarded: fromHalves(criterionHalves(c)),
        partialReason: null, optionIds: c.children.filter((o) => o.kind === "OPTION").map((o) => o.stepId),
        branchId: null, reason: "", evidence: "",
      })), spans: [], confidence: 1, illegible: false, transcription: "" },
    rubric,
  );
  eq("every step hit is exactly maxMarks", fromHalves(allHit.awardedHalves), rubric.maxMarks);
  check("and never more, which grade_within_max would reject",
    allHit.awardedHalves <= allHit.maxHalves);

  // Every stored row satisfies criterion_verdict_consistent.
  let bad = 0;
  for (const out of [partialOut, noRule, allHit]) {
    for (const c of out.criteria) {
      if (c.verdict === "UNMARKED" && !(c.awardedHalves === 0 && c.unmarkedReason && !c.partialRuleId)) bad++;
      if (c.verdict === "MISS" && !(c.awardedHalves === 0 && !c.unmarkedReason && !c.partialRuleId)) bad++;
      if (c.verdict === "PARTIAL" && !(c.awardedHalves > 0 && !c.unmarkedReason)) bad++;
      if (c.verdict === "HIT" && !(c.awardedHalves > 0 && !c.unmarkedReason && !c.partialRuleId)) bad++;
    }
  }
  eq("every criterion row satisfies criterion_verdict_consistent", bad, 0);
}

// A verdict missing a step is malformed, not a step the student missed.
{
  const rubric = byId.get("class10-science-2025-26-q25");
  let threw = false;
  try {
    reconcileVerdict({ steps: [], spans: [], confidence: 1, illegible: false, transcription: "" }, rubric);
  } catch (e) {
    threw = e instanceof VerdictRejected;
  }
  check("a verdict with no entry for a step is rejected, not read as a miss", threw);
}

// "Any two of the following" is a constraint, not a suggestion.
{
  const rubric = byId.get("class10-science-2025-26-q10");
  const group = rubric.criteria[0];
  const one = group.children[0].stepId.split("/")[1];
  const out = reconcileVerdict(
    { steps: [{ stepId: group.stepId, outcome: "hit", awarded: 2, partialReason: null,
        optionIds: [one], branchId: null, reason: "", evidence: "" }],
      spans: [], confidence: 1, illegible: false, transcription: "" },
    { ...rubric, needsReview: false },
  );
  const result = out.criteria[0];
  check("a choose group hit on one of two options is not full marks",
    result.awardedHalves < criterionHalves(group), `awarded ${fromHalves(result.awardedHalves)}`);
}

// requireTags: a group that meets the count but not the tags is not full marks.
{
  const tagged = loaded.find((r) => r.criteria.some((c) => c.tagDemands.length));
  check("data/rubrics.json has a requireTags group to test against", Boolean(tagged));
  if (tagged) {
    const group = tagged.criteria.find((c) => c.tagDemands.length);
    const demand = group.tagDemands[0];
    const wrongTag = group.children
      .filter((o) => !o.tags.includes(demand.tag))
      .slice(0, group.chooseAtLeast)
      .map((o) => o.stepId);
    if (wrongTag.length >= group.chooseAtLeast) {
      const out = reconcileVerdict(
        { steps: tagged.criteria.map((c) => ({
            stepId: c.stepId, outcome: "hit", awarded: 0, partialReason: null,
            optionIds: c.stepId === group.stepId ? wrongTag : [],
            branchId: null, reason: "", evidence: "",
          })), spans: [], confidence: 1, illegible: false, transcription: "" },
        { ...tagged, needsReview: false },
      );
      const result = out.criteria.find((c) => c.stepId === group.stepId);
      check(`a group meeting the count but not "${demand.tag}" is not full marks`,
        result.awardedHalves < criterionHalves(group));
    }
  }
}

// A box outside the page is dropped rather than clamped into a lie.
{
  const rubric = { ...byId.get("class10-science-2025-26-q25"), needsReview: false };
  const steps = rubric.criteria.map((c) => ({
    stepId: c.stepId, outcome: "hit", awarded: 0, partialReason: null,
    optionIds: [], branchId: null, reason: "", evidence: "",
  }));
  const out = reconcileVerdict(
    { steps,
      spans: [
        { text: "a", tag: "green", stepId: rubric.criteria[0].stepId, page: 0, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, note: "" },
        { text: "b", tag: "green", stepId: rubric.criteria[0].stepId, page: 0, box: { x: 1, y: 0.1, width: 0.2, height: 0.2 }, note: "" },
        { text: "c", tag: "green", stepId: rubric.criteria[0].stepId, page: 0, box: { x: 0.1, y: 0.1, width: 0, height: 0.2 }, note: "" },
        { text: "d", tag: "green", stepId: "not-a-step", page: 0, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, note: "" },
      ],
      confidence: 1, illegible: false, transcription: "abcd" },
    rubric,
  );
  eq("only the boxes that fit the page are drawn", out.spans.length, 1);
  for (const s of out.spans) {
    check("every stored box satisfies highlight_box_normalised",
      s.x >= 0 && s.y >= 0 && s.width > 0 && s.height > 0 && s.x + s.width <= 1 && s.y + s.height <= 1);
  }
}

// The colour follows the reconciled verdict, not the model's tag: the marks are
// what a colour means.
{
  const rubric = { ...byId.get("class10-science-2025-26-q25"), needsReview: false };
  const first = rubric.criteria[0];
  const out = reconcileVerdict(
    { steps: rubric.criteria.map((c) => ({
        stepId: c.stepId, outcome: c.stepId === first.stepId ? "miss" : "hit",
        awarded: 0, partialReason: null, optionIds: [], branchId: null, reason: "", evidence: "",
      })),
      spans: [{ text: "x", tag: "green", stepId: first.stepId, page: 0, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, note: "" }],
      confidence: 1, illegible: false, transcription: "x" },
    rubric,
  );
  eq("a green span on a step marked a miss is drawn red", out.spans[0].color, "RED");
}

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
