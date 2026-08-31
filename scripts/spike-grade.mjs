/**
 * Spike: photographed handwritten answer + rubric -> structured grading verdict.
 *
 *   node scripts/spike-grade.mjs --dry-run                       # offline: builds and prices every request
 *   node scripts/spike-grade.mjs --show-prompt                   # offline: prints what the model is told
 *   node scripts/spike-grade.mjs --answers a.json --rubrics r.json --out verdicts.json
 *   node scripts/spike-grade.mjs --answers a.json --rubrics r.json --out verdicts.json --batch
 *
 * Then:  node scripts/spike-score.mjs --verdicts verdicts.json --truth truth.json
 *
 * This is a measurement instrument, not a feature. It exists to settle the
 * riskiest assumption in the product in week four rather than month six: can a
 * vision model mark a Class 10 handwritten answer as well as a teacher? It is
 * deliberately throwaway. Optimise it for "the number spike-score prints is
 * trustworthy", not for elegance.
 *
 * --dry-run needs neither the SDK nor a network nor a key: it builds every
 * request body, checks every rubric, and prices the run. Use it before spending
 * money, because a malformed rubric discovered after 100 API calls is 100 calls
 * of wasted budget.
 *
 * =========================================================================
 * RUBRIC INTERFACE  (the shape this script CONSUMES)
 * =========================================================================
 * data/rubrics.json, exactly as data/rubrics.schema.md defines it. That file is
 * the contract; this one is a consumer and must not fork it. Rubrics are read,
 * never written, and never validated in full here — `npm run rubric:check` owns
 * that. What this file checks is only what would waste money or corrupt the
 * measurement if it were wrong:
 *
 *   - a rubric exists for every answer, found by `id`
 *   - step ids are unique within a rubric, so a verdict's per-step decisions stay
 *     traceable back to the step that produced them
 *   - the steps sum to `maxMarks`, in half-mark units, counting a `choose` group
 *     as `chooseAtLeast * marksEach`. A rubric that does not add up grades every
 *     attempt out of the wrong denominator, and spike-score would measure that
 *     as a model failure rather than the data error it is
 *
 * The parts of the schema this file deliberately carries into the prompt, because
 * dropping any of them changes the mark:
 *
 *   kind: "step"     marks, awardFor, keywords (concepts, each a set of accepted
 *                    phrasings), match all|any, unit.required, ordered, partial[]
 *   kind: "choose"   chooseAtLeast, marksEach, options[], requireTags — CBSE's
 *                    "any two of the following", which a flat step list cannot say
 *   kind: "diagram"  never auto-graded; returned as outcome "unmarked"
 *   needsReview      nothing may be painted red on an unreviewed rubric
 *   acceptEquivalentWording, ordering
 *
 * `class` and `subject` are advisory in the schema — `bookCode` + `chapter` are
 * authoritative. This spike only ever reports `subject`, so it takes the advisory
 * value and says so; a real grader must resolve it through the manifest.
 *
 * `prompt` is documented as abbreviated and "for the reviewer, not the grader".
 * It is sent anyway, because a model marking a photograph with no idea what was
 * asked marks worse than one with an abbreviated stem — but see the note at the
 * foot of this file: the full question paper is one of the things a human still
 * has to supply before this produces a real verdict.
 *
 * =========================================================================
 * ANSWERS INTERFACE  (this file's own; nothing else consumes it)
 * =========================================================================
 *   Answer {
 *     answerId:  string   // unique; becomes the batch custom_id and spike-score's join key
 *     rubricId:  string   // a rubric `id` in data/rubrics.json
 *     imagePath: string   // photograph of the handwritten answer (jpeg/png/webp/gif)
 *   }
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, "fixtures", "spike", "sample-run");
const RUBRICS = path.join(HERE, "..", "data", "rubrics.json");

const MODEL = "claude-opus-5";
const MAX_TOKENS = 16000;

// Opus 5 list price, $ per million tokens. Cache writes cost 1.25x input, cache
// reads 0.1x, and the Batches API halves everything.
const PRICE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

// A prefix shorter than the model's minimum is not cached, and the API says
// nothing about it — you only ever see it as a cache_read_input_tokens of zero
// that nobody looks at. The minimum is model-dependent (512-4096); 1024 is the
// figure to design against. Short rubrics can land under it, so the dry run says
// so out loud rather than letting the run quietly cost 10x on the prefix.
const MIN_CACHEABLE_PREFIX = 1024;

// =========================================================================
// The verdict schema.
// =========================================================================
// Carried on output_config.format, so the model cannot hand back prose we then
// have to parse with a regex. Every field exists because something downstream
// needs it:
//   marksAwarded  - the only number spike-score.mjs measures the gate on
//   steps[]       - per-step award decisions, traceable to the rubric's stepIds,
//                   so a teacher reviewing a wrong mark can see WHERE it went wrong
//   spans[]       - the green/orange/red highlights the Rubric-Matcher UI draws
//                   over the student's own words (PRD, Epic 1)
//   confidence    - decides what a human must re-check; spike-score reports the
//                   within-tolerance rate above and below the threshold, which is
//                   what tells us whether low-confidence routing is even viable
//   transcription - what the model believed it read. When a mark is wrong this is
//                   usually where you find out why, and it costs a few hundred
//                   output tokens to have it
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    rubricId: { type: "string" },
    marksAwarded: {
      type: "number",
      description: "Total marks, 0..maxMarks, in halves. Must equal the sum of steps[].awarded.",
    },
    maxMarks: { type: "number" },
    // A diagram step is never auto-graded, so its marks are missing from
    // marksAwarded rather than refused. Without this field that shows up in
    // spike-score as the model being harsh, which would be a lie about the
    // model: a question carrying a diagram step cannot be compared to a teacher
    // total until a human marks that step or the question is excluded.
    unmarkedMarks: {
      type: "number",
      description: "Sum of outOf over steps left unmarked. 0 when every step was gradable.",
    },
    steps: {
      type: "array",
      description: "One entry per rubric step, in rubric order. Never invent a stepId.",
      items: {
        type: "object",
        properties: {
          stepId: { type: "string" },
          outOf: { type: "number" },
          awarded: { type: "number" },
          // The schema's own four outcomes, not a vocabulary of this file's
          // invention, so a verdict lines up with what a rubric can express.
          outcome: { type: "string", enum: ["hit", "partial", "miss", "unmarked"] },
          partialReason: {
            type: ["string", "null"],
            description: "Required when outcome is partial, null otherwise. Must be a `when` value the step's partial[] list offers.",
            enum: [
              "unit-missing",
              "unit-wrong",
              "order-broken",
              "keywords-partial",
              "arithmetic-slip",
              "formula-only",
              "sign-error",
              "unrounded",
              null,
            ],
          },
          optionIds: {
            type: "array",
            description: "For a choose group: the option ids that scored, in no particular order. Empty for other kinds.",
            items: { type: "string" },
          },
          reason: {
            type: "string",
            description: "One sentence a teacher would accept as justification.",
          },
          evidence: {
            type: "string",
            description:
              "The student's own words that earned or lost this step, quoted verbatim. Empty if absent.",
          },
        },
        required: ["stepId", "outOf", "awarded", "outcome", "partialReason", "optionIds", "reason", "evidence"],
        additionalProperties: false,
      },
    },
    spans: {
      type: "array",
      description:
        "Highlights over the student's text. green = core curriculum keyword or step confirmed. " +
        "orange = step present but losing fractional marks (structure, calculation, missing units). " +
        "red = irrelevant filler yielding zero value. Quote verbatim so the UI can locate each span.",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          tag: { type: "string", enum: ["green", "orange", "red"] },
          stepId: { type: ["string", "null"] },
          note: { type: "string" },
        },
        required: ["text", "tag", "stepId", "note"],
        additionalProperties: false,
      },
    },
    confidence: {
      type: "number",
      description:
        "0..1. How likely a CBSE teacher would award the same mark. Lower it for unreadable " +
        "handwriting, cropped pages, or a rubric that does not fit what the student attempted.",
    },
    illegible: {
      type: "boolean",
      description: "True if the photograph could not be read well enough to mark fairly.",
    },
    transcription: {
      type: "string",
      description: "The answer as read, verbatim. Mark unreadable runs as [illegible].",
    },
  },
  required: [
    "rubricId",
    "marksAwarded",
    "maxMarks",
    "unmarkedMarks",
    "steps",
    "spans",
    "confidence",
    "illegible",
    "transcription",
  ],
  additionalProperties: false,
};

// =========================================================================
// The prompt.
// =========================================================================
// Byte-stable, and first in the request, so it caches. Nothing per-answer, no
// timestamps, no ids: one varying character here costs the cache on every call.
const SYSTEM_INSTRUCTIONS = `You are an experienced CBSE board examiner marking Class 9 and Class 10 answer scripts. You are marking a photograph of one handwritten answer against one official marking scheme.

Mark exactly as a CBSE examiner marks:
- Award marks step by step, against the rubric's steps and nothing else. A step earns its marks when the student has done what the step describes, in their own words or the rubric's.
- Never award a step the student did not attempt, however good the rest of the answer is.
- Never withhold a step the student did earn because the wording differs from the rubric, or because the handwriting is untidy, or because the working is out of order.
- Keywords in the rubric are what an examiner looks for, never what an examiner requires. A correct answer in different words earns full marks. Repeating a keyword without understanding earns nothing.
- Follow-through applies: a later step worked correctly from an earlier wrong value still earns its marks.
- Award fractional marks only where the step lists a partial rule, and only for the reason that rule names. If a step is flawed in a way its partial list does not cover, it is a miss, not an improvised half mark.
- Half marks are the finest grain CBSE uses. There are no quarter marks, marks below zero, or marks above the maximum.

Each step resolves to exactly one outcome:
- hit      every required concept present, unit present where required, ordering respected. Award the step's full marks.
- partial  the step is there but flawed in a way the step's partial[] list names. Award that rule's award, and give its "when" as partialReason.
- miss     the step is not there. Award zero.
- unmarked the step cannot be graded from a photograph — a diagram step, always. Award zero and say so; a human will mark it.

Two rules about being wrong, because they are not symmetric:
- Awarding marks the student did not earn is the worse error. A student told they are ready when they are not will fail the board exam, and the first teacher who sees an inflated mark stops trusting this tool entirely.
- Withholding marks the student did earn is an error too, and you must not correct for the rule above by marking harshly. Mark what is on the page.
- When you genuinely cannot tell, mark what you can defend and lower your confidence. Do not split the difference.

Report your reading honestly: if the photograph is cropped, blurred or too dark to read, say so in transcription, set illegible, and lower confidence rather than guessing at marks.

Quote the student verbatim in every evidence and span field, so a teacher can check you against the page. Tag spans green where a step or core keyword is confirmed, orange where a step is present but loses fractional marks, red where the text is filler that earns nothing.`;

/** data/rubrics.json is `{rubrics: [...]}`, `{items: [...]}` or a bare array. */
export function rubricList(file) {
  const list = Array.isArray(file) ? file : (file?.rubrics ?? file?.items);
  if (!Array.isArray(list)) throw new Error("rubrics file is not an array, {rubrics:[]} or {items:[]}");
  return list;
}

