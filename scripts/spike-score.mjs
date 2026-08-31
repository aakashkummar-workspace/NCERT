/**
 * Spike scorer: model grading verdicts vs. teacher ground truth.
 *
 *   node scripts/spike-score.mjs                       # self-test over the fixtures
 *   node scripts/spike-score.mjs --set borderline      # one fixture set only
 *   node scripts/spike-score.mjs --verdicts out/verdicts.json --truth data/truth.json
 *
 * This is a measurement instrument for the single riskiest assumption in the
 * product: that a vision model can mark a Class 10 handwritten answer as well as
 * a teacher. Everything downstream assumes yes. So the number this prints has to
 * be trustworthy, which is why there is no API and no network anywhere in this
 * file - it is pure arithmetic over two JSON files, checkable offline, in the
 * same way scripts/test-sm2.mjs checks the scheduler.
 *
 * THE GATE
 *   1. within +/-1 mark on >= 80% of 3-mark and 5-mark answers, AND
 *   2. never over-awards by more than 2 marks on any answer, AND
 *   3. every ground-truth answer has exactly one usable verdict.
 *
 * The asymmetry in (2) is deliberate and is never collapsed into a single
 * "accuracy" number anywhere in this report. Over-awarding tells a student they
 * are ready when they are not, and the first teacher who sees it stops trusting
 * the product. Under-awarding merely annoys a student, who appeals. The two are
 * reported as separate directions, always.
 *
 * INPUT SHAPES
 *   truth.json    [{ answerId, questionId, subject, maxMarks, teacherMarks, note? }]
 *   verdicts.json [{ answerId, questionId, maxMarks, marksAwarded, confidence?, ... }]
 * Verdicts may carry the full schema written by scripts/spike-grade.mjs; only the
 * fields above are read here. Ground truth is whatever the teacher wrote.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "spike");

// --- the gate -------------------------------------------------------------

/** Marks are awarded in halves, so compare with a tolerance, never with ===. */
const EPS = 1e-9;
const TOLERANCE = 1; // "within +/-1 mark"
const MIN_WITHIN_RATE = 0.8; // on 3- and 5-mark answers
const MAX_OVER_AWARD = 2; // "never over-awards by MORE than 2"
const GATE_MARK_VALUES = [3, 5];
const CONFIDENCE_SPLIT = 0.8;

/** model marks minus teacher marks. Positive = the model was generous. */
export function markDelta(modelMarks, teacherMarks) {
  return modelMarks - teacherMarks;
}

/** Inside the +/-1 band the gate asks about. */
export function isWithinTolerance(delta) {
  return Math.abs(delta) <= TOLERANCE + EPS;
}

/** The hard ceiling: more than 2 marks handed out that the teacher did not give. */
export function isOverAwardViolation(delta) {
  return delta > MAX_OVER_AWARD + EPS;
}

/** Counted separately from under-awarding, deliberately. */
export function isOverAward(delta) {
  return delta > TOLERANCE + EPS;
}

export function isUnderAward(delta) {
  return delta < -TOLERANCE - EPS;
}

/** A 3- or 5-mark answer: the long-form answers the gate is actually about. */
export function isGateAnswer(maxMarks) {
  return GATE_MARK_VALUES.includes(maxMarks);
}

// --- joining --------------------------------------------------------------

/**
 * Join verdicts onto ground truth by answerId. Anything that does not line up is
 * surfaced, never quietly dropped: a silently ignored answer is exactly how a
 * harness ends up reporting 100% on the eight answers it happened to like.
 */