/** The schema's tolerated spelling for maxMarks. Everything else must be canonical. */
const maxMarksOf = (r) => r.maxMarks ?? r.marks ?? r.totalMarks;

/** What a step is worth: a choose group is worth chooseAtLeast x marksEach. */
export function stepMarks(step) {
  return (step.kind ?? "step") === "choose"
    ? (step.chooseAtLeast ?? 0) * (step.marksEach ?? 0)
    : (step.marks ?? 0);
}

/**
 * Only what would waste money or corrupt the measurement. `npm run rubric:check`
 * is the real validator and this must not grow into a second one.
 */
export function validateRubric(rubric) {
  const problems = [];
  const id = rubric?.id ?? "<no id>";
  const max = maxMarksOf(rubric ?? {});
  if (!rubric?.id) problems.push("rubric has no id");
  if (!Number.isFinite(max) || max <= 0) problems.push(`${id}: maxMarks is not a positive number`);
  if (!Array.isArray(rubric?.steps) || rubric.steps.length === 0) {
    problems.push(`${id}: no steps`);
    return problems;
  }
  const seen = new Set();
  // Halves are summed in half-mark units, per the schema: 1.5+1.5+1.5+0.5 is 5
  // in integers and is not reliably 5 in doubles.
  let halves = 0;
  for (const s of rubric.steps) {
    if (!s?.id) problems.push(`${id}: a step has no id`);
    else if (seen.has(s.id)) problems.push(`${id}: duplicate step id ${s.id}`);
    else seen.add(s.id);
    const m = stepMarks(s);
    if (!Number.isFinite(m) || m <= 0) problems.push(`${id}: step ${s?.id} is worth no marks`);
    else halves += Math.round(m * 2);
  }
  if (Number.isFinite(max) && halves !== Math.round(max * 2)) {
    problems.push(`${id}: steps sum to ${halves / 2} but maxMarks is ${max}`);
  }
  return problems;
}

const concepts = (keywords) =>
  (keywords ?? []).map((k) => (k?.any ?? []).join(" / ")).filter(Boolean);

function renderStep(step, index, rubric) {
  const kind = step.kind ?? "step";
  const marks = stepMarks(step);
  const plural = marks === 1 ? "" : "s";
  const L = [];

  if (kind === "choose") {
    L.push(
      `  ${index}. [${step.id}] CHOOSE ANY ${step.chooseAtLeast} (${step.marksEach} mark each, ` +
        `${marks} mark${plural} in total) - ${step.awardFor ?? ""}`,
    );
    if (step.requireTags) {
      const req = Object.entries(step.requireTags).map(([t, n]) => `at least ${n} tagged ${t}`);
      L.push(`     and: ${req.join(", ")}`);
    }
    for (const o of step.options ?? []) {
      const c = concepts(o.keywords);
      L.push(
        `       (${o.id}) ${o.awardFor ?? ""}` +
          (o.tags?.length ? `  [tags: ${o.tags.join(", ")}]` : "") +
          (c.length ? `\n           looks for: ${c.join("; ")}` : ""),
      );
    }
    L.push(`     Options are order-free. Report the scoring option ids in optionIds.`);
    return L.join("\n");
  }

  if (kind === "diagram") {
    L.push(`  ${index}. [${step.id}] DIAGRAM (${marks} mark${plural}) - ${step.awardFor ?? ""}`);
    if (step.labels?.length) L.push(`     labels a teacher will look for: ${step.labels.join(", ")}`);
    L.push(`     Do not grade this step. Return outcome "unmarked" and awarded 0; a human marks it.`);
    return L.join("\n");
  }

  L.push(`  ${index}. [${step.id}] (${marks} mark${plural}) ${step.awardFor ?? ""}`);
  const c = concepts(step.keywords);
  if (c.length) {
    const how = step.match === "any" ? "ANY ONE of these concepts" : "ALL of these concepts";
    L.push(`     needs ${how}, in any listed phrasing or an equivalent:`);
    for (const one of c) L.push(`       - ${one}`);
  }
  if (step.unit?.required) {
    L.push(`     the unit is required; accepted: ${(step.unit.accepted ?? []).join(", ")}`);
  }
  // Only where the step disagrees with the rubric's own default, which the
  // header already states. Repeating the default on every step is tokens spent
  // to tell the model something it has been told.
  const ordered = step.ordered ?? rubric.ordering === "ordered";
  if (step.ordered !== undefined && ordered !== (rubric.ordering === "ordered")) {
    L.push(
      ordered
        ? `     this step alone is ordered: it must follow the steps above it`
        : `     this step alone is order-free`,
    );
  }
  for (const p of step.partial ?? []) {
    L.push(`     partial: ${p.award} mark${p.award === 1 ? "" : "s"} when ${p.when}${p.note ? ` (${p.note})` : ""}`);
  }
  return L.join("\n");
}