export function joinRuns(verdicts, truth) {
  const problems = [];
  const rows = [];

  const byId = new Map();
  for (const v of verdicts) {
    if (!v || typeof v.answerId !== "string" || !v.answerId) {
      problems.push(`verdict with no answerId: ${JSON.stringify(v)}`);
      continue;
    }
    if (byId.has(v.answerId)) {
      problems.push(`${v.answerId}: more than one verdict`);
      continue;
    }
    byId.set(v.answerId, v);
  }

  const seenTruth = new Set();
  const missingVerdicts = [];

  for (const t of truth) {
    if (!t || typeof t.answerId !== "string" || !t.answerId) {
      problems.push(`ground truth row with no answerId: ${JSON.stringify(t)}`);
      continue;
    }
    if (seenTruth.has(t.answerId)) {
      problems.push(`${t.answerId}: more than one ground-truth row`);
      continue;
    }
    seenTruth.add(t.answerId);

    if (!Number.isFinite(t.maxMarks) || t.maxMarks <= 0) {
      problems.push(`${t.answerId}: ground truth has no usable maxMarks`);
      continue;
    }
    if (!Number.isFinite(t.teacherMarks) || t.teacherMarks < 0 || t.teacherMarks > t.maxMarks) {
      problems.push(`${t.answerId}: teacherMarks ${t.teacherMarks} outside 0..${t.maxMarks}`);
      continue;
    }

    const v = byId.get(t.answerId);
    if (!v) {
      missingVerdicts.push(t.answerId);
      continue;
    }
    if (Number.isFinite(v.maxMarks) && v.maxMarks !== t.maxMarks) {
      problems.push(
        `${t.answerId}: verdict says out of ${v.maxMarks}, teacher says out of ${t.maxMarks}`,
      );
      continue;
    }
    if (!Number.isFinite(v.marksAwarded) || v.marksAwarded < 0 || v.marksAwarded > t.maxMarks) {
      problems.push(`${t.answerId}: marksAwarded ${v.marksAwarded} outside 0..${t.maxMarks}`);
      continue;
    }

    rows.push({
      answerId: t.answerId,
      questionId: t.questionId ?? v.questionId ?? "",
      subject: t.subject ?? v.subject ?? "unknown",
      maxMarks: t.maxMarks,
      teacherMarks: t.teacherMarks,
      modelMarks: v.marksAwarded,
      delta: markDelta(v.marksAwarded, t.teacherMarks),
      confidence: Number.isFinite(v.confidence) ? v.confidence : null,
      gate: isGateAnswer(t.maxMarks),
    });
  }

  const orphanVerdicts = [...byId.keys()].filter((id) => !seenTruth.has(id));

  return { rows, problems, missingVerdicts, orphanVerdicts, truthCount: seenTruth.size };
}

// --- summarising ----------------------------------------------------------

function rate(hits, n) {
  return n === 0 ? null : hits / n;
}