/**
 * The rubric block. Stable for every student who answered this question, so it
 * sits behind its own cache breakpoint.
 */
export function rubricPrompt(rubric) {
  const max = maxMarksOf(rubric);
  const steps = rubric.steps.map((s, i) => renderStep(s, i + 1, rubric)).join("\n");
  const L = [
    "MARKING SCHEME",
    `Rubric id: ${rubric.id}   Question ${rubric.questionNo}${rubric.variant ? ` option ${rubric.variant}` : ""} of ${rubric.paper}`,
    `Subject: ${rubric.subject ?? "unknown"}   Class: ${rubric.class ?? "unknown"}   Type: ${rubric.type ?? "unknown"}   Maximum marks: ${max}`,
    "",
    "Question as set (abbreviated for the reviewer; the photograph is the authority):",
    rubric.prompt ?? "(not recorded)",
    "",
    `Steps are ${rubric.ordering === "ordered" ? "ordered: position is load-bearing unless a step says otherwise" : "unordered: any sequence earns the same marks"}.`,
    rubric.acceptEquivalentWording === false
      ? "Equivalent wording is NOT accepted on this question: the answer is a specific term or number, and a near miss is not a hit."
      : "Equivalent wording is accepted: a correct answer in the student's own words is a hit.",
    "",
    "Steps:",
    steps,
  ];

  if (rubric.needsReview) {
    // The schema's rule, and the one mistake it says has no recovery.
    L.push(
      "",
      "THIS RUBRIC IS UNREVIEWED. Do not return any span tagged red for this answer, and do not",
      "return outcome \"miss\". Where you would have, return \"unmarked\" with awarded 0 and say why in",
      "reason. An unchecked conversion must never accuse a student of writing nothing of value.",
    );
    if (rubric.reviewNotes?.length) L.push(`Reviewer noted: ${rubric.reviewNotes.join("; ")}`);
  }

  L.push(
    "",
    `Return one verdict, with one steps[] entry per step above, in this order, using these exact step ids.`,
  );
  return L.join("\n");
}

const MEDIA_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function mediaTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) throw new Error(`unsupported image type for ${file} (want ${Object.keys(MEDIA_TYPES).join(", ")})`);
  return type;
}

/**
 * Build the request for one answer.
 *
 * Cache layout, and the reason for it: the system array holds the stable
 * instructions and then the rubric, each with its own 1h breakpoint. The
 * volatile part — the photograph and the two lines naming this student's answer
 * — comes after, in messages. Grade all the answers to one question
 * consecutively and the rubric prefix stays hot across the whole group.
 */
export function buildParams(answer, rubric, imageBase64, model = MODEL) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    // budget_tokens is removed on this model and returns a 400. Adaptive only.
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: VERDICT_SCHEMA },
    },
    system: [
      {
        type: "text",
        text: SYSTEM_INSTRUCTIONS,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      {
        type: "text",
        text: rubricPrompt(rubric),
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          // Image first: the model reads the page, then the instruction about it.
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaTypeFor(answer.imagePath),
              data: imageBase64,
            },
          },
          {
            type: "text",
            text: `Mark this student's answer to ${rubric.id} against the marking scheme above, out of ${maxMarksOf(rubric)}.`,
          },
        ],
      },
    ],
  };
}

/** The subset of the response worth keeping, plus what spike-score.mjs joins on. */
function toVerdict(answer, rubric, message) {
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`${answer.answerId}: response had no text block`);
  const parsed = JSON.parse(text); // output_config.format guarantees this is valid JSON
  return {
    ...parsed,
    // After the spread, deliberately: identity and denominator come from the
    // rubric on disk, never from the model's echo of them. spike-score refuses a
    // verdict whose maxMarks disagrees with the teacher's, and that check is only
    // worth anything if this side of it is the authoritative value.
    answerId: answer.answerId,
    rubricId: rubric.id,
    maxMarks: maxMarksOf(rubric),
    // Advisory in the schema; bookCode + chapter are authoritative. spike-score
    // only ever groups its report by this, never decides anything with it.
    subject: rubric.subject ?? "unknown",
    bookCode: rubric.bookCode ?? rubric.book ?? rubric.code,
    chapter: rubric.chapter ?? rubric.chapterNo ?? rubric.chapterNumber ?? rubric.ch,
    model: message.model,
    stopReason: message.stop_reason,
    usage: message.usage,
    gradedAt: new Date().toISOString(),
  };
}