function band(rows) {
  const n = rows.length;
  const within = rows.filter((r) => isWithinTolerance(r.delta)).length;
  const over = rows.filter((r) => isOverAward(r.delta)).length;
  const under = rows.filter((r) => isUnderAward(r.delta)).length;
  const deltas = rows.map((r) => r.delta);
  return {
    n,
    within,
    withinRate: rate(within, n),
    over,
    overRate: rate(over, n),
    under,
    underRate: rate(under, n),
    meanDelta: n === 0 ? null : deltas.reduce((a, b) => a + b, 0) / n,
    worstOver: n === 0 ? null : Math.max(...deltas),
    worstUnder: n === 0 ? null : Math.min(...deltas),
  };
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

export function summarise(join) {
  const { rows } = join;
  const gateRows = rows.filter((r) => r.gate);

  const histogram = [...groupBy(rows, (r) => Math.round(r.delta * 2) / 2)]
    .map(([delta, rs]) => ({ delta, count: rs.length }))
    .sort((a, b) => a.delta - b.delta);

  const byMarkValue = [...groupBy(rows, (r) => r.maxMarks)]
    .map(([maxMarks, rs]) => ({ maxMarks, gate: isGateAnswer(maxMarks), ...band(rs) }))
    .sort((a, b) => a.maxMarks - b.maxMarks);

  const bySubject = [...groupBy(gateRows, (r) => r.subject)]
    .map(([subject, rs]) => ({ subject, ...band(rs) }))
    .sort((a, b) => a.subject.localeCompare(b.subject));

  const withConfidence = gateRows.filter((r) => r.confidence !== null);
  const confidence = {
    n: withConfidence.length,
    high: band(withConfidence.filter((r) => r.confidence >= CONFIDENCE_SPLIT)),
    low: band(withConfidence.filter((r) => r.confidence < CONFIDENCE_SPLIT)),
  };

  const byDeltaDesc = [...rows].sort(
    (a, b) => b.delta - a.delta || a.answerId.localeCompare(b.answerId),
  );

  return {
    all: band(rows),
    gate: band(gateRows),
    histogram,
    byMarkValue,
    bySubject,
    confidence,
    worstOverAwards: byDeltaDesc.filter((r) => r.delta > 0).slice(0, 5),
    worstUnderAwards: [...byDeltaDesc].reverse().filter((r) => r.delta < 0).slice(0, 5),
    violations: rows.filter((r) => isOverAwardViolation(r.delta)),
  };
}

export function evaluateGate(join, summary) {
  const g = summary.gate;
  const withinOk = g.n > 0 && g.withinRate >= MIN_WITHIN_RATE - EPS;
  const overAwardOk = summary.violations.length === 0;
  const coverageOk =
    join.missingVerdicts.length === 0 &&
    join.orphanVerdicts.length === 0 &&
    join.problems.length === 0;

  const criteria = [
    {
      key: "withinOne",
      pass: withinOk,
      label: `within +/-1 on >=${Math.round(MIN_WITHIN_RATE * 100)}% of 3- and 5-mark answers`,
      detail:
        g.n === 0
          ? "no 3- or 5-mark answers in this run"
          : `${(g.withinRate * 100).toFixed(1)}% (${g.within}/${g.n})`,
    },
    {
      key: "overAward",
      pass: overAwardOk,
      label: `never over-awards by more than ${MAX_OVER_AWARD} marks`,
      detail:
        summary.violations.length === 0
          ? `worst over-award ${signed(summary.all.worstOver ?? 0)}`
          : `${summary.violations.length} answer(s) over ${MAX_OVER_AWARD}: ` +
            summary.violations.map((r) => `${r.answerId} ${signed(r.delta)}`).join(", "),
    },
    {
      key: "coverage",
      pass: coverageOk,
      label: "every ground-truth answer has exactly one usable verdict",
      detail:
        `${join.rows.length}/${join.truthCount} scored` +
        (join.missingVerdicts.length ? `, ${join.missingVerdicts.length} missing verdict(s)` : "") +
        (join.orphanVerdicts.length ? `, ${join.orphanVerdicts.length} orphan verdict(s)` : "") +
        (join.problems.length ? `, ${join.problems.length} problem(s)` : ""),
    },
  ];

  return { pass: criteria.every((c) => c.pass), criteria };
}

// --- reporting ------------------------------------------------------------

function signed(x) {
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
}

function pct(x) {
  return x === null ? "   n/a" : `${(x * 100).toFixed(1).padStart(5)}%`;
}

function pad(s, n) {
  return String(s).padEnd(n);
}

export function formatReport(join, summary, gate, title) {
  const L = [];
  const rule = "=".repeat(78);
  L.push(rule);
  if (title) L.push(`  ${title}`);
  L.push(rule);

  for (const p of join.problems) L.push(`  INPUT PROBLEM    ${p}`);
  for (const id of join.missingVerdicts) L.push(`  NO VERDICT       ${id}`);
  for (const id of join.orphanVerdicts) L.push(`  NO GROUND TRUTH  ${id}`);
  if (join.problems.length || join.missingVerdicts.length || join.orphanVerdicts.length) L.push("");

  L.push(
    `scored ${join.rows.length} answers, of which ${summary.gate.n} are 3- or 5-mark (the gate answers)`,
  );
  L.push("");

  L.push("delta distribution  (model marks - teacher marks)");
  const widest = Math.max(1, ...summary.histogram.map((h) => h.count));
  for (const h of summary.histogram) {
    const bar = "#".repeat(Math.max(1, Math.round((h.count / widest) * 24)));
    L.push(`  ${signed(h.delta).padStart(5)}  ${pad(bar, 25)} ${String(h.count).padStart(3)}`);
  }
  L.push("");

  L.push("within +/-1, by question mark value");
  for (const m of summary.byMarkValue) {
    L.push(
      `  ${String(m.maxMarks).padStart(2)}-mark  n=${String(m.n).padStart(3)}  ` +
        `within ${pct(m.withinRate)}${m.gate ? "   <- counts towards the gate" : ""}`,
    );
  }
  L.push("");

  L.push("failure directions on gate answers  (never collapsed into one number)");
  L.push(
    `  over-awarded  by more than 1 mark:  ${String(summary.gate.over).padStart(3)}/${summary.gate.n}  ` +
      `${pct(summary.gate.overRate)}   destroys teacher trust`,
  );
  L.push(
    `  under-awarded by more than 1 mark:  ${String(summary.gate.under).padStart(3)}/${summary.gate.n}  ` +
      `${pct(summary.gate.underRate)}   annoys a student`,
  );
  if (summary.gate.n > 0) {
    const bias = summary.gate.meanDelta;
    const lean = bias > 0.05 ? "runs generous" : bias < -0.05 ? "runs harsh" : "no systematic lean";
    L.push(`  mean signed delta: ${signed(bias)} marks  (${lean})`);
  }
  L.push("");

  const line = (r) =>
    `  ${pad(r.answerId, 10)} ${pad(r.subject, 9)} ${pad(r.questionId, 12)} ` +
    `teacher ${r.teacherMarks.toFixed(1)}  model ${r.modelMarks.toFixed(1)}  ` +
    `delta ${signed(r.delta).padStart(5)}  conf ${r.confidence === null ? " n/a" : r.confidence.toFixed(2)}`;

  L.push("worst over-awards");
  if (summary.worstOverAwards.length === 0) L.push("  (none)");
  for (const r of summary.worstOverAwards) {
    L.push(line(r) + (isOverAwardViolation(r.delta) ? "   <- GATE VIOLATION" : ""));
  }
  L.push("");

  L.push("worst under-awards");
  if (summary.worstUnderAwards.length === 0) L.push("  (none)");
  for (const r of summary.worstUnderAwards) L.push(line(r));
  L.push("");

  L.push("per subject, gate answers only  (Maths and Science fail differently)");
  L.push(
    `  ${pad("subject", 12)}${pad("n", 5)}${pad("within+/-1", 12)}${pad("mean delta", 12)}` +
      `${pad("worst over", 12)}worst under`,
  );
  for (const s of summary.bySubject) {
    L.push(
      `  ${pad(s.subject, 12)}${pad(s.n, 5)}${pad(pct(s.withinRate).trim(), 12)}` +
        `${pad(signed(s.meanDelta), 12)}${pad(signed(s.worstOver), 12)}${signed(s.worstUnder)}`,
    );
  }
  L.push("");

  if (summary.confidence.n > 0) {
    L.push(
      `self-reported confidence, split at ${CONFIDENCE_SPLIT}  (decides what a human must re-check)`,
    );
    L.push(
      `  conf >= ${CONFIDENCE_SPLIT}:  n=${String(summary.confidence.high.n).padStart(3)}  within ${pct(summary.confidence.high.withinRate)}`,
    );
    L.push(
      `  conf <  ${CONFIDENCE_SPLIT}:  n=${String(summary.confidence.low.n).padStart(3)}  within ${pct(summary.confidence.low.withinRate)}`,
    );
    L.push("");
  }

  L.push("GATE");
  for (const c of gate.criteria) {
    L.push(`  [${c.pass ? "PASS" : "FAIL"}]  ${pad(c.label, 54)} ${c.detail}`);
  }
  L.push(`  ==> ${gate.pass ? "PASS" : "FAIL"}`);
  return L.join("\n");
}

export function scoreRun(verdicts, truth, title) {
  const join = joinRuns(verdicts, truth);
  const summary = summarise(join);
  const gate = evaluateGate(join, summary);
  return { join, summary, gate, report: formatReport(join, summary, gate, title) };
}

// --- CLI ------------------------------------------------------------------

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`);
    process.exit(1);
  }
}

function parseArgs(argv) {
  const out = { quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quiet") out.quiet = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else {
      console.error(`unexpected argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function checker() {
  const state = { failed: 0 };
  state.check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) state.failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (got ${actual}, expected ${expected})`);
  };
  return state;
}

/**
 * Boundary checks on the gate arithmetic itself. The fixtures prove the report
 * assembles; these prove the comparisons land on the right side of the line,
 * which is where a scorer is most likely to be quietly, invisibly wrong.
 */
function unitChecks() {
  const { check, ...state } = checker();

  check("exactly +1 is within tolerance", isWithinTolerance(1), true);
  check("exactly -1 is within tolerance", isWithinTolerance(-1), true);
  check("+1.5 is outside tolerance", isWithinTolerance(1.5), false);
  check("half marks survive float subtraction", isWithinTolerance(markDelta(2.5, 1.5)), true);
  check("exactly +2 is not a violation", isOverAwardViolation(2), false);
  check("+2.5 is a violation", isOverAwardViolation(2.5), true);
  check("-3 is never an over-award violation", isOverAwardViolation(-3), false);
  check("+2 still counts as an over-award", isOverAward(2), true);
  check("+2 is not an under-award", isUnderAward(2), false);
  check("-2 counts as an under-award", isUnderAward(-2), true);
  check("3-mark answers are gate answers", isGateAnswer(3), true);
  check("5-mark answers are gate answers", isGateAnswer(5), true);
  check("1-mark MCQs are not", isGateAnswer(1), false);
  check("2-mark answers are not", isGateAnswer(2), false);

  // 4/5 is exactly the 80% line and must pass; 3/4 is 75% and must not.
  const at80 = scoreRun(
    [0, 1, 2, 3, 4].map((i) => ({ answerId: `a${i}`, maxMarks: 3, marksAwarded: i === 4 ? 3 : 1 })),
    [0, 1, 2, 3, 4].map((i) => ({
      answerId: `a${i}`,
      subject: "Maths",
      maxMarks: 3,
      teacherMarks: 1,
    })),
  );
  check("exactly 80% within +/-1 passes criterion 1", at80.gate.criteria[0].pass, true);
  const at75 = scoreRun(
    [0, 1, 2, 3].map((i) => ({ answerId: `a${i}`, maxMarks: 3, marksAwarded: i === 3 ? 3 : 1 })),
    [0, 1, 2, 3].map((i) => ({ answerId: `a${i}`, subject: "Maths", maxMarks: 3, teacherMarks: 1 })),
  );
  check("75% within +/-1 fails criterion 1", at75.gate.criteria[0].pass, false);

  // 1- and 2-mark answers must not be able to rescue or sink the gate.
  const noise = scoreRun(
    [{ answerId: "m1", maxMarks: 1, marksAwarded: 1 }],
    [{ answerId: "m1", subject: "Science", maxMarks: 1, teacherMarks: 0 }],
  );
  check("a 1-mark answer contributes nothing to the gate n", noise.summary.gate.n, 0);

  // A missing verdict must sink the run, not silently shrink the denominator.
  const gap = scoreRun(
    [{ answerId: "a1", maxMarks: 5, marksAwarded: 4 }],
    [
      { answerId: "a1", subject: "Science", maxMarks: 5, teacherMarks: 4 },
      { answerId: "a2", subject: "Science", maxMarks: 5, teacherMarks: 2 },
    ],
  );
  check("a missing verdict fails the coverage criterion", gap.gate.criteria[2].pass, false);
  check("a missing verdict fails the run overall", gap.gate.pass, false);
  check("a missing verdict does not inflate the within-rate n", gap.summary.gate.n, 1);

  // Marks outside the paper's range are input corruption, not a grading result.
  const bad = scoreRun(
    [{ answerId: "a1", maxMarks: 5, marksAwarded: 9 }],
    [{ answerId: "a1", subject: "Maths", maxMarks: 5, teacherMarks: 4 }],
  );
  check("marks above maxMarks are rejected as input", bad.join.problems.length, 1);

  return state.failed;
}

async function selfTest(only, quiet) {
  const { check, ...state } = checker();

  // A scoring set is a directory with an expect.json. Anything else under
  // fixtures/spike (sample-run, say) belongs to spike-grade.mjs, not here.
  const dirs = (await readdir(FIXTURES, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => !only || n === only)
    .sort();
  const sets = [];
  for (const n of dirs) {
    if (existsSync(path.join(FIXTURES, n, "expect.json"))) sets.push(n);
  }

  if (sets.length === 0) {
    console.error(only ? `no fixture set named ${only}` : `no fixture sets under ${FIXTURES}`);
    process.exit(1);
  }

  for (const name of sets) {
    const dir = path.join(FIXTURES, name);
    const verdicts = await readJson(path.join(dir, "verdicts.json"));
    const truth = await readJson(path.join(dir, "truth.json"));
    const expect = await readJson(path.join(dir, "expect.json"));

    const { join, summary, gate, report } = scoreRun(
      verdicts,
      truth,
      `fixture: ${name}  -  ${expect.note}`,
    );
    if (!quiet) console.log(`\n${report}\n`);

    const round4 = (x) => (x === null ? null : Number(x.toFixed(4)));
    check(`${name}: gate verdict`, gate.pass, expect.pass);
    check(`${name}: gate answers counted`, summary.gate.n, expect.gateN);
    check(
      `${name}: within +/-1 rate on gate answers`,
      round4(summary.gate.withinRate),
      expect.gateWithinRate,
    );
    check(`${name}: worst over-award`, round4(summary.all.worstOver), expect.worstOverAward);
    check(`${name}: worst under-award`, round4(summary.all.worstUnder), expect.worstUnderAward);
    check(`${name}: over-awards on gate answers`, summary.gate.over, expect.gateOver);
    check(`${name}: under-awards on gate answers`, summary.gate.under, expect.gateUnder);
    for (const c of gate.criteria) {
      check(`${name}: criterion ${c.key}`, c.pass, expect.criteria[c.key]);
    }
    if (expect.problems !== undefined) {
      check(`${name}: input problems`, join.problems.length, expect.problems);
    }
    if (expect.missingVerdicts !== undefined) {
      check(`${name}: missing verdicts`, join.missingVerdicts.length, expect.missingVerdicts);
    }
  }
  return state.failed;
}

const args = parseArgs(process.argv.slice(2));

if (args.verdicts || args.truth) {
  if (!args.verdicts || !args.truth) {
    console.error("both --verdicts and --truth are required when scoring a real run");
    process.exit(1);
  }
  const real = scoreRun(
    await readJson(args.verdicts),
    await readJson(args.truth),
    `${args.verdicts}  vs  ${args.truth}`,
  );
  console.log(real.report);
  process.exit(real.gate.pass ? 0 : 1);
}

// No files given: run the offline self-test. NOTE - a fixture set whose gate
// says FAIL is not a broken harness. The fixtures deliberately include runs the
// gate must reject; "green" here means every set behaved exactly as its
// expect.json says it should.
const failures = unitChecks() + (await selfTest(args.set, args.quiet));
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