/** Visible cache accounting. A silent cache miss is a 10x bill nobody notices. */
function logUsage(label, usage) {
  console.log(
    `  ${label}  in ${usage.input_tokens}  out ${usage.output_tokens}  ` +
      `cache write ${usage.cache_creation_input_tokens ?? 0}  cache read ${usage.cache_read_input_tokens ?? 0}`,
  );
}

// =========================================================================
// Image sizing, for the dry-run cost estimate.
// =========================================================================
// Read straight out of the file header rather than guessed, because the image is
// the largest input term and a wrong guess makes the whole estimate a fiction.

export function imageDimensions(buf, mediaType) {
  if (mediaType === "image/png" && buf.length > 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (mediaType === "image/jpeg") {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc), carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null; // webp/gif: fall back to the caller's assumption
}

/** Tokens ~= pixels / 750, after the API's own downscale to a 1568px long edge. */
export function imageTokens(dim) {
  if (!dim) return 1600; // a phone photo of one A4 answer, after downscale
  const scale = Math.min(1, 1568 / Math.max(dim.width, dim.height));
  return Math.ceil(((dim.width * scale) * (dim.height * scale)) / 750);
}

const estTextTokens = (s) => Math.ceil(s.length / 4);

// =========================================================================
// CLI
// =========================================================================

function parseArgs(argv) {
  const out = { batch: false, "dry-run": false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--batch" || a === "--dry-run" || a === "--show-prompt") out[a.slice(2)] = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else die(`unexpected argument: ${a}`);
  }
  return out;
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    return die(`cannot read ${file}: ${e.message}`);
  }
}

/**
 * Load everything, validate everything, and order the work so the rubric prefix
 * stays cached: answers grouped by question, questions in a stable order.
 */
async function loadRun(args) {
  const answersFile = args.answers ?? path.join(SAMPLE, "answers.json");
  const rubricsFile = args.rubrics ?? RUBRICS;
  const answers = await readJson(answersFile);
  const rubrics = rubricList(await readJson(rubricsFile));

  // Only the rubrics this run will actually use. Validating all 23 would report
  // problems in rubrics nobody is about to spend money on.
  const wanted = new Set(answers.map((a) => a.rubricId));
  const byId = new Map(rubrics.map((r) => [r.id, r]));
  const problems = rubrics.filter((r) => wanted.has(r.id)).flatMap(validateRubric);

  const seen = new Set();
  for (const a of answers) {
    if (!a.answerId) problems.push(`an answer has no answerId`);
    else if (seen.has(a.answerId)) problems.push(`${a.answerId}: duplicate answerId`);
    else seen.add(a.answerId);
    if (!a.rubricId) problems.push(`${a.answerId}: no rubricId`);
    else if (!byId.has(a.rubricId)) {
      problems.push(`${a.answerId}: no rubric with id ${a.rubricId} in ${rubricsFile}`);
    }
    if (!a.imagePath) problems.push(`${a.answerId}: no imagePath`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`  ${p}`);
    die(`\n${problems.length} problem(s) in the run definition; nothing was sent.`);
  }

  const limit = args.limit ? Number(args.limit) : Infinity;
  const ordered = [...answers]
    .sort((x, y) => x.rubricId.localeCompare(y.rubricId) || x.answerId.localeCompare(y.answerId))
    .slice(0, limit);

  const work = [];
  for (const answer of ordered) {
    const rubric = byId.get(answer.rubricId);
    const file = path.isAbsolute(answer.imagePath)
      ? answer.imagePath
      : path.join(path.dirname(answersFile), answer.imagePath);
    let buf;
    try {
      buf = await readFile(file);
    } catch (e) {
      die(`${answer.answerId}: cannot read ${file}: ${e.message}`);
    }
    const mediaType = mediaTypeFor(file);
    work.push({
      answer,
      rubric,
      mediaType,
      bytes: buf.length,
      dimensions: imageDimensions(buf, mediaType),
      // Buffer.toString("base64") never inserts newlines.
      base64: buf.toString("base64"),
      params: buildParams({ ...answer, imagePath: file }, rubric, buf.toString("base64")),
    });
  }
  return work;
}

function dryRun(work, args) {
  const assumedOutput = Number(args["assume-output-tokens"] ?? 2500);
  const batchFactor = args.batch ? 0.5 : 1;

  console.log(`${work.length} answer(s), grouped by question so the rubric prefix stays cached.\n`);

  const systemTokens = estTextTokens(SYSTEM_INSTRUCTIONS);
  let totalCost = 0;
  const seenRubric = new Set();
  const shortPrefixes = new Set();

  for (const w of work) {
    const rubricTokens = estTextTokens(rubricPrompt(w.rubric));
    const img = imageTokens(w.dimensions);
    const volatile = img + estTextTokens(w.params.messages[0].content[1].text);
    const cached = systemTokens + rubricTokens;
    const firstOfGroup = !seenRubric.has(w.rubric.id);
    seenRubric.add(w.rubric.id);
    if (cached < MIN_CACHEABLE_PREFIX) shortPrefixes.add(w.rubric.id);

    // First answer of a question group writes the prefix; the rest read it.
    const prefixCost = firstOfGroup
      ? (cached * PRICE.cacheWrite) / 1e6
      : (cached * PRICE.cacheRead) / 1e6;
    const cost =
      (prefixCost + (volatile * PRICE.input) / 1e6 + (assumedOutput * PRICE.output) / 1e6) *
      batchFactor;
    totalCost += cost;

    const dim = w.dimensions ? `${w.dimensions.width}x${w.dimensions.height}` : "unknown size";
    console.log(
      `  ${w.answer.answerId.padEnd(10)} ${w.rubric.id.padEnd(38)} ` +
        `${dim.padEnd(12)} image ~${img}t  volatile ~${volatile}t  ` +
        `prefix ${cached}t (${firstOfGroup ? "write" : "read "})  ~$${cost.toFixed(4)}`,
    );
  }

  console.log(
    `\nstable system prompt ~${systemTokens} tokens, cached at a 1h breakpoint.` +
      `\nassumed output ~${assumedOutput} tokens/answer (adaptive thinking at effort "high" dominates` +
      `\n  and cannot be known until the first real run: replace this with measured usage.output_tokens).`,
  );

  if (shortPrefixes.size) {
    console.log(
      `\nWARNING  ${shortPrefixes.size} question(s) have a cacheable prefix under ` +
        `${MIN_CACHEABLE_PREFIX} tokens\n  (${[...shortPrefixes].join(", ")}).\n` +
        `  Prefixes that short are silently not cached, and the estimate above is optimistic.\n` +
        `  Watch cache_read_input_tokens on the real run: if it stays 0, this is why.`,
    );
  }
  console.log(
    `\nestimated ~$${totalCost.toFixed(4)} for ${work.length} answer(s)` +
      `${args.batch ? " via the Batches API (half price)" : ""}` +
      `, ~$${((totalCost / work.length) * 20).toFixed(2)} per 20-answer script.`,
  );
  console.log("\nno request was sent; no SDK, network or API key was used.");
}

async function gradeSequential(client, Anthropic, work) {
  // Sequential on purpose. Firing a question group in parallel means every
  // request races the first one's cache write and they all miss the prefix.
  const verdicts = [];
  for (const w of work) {
    try {
      const message = await client.messages.create(w.params);
      logUsage(w.answer.answerId, message.usage);
      verdicts.push(toVerdict(w.answer, w.rubric, message));
    } catch (e) {
      // Most specific first. Never string-match an error message.
      if (e instanceof Anthropic.RateLimitError) {
        console.error(`  ${w.answer.answerId}: rate limited; use --batch for a run this size`);
      } else if (e instanceof Anthropic.APIStatusError) {
        console.error(`  ${w.answer.answerId}: API error ${e.status}: ${e.message}`);
      } else if (e instanceof Anthropic.APIConnectionError) {
        console.error(`  ${w.answer.answerId}: connection failed: ${e.message}`);
      } else {
        throw e;
      }
      // Deliberately no verdict: spike-score.mjs fails the run on a missing
      // verdict rather than quietly measuring the answers that happened to work.
    }
  }
  return verdicts;
}

async function gradeBatch(client, Anthropic, work) {
  const byCustomId = new Map(work.map((w) => [w.answer.answerId, w]));
  let batch;
  try {
    batch = await client.messages.batches.create({
      requests: work.map((w) => ({ custom_id: w.answer.answerId, params: w.params })),
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return die("rate limited creating the batch");
    if (e instanceof Anthropic.APIStatusError) return die(`API error ${e.status}: ${e.message}`);
    if (e instanceof Anthropic.APIConnectionError) return die(`connection failed: ${e.message}`);
    throw e;
  }
  console.log(`batch ${batch.id} created with ${work.length} request(s)`);

  while (batch.processing_status !== "ended") {
    await new Promise((r) => setTimeout(r, 30_000));
    batch = await client.messages.batches.retrieve(batch.id);
    console.log(`  ${batch.processing_status}  ${JSON.stringify(batch.request_counts)}`);
  }

  const verdicts = [];
  // Results come back in an arbitrary order. Key by custom_id, never position:
  // grading answer 7 against answer 3's rubric would produce a plausible number
  // and silently poison the whole measurement.
  for await (const result of await client.messages.batches.results(batch.id)) {
    const w = byCustomId.get(result.custom_id);
    if (!w) {
      console.error(`  unknown custom_id in results: ${result.custom_id}`);
      continue;
    }
    if (result.result.type !== "succeeded") {
      console.error(`  ${result.custom_id}: ${result.result.type}`);
      continue;
    }
    logUsage(result.custom_id, result.result.message.usage);
    verdicts.push(toVerdict(w.answer, w.rubric, result.result.message));
  }
  return verdicts;
}

const args = parseArgs(process.argv.slice(2));
const work = await loadRun(args);

// Print exactly what the model is told, for one answer per rubric. A harness
// whose prompt nobody has read is a harness whose result nobody should believe.
if (args["show-prompt"]) {
  const seen = new Set();
  for (const w of work) {
    if (seen.has(w.rubric.id)) continue;
    seen.add(w.rubric.id);
    const rule = "=".repeat(78);
    console.log(`${rule}\n${w.answer.answerId} -> ${w.rubric.id}\n${rule}`);
    console.log(w.params.system[1].text);
    console.log(`\n[image: ${w.dimensions?.width}x${w.dimensions?.height}]`);
    console.log(`${w.params.messages[0].content[1].text}\n`);
  }
  process.exit(0);
}

if (args["dry-run"]) {
  dryRun(work, args);
  process.exit(0);
}

if (!args.out) die("--out <verdicts.json> is required (or use --dry-run)");

// Imported here rather than at the top so that --dry-run works with no SDK
// installed, no key configured and no network.
let Anthropic;
try {
  ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
} catch {
  die("@anthropic-ai/sdk is not installed. Run: npm i -D @anthropic-ai/sdk\n(--dry-run needs neither it nor a key.)");
}
const client = new Anthropic();

const verdicts = args.batch
  ? await gradeBatch(client, Anthropic, work)
  : await gradeSequential(client, Anthropic, work);

await writeFile(args.out, JSON.stringify(verdicts, null, 2) + "\n");
console.log(`\n${verdicts.length}/${work.length} verdict(s) written to ${args.out}`);
console.log(`next: node scripts/spike-score.mjs --verdicts ${args.out} --truth <teacher marks>`);
process.exit(verdicts.length === work.length ? 0 : 1);
