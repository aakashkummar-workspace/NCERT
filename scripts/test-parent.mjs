/**
 * Tests for the parent dashboard, the disclosure boundary, and the CSV export.
 *
 *   node scripts/test-parent.mjs                       # unit tests only
 *   node scripts/test-parent.mjs http://localhost:3324 # + live API checks
 *
 * ## Why this imports the real modules
 *
 * scripts/test-sm2.mjs and scripts/test-bridge.mjs re-implement the logic they
 * test, because the modules they cover are `"use client"` and pull in Dexie.
 * That trick is not good enough here. "A forbidden field is never selected" is
 * only true if it is true of *the object the application ships*, and a test
 * that re-implements the select proves nothing about the one Prisma is handed.
 *
 * So `src/lib/export.ts` (the policy) and `src/lib/insights.ts` (the
 * recommendations) are written with **no runtime imports** — only `import type`
 * — precisely so this file can import them for real through Node's type
 * stripping. The script re-execs itself with the flag if it needs to.
 *
 * `src/lib/parent.ts` cannot be imported that way: it needs Prisma. Its selects
 * are therefore lifted out of the source text and run through the *real*
 * `assertDisclosable` from `src/lib/export.ts` — so the thing under test is
 * still the literal that ships, checked by the guard that ships.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Node 22 needs the flag to import a .ts file. Re-exec once, rather than
// putting a flag in package.json that whoever runs this has to remember.
if (!process.features.typescript) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

const {
  assertDisclosable,
  assertFilterSafe,
  DisclosureError,
  FORBIDDEN_FIELDS,
  FORBIDDEN_RELATIONS,
  escapeCsvCell,
  toCsv,
  ATTEMPT_COLUMNS,
  CHAPTER_COLUMNS,
} = await import("../src/lib/export.ts");

const { recommend, assertHouseholdSafe, SCOLDING_PATTERNS, UnkindTextError } = await import(
  "../src/lib/insights.ts"
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let failed = 0;
let passed = 0;

function ok(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`);
  }
}

function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function throws(name, fn, ErrorType) {
  try {
    fn();
    ok(name, false, "did not throw");
  } catch (err) {
    ok(name, err instanceof ErrorType, `threw ${err?.name}: ${err?.message?.split("\n")[0]}`);
  }
}

function doesNotThrow(name, fn) {
  try {
    fn();
    ok(name, true);
  } catch (err) {
    ok(name, false, `threw ${err?.name}: ${err?.message?.split("\n")[0]}`);
  }
}

function section(title) {
  console.log(`\n— ${title} —`);
}

// ---------------------------------------------------------------------------
// 1. The guard itself
// ---------------------------------------------------------------------------

section("the disclosure guard");

doesNotThrow("a select of effort and trend passes", () =>
  assertDisclosable({ subject: true, durationMs: true, totalScore: true }, "t"),
);

throws(
  "a select naming `transcript` is rejected",
  () => assertDisclosable({ questionNumber: true, transcript: true }, "t"),
  DisclosureError,
);

throws(
  "a *nested* `transcript` is rejected",
  () => assertDisclosable({ answer: { select: { submission: { select: { transcript: true } } } } }, "t"),
  DisclosureError,
);

throws(
  "the evaluator's `comment` is rejected",
  () => assertDisclosable({ awardedMarks: true, comment: true }, "t"),
  DisclosureError,
);

throws(
  "`include` is rejected — it fetches every scalar",
  () => assertDisclosable({ awardedMarks: true, include: { rubric: true } }, "t"),
  DisclosureError,
);

throws(
  "a relation with no `select` is rejected",
  () => assertDisclosable({ rubric: { where: { chapter: 1 } } }, "t"),
  DisclosureError,
);

throws(
  "a wholly-private relation is rejected however narrow the select",
  () => assertDisclosable({ voiceNotes: { select: { durationMs: true } } }, "t"),
  DisclosureError,
);

// Every forbidden name must actually be caught: a typo in the list is a silent
// hole, and the list is the entire policy.
{
  const uncaught = FORBIDDEN_FIELDS.filter((field) => {
    try {
      assertDisclosable({ [field]: true }, "t");
      return true;
    } catch {
      return false;
    }
  });
  ok(`all ${FORBIDDEN_FIELDS.length} forbidden fields are caught`, uncaught.length === 0, uncaught.join(", "));

  const uncaughtRelations = FORBIDDEN_RELATIONS.filter((rel) => {
    try {
      assertDisclosable({ [rel]: { select: { id: true } } }, "t");
      return true;
    } catch {
      return false;
    }
  });
  ok(
    `all ${FORBIDDEN_RELATIONS.length} forbidden relations are caught`,
    uncaughtRelations.length === 0,
    uncaughtRelations.join(", "),
  );
}

section("the where-clause guard");

doesNotThrow("a filter may navigate a foreign key it may not select", () =>
  assertFilterSafe({ supersededBy: null, answer: { submission: { studentId: "u" } } }, "t"),
);

throws(
  "a filter on `transcript` is rejected — it is an oracle over the contents",
  () => assertFilterSafe({ answer: { transcript: { contains: "photosynthesis" } } }, "t"),
  DisclosureError,
);

{
  const uncaught = FORBIDDEN_FIELDS.filter((field) => {
    try {
      assertFilterSafe({ answer: { [field]: { contains: "x" } } }, "t");
      return true;
    } catch {
      return false;
    }
  });
  ok(
    `all ${FORBIDDEN_FIELDS.length} forbidden fields are caught in a filter too`,
    uncaught.length === 0,
    uncaught.join(", "),
  );
}

// ---------------------------------------------------------------------------
// 2. The selects the application actually ships
//
// This is the test the brief asks for: it fails if a forbidden field is ever
// *selected*, not merely if one is rendered. The literals are lifted out of the
// source and handed to the real guard.
// ---------------------------------------------------------------------------

section("the shipped selects");

const parentSrc = await readFile("src/lib/parent.ts", "utf8");
const exportSrc = await readFile("src/lib/export.ts", "utf8");

/** Every `disclosable( <literal> satisfies T, "NAME" )` call, as real objects. */
function shippedSelects(src, file) {
  const found = [];
  const needle = "disclosable(";
  let idx = src.indexOf(needle);
  while (idx !== -1) {
    // Only an assignment counts: `export const X_SELECT = disclosable(`. Skips
    // the function's own declaration and every mention of it in a doc comment.
    const before = src.slice(Math.max(0, idx - 40), idx);
    if (!/=\s*$/.test(before)) {
      idx = src.indexOf(needle, idx + needle.length);
      continue;
    }
    const start = idx + needle.length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "(" || ch === "{") depth++;
      else if (ch === ")" || ch === "}") depth--;
      i++;
    }
    const arg = src.slice(start, i - 1);
    const satisfiesAt = arg.indexOf("satisfies");
    const literal = (satisfiesAt === -1 ? arg : arg.slice(0, satisfiesAt))
      .replace(/\/\/[^\n]*/g, "")
      .trim()
      .replace(/,\s*$/, "");
    const name = (arg.match(/"([A-Z0-9_]+)"\s*,?\s*$/) ?? [])[1] ?? `${file}:${idx}`;
    found.push({ name, literal });
    idx = src.indexOf(needle, i);
  }
  return found;
}

const selects = [...shippedSelects(parentSrc, "parent.ts"), ...shippedSelects(exportSrc, "export.ts")];

ok(`found the shipped selects (${selects.map((s) => s.name).join(", ")})`, selects.length >= 5, `found ${selects.length}`);

for (const { name, literal } of selects) {
  let value;
  try {
    value = new Function(`return (${literal});`)();
  } catch (err) {
    ok(`${name} could be parsed out of the source`, false, err.message);
    continue;
  }
  doesNotThrow(`${name} discloses nothing forbidden`, () => assertDisclosable(value, name));
}

// A select that is not wrapped in `disclosable()` is not guarded at all, so the
// guard has to be the *only* way a select gets into a Prisma call in this file.
{
  // `select: typeof X` appears in the `Prisma.…GetPayload` type aliases; those
  // are types, not queries, and are exactly the guarded constants anyway.
  const named = [...parentSrc.matchAll(/select:\s*(?:typeof\s+)?([A-Za-z_][\w]*)/g)].map((m) => m[1]);
  const unguarded = named.filter((n) => !/^[A-Z][A-Z0-9_]*SELECT$/.test(n));
  ok(
    "every `select:` in src/lib/parent.ts names a guarded constant",
    unguarded.length === 0,
    unguarded.join(", "),
  );
  ok("…and there are several of them", named.length >= 5, `found ${named.length}`);
}

// The guard on the other half of a query. A `where` may navigate a private
// relation by foreign key — that is the only route from a grade to its student
// — so it has its own, narrower check, and every filter this module builds must
// go through it or the oracle it exists to stop is wide open.
{
  const filters = [...parentSrc.matchAll(/const where = ([\s\S]*?)\s*satisfies Prisma\.\w+;/g)].map(
    (m) => m[1],
  );
  ok("found the shipped where clauses", filters.length >= 2, `found ${filters.length}`);
  for (const [i, literal] of filters.entries()) {
    let value;
    try {
      // The literals interpolate runtime values; only the *shape* is under
      // test, so stub the two identifiers they can reach.
      value = new Function("link", "scopeId", `return (${literal.replace(/\/\/[^\n]*/g, "")});`)(
        { studentUserId: "student", studentScopeId: "scope", parentUserId: "parent" },
        "scope",
      );
    } catch (err) {
      ok(`where clause #${i + 1} could be parsed out of the source`, false, err.message);
      continue;
    }
    doesNotThrow(`where clause #${i + 1} filters on nothing private`, () =>
      assertFilterSafe(value, `where#${i + 1}`),
    );
  }
  const guarded = (parentSrc.match(/assertFilterSafe\(where,/g) ?? []).length;
  ok(
    "every shipped where clause is passed through assertFilterSafe",
    guarded === filters.length,
    `${guarded} guarded, ${filters.length} declared`,
  );
}

// The compile-time half of the boundary: no query may be reachable without a
// ConsentedLink, which only `requireConsentedLink` can mint.
{
  const queryFns = [...parentSrc.matchAll(/export async function (\w+)\(([^)]*)\)/g)].map((m) => ({
    name: m[1],
    args: m[2].replace(/\s+/g, " ").trim(),
  }));
  const readsStudentData = ["childOf", "attemptsFor", "gradesFor", "pendingHumanReviewFor", "householdSnapshot"];
  for (const fn of readsStudentData) {
    const found = queryFns.find((q) => q.name === fn);
    ok(
      `${fn}() takes a ConsentedLink, not a student id`,
      Boolean(found) && found.args.startsWith("link: ConsentedLink"),
      found ? found.args : "not found",
    );
  }
  ok(
    "ConsentedLink is branded, so nothing else can construct one",
    /declare const consented: unique symbol/.test(parentSrc) &&
      /readonly \[consented\]: true/.test(parentSrc),
  );
  ok(
    "requireConsentedLink re-reads the ledger — no cache to outlive a revocation",
    /export async function requireConsentedLink/.test(parentSrc) &&
      !/const\s+\w*[Cc]ache\w*\s*=/.test(parentSrc),
  );
}

// ---------------------------------------------------------------------------
// 3. Recommendations
// ---------------------------------------------------------------------------

section("recommendations");

const NOW = Date.UTC(2026, 2, 16, 9, 0, 0); // a Monday morning

function snapshot(overrides = {}) {
  return {
    studentName: "Ananya",
    classNum: 10,
    now: NOW,
    weeks: [],
    subjects: [],
    chapters: [],
    pendingHumanReview: 0,
    lastActiveMs: NOW - 2 * 86400000,
    lateNightSessions: 0,
    ...overrides,
  };
}

function chapter(over = {}) {
  return {
    bookCode: "jesc1",
    chapter: 10,
    subject: "Science",
    label: "Light — Reflection and Refraction",
    revisits: 4,
    fraction: 0.42,
    answersGraded: 6,
    lastSeenMs: NOW - 86400000,
    ...over,
  };
}

// Deterministic: the same snapshot twice is the same array, byte for byte.
{
  const a = JSON.stringify(recommend(snapshot({ chapters: [chapter()] })));
  const b = JSON.stringify(recommend(snapshot({ chapters: [chapter()] })));
  ok("the same snapshot produces byte-identical output", a === b);
}

// Order is by priority, never by which rule happened to run first.
{
  const recs = recommend(
    snapshot({
      chapters: [chapter()],
      lateNightSessions: 4,
      lastActiveMs: NOW - 20 * 86400000,
      pendingHumanReview: 2,
    }),
  );
  const kinds = recs.map((r) => r.kind);
  eq("wellbeing outranks study advice", kinds[0], "RETURN_GENTLY");
  ok("rest comes before the chapter suggestion", kinds.indexOf("REST") < kinds.indexOf("TEACH_BACK"), kinds.join(" > "));
  ok("'nothing to do yet' comes last", kinds[kinds.length - 1] === "WAIT", kinds.join(" > "));
}

// Teach-back names the chapter that is both re-read and not landing.
{
  const recs = recommend(
    snapshot({
      chapters: [
        chapter({ chapter: 10, revisits: 5, fraction: 0.4, label: "Light — Reflection and Refraction" }),
        chapter({ chapter: 2, revisits: 2, fraction: 0.3, label: "Acids, Bases and Salts" }),
        chapter({ chapter: 6, revisits: 9, fraction: 0.95, label: "Life Processes" }),
      ],
    }),
  );
  const teach = recs.find((r) => r.kind === "TEACH_BACK");
  ok("teach-back picks the most re-read chapter that is not landing", teach?.id === "teach-back:jesc1:10", teach?.id);
  ok("…and names it in the action", teach?.action.includes("Light — Reflection and Refraction"), teach?.action);
  ok("…and it is an instruction, not a score", /Ask Ananya to teach you/.test(teach?.action ?? ""));
}

// The rule the PRD's problem statement exists for.
{
  const recs = recommend(
    snapshot({
      weeks: [{ weekStartMs: NOW - 7 * 86400000, sessions: 4, minutes: 160, papers: 3 }],
      subjects: [{ subject: "Science", recent: 0.55, earlier: 0.56, papers: 4 }],
    }),
  );
  const effort = recs.find((r) => r.kind === "NOTICE_EFFORT");
  ok("hours in with the marks flat produces a 'notice the effort' action", Boolean(effort), recs.map((r) => r.kind).join(","));
  ok("…and it names the hours, not the score", /2h 40m/.test(effort?.because ?? ""), effort?.because);
}

// A student with nothing recorded is not a problem to be solved.
{
  const recs = recommend(snapshot({ lastActiveMs: null }));
  eq("an empty snapshot yields exactly one recommendation", recs.length, 1);
  eq("…and it asks for nothing", recs[0].kind, "NOTHING_NEEDED");
}

// Never scolds, never restates a mark — over a wide sweep of snapshots.
{
  const sweeps = [];
  for (const revisits of [0, 1, 3, 7]) {
    for (const fraction of [null, 0.15, 0.45, 0.62, 0.88]) {
      for (const late of [0, 3, 6]) {
        for (const quiet of [1, 11, 40]) {
          for (const minutes of [0, 45, 160, 700]) {
            sweeps.push(
              snapshot({
                chapters: [chapter({ revisits, fraction })],
                lateNightSessions: late,
                lastActiveMs: NOW - quiet * 86400000,
                weeks: [{ weekStartMs: NOW - 7 * 86400000, sessions: 5, minutes, papers: 2 }],
                subjects: [
                  { subject: "Science", recent: fraction, earlier: 0.5, papers: 4 },
                  { subject: "Mathematics", recent: 0.9, earlier: 0.4, papers: 3 },
                ],
                pendingHumanReview: late,
              }),
            );
          }
        }
      }
    }
  }
  let offences = null;
  let total = 0;
  for (const s of sweeps) {
    try {
      total += recommend(s).length;
    } catch (err) {
      offences = err;
      break;
    }
  }
  ok(`${sweeps.length} snapshots, ${total} recommendations, none scolds`, offences === null, offences?.message?.split("\n")[1]);
}

// The guard has to actually bite, or the sweep above proves nothing.
throws(
  "assertHouseholdSafe rejects a scolding string",
  () =>
    assertHouseholdSafe([
      { id: "x", kind: "REST", action: "She needs to try harder in Science.", because: "b", minutes: 1, priority: 1 },
    ]),
  UnkindTextError,
);
throws(
  "assertHouseholdSafe rejects a bare percentage",
  () =>
    assertHouseholdSafe([
      { id: "x", kind: "REST", action: "Science is at 62%.", because: "b", minutes: 1, priority: 1 },
    ]),
  UnkindTextError,
);
throws(
  "assertHouseholdSafe rejects marks out of marks",
  () =>
    assertHouseholdSafe([
      { id: "x", kind: "REST", action: "a", because: "She scored 12 out of 20.", minutes: 1, priority: 1 },
    ]),
  UnkindTextError,
);

// A chapter title is interpolated into a recommendation, so a title that trips
// the blocklist would be a 500 on a parent's dashboard rather than a test
// failure. Check all 149 of them here instead.
{
  const manifest = JSON.parse(await readFile("data/manifest.json", "utf8"));
  const titles = manifest.books.flatMap((b) => b.chapters.map((c) => c.title));
  const tripping = titles.filter((t) => SCOLDING_PATTERNS.some((p) => p.test(t)));
  ok(`all ${titles.length} NCERT chapter titles pass the blocklist`, tripping.length === 0, tripping.join(", "));
}

// ---------------------------------------------------------------------------
// 4. CSV
// ---------------------------------------------------------------------------

section("csv");

eq("a plain cell is unquoted", escapeCsvCell("Aarti Sharma"), "Aarti Sharma");
eq("a comma forces quotes", escapeCsvCell("Rao, Sandeep"), '"Rao, Sandeep"');
eq("an inner quote is doubled", escapeCsvCell('the "hard" one'), '"the ""hard"" one"');
eq("a newline forces quotes", escapeCsvCell("line1\nline2"), '"line1\nline2"');
eq("a CR forces quotes", escapeCsvCell("a\rb"), '"a\rb"');
eq("null is an empty cell, not the word null", escapeCsvCell(null), "");
eq("undefined is an empty cell", escapeCsvCell(undefined), "");
eq("zero survives as zero", escapeCsvCell(0), "0");
eq("a leading = is defused", escapeCsvCell("=1+1"), "'=1+1");
eq("a leading + is defused", escapeCsvCell("+91981"), "'+91981");
eq("a leading - is defused", escapeCsvCell("-5"), "'-5");
eq("a leading @ is defused", escapeCsvCell("@SUM(A1)"), "'@SUM(A1)");
eq("a defused cell that also needs quoting gets both", escapeCsvCell("=a,b"), `"'=a,b"`);

{
  const rows = [
    {
      studentId: "u1",
      studentName: 'Menon, "Ananya"',
      classNum: 10,
      subject: "Science",
      paperSlug: null,
      startedAt: new Date("2026-03-09T04:30:00.000Z"),
      submittedAt: null,
      durationMs: 5_400_000,
      status: "IN_PROGRESS",
      maxMarks: 80,
      totalScore: null,
      questionsTotal: 39,
      questionsAttempted: 31,
    },
  ];
  const csv = toCsv(rows, ATTEMPT_COLUMNS);
  ok("the document opens with a UTF-8 BOM", csv.startsWith("﻿"));
  ok("lines are CRLF-terminated", csv.includes("\r\n") && csv.endsWith("\r\n"));

  const [header, body] = csv.slice(1).split("\r\n");
  eq(
    "the header is the documented column map",
    header,
    ATTEMPT_COLUMNS.map((c) => c.header).join(","),
  );
  const cells = body.split(",");
  ok("a name with a comma and quotes round-trips", body.includes('"Menon, ""Ananya"""'), body);
  ok("an unscored attempt exports blank, never zero", /,,/.test(body.slice(body.indexOf("80,"))), body);
  ok("duration is exported in minutes", cells.includes("90"), body);
  ok("every column is present on the row", body.split(",").length >= ATTEMPT_COLUMNS.length, body);
}

{
  const csv = toCsv(
    [
      {
        studentId: "u1",
        studentName: "Kabir",
        classNum: 9,
        subject: "Science",
        bookCode: "iesc1",
        chapter: 3,
        chapterTitle: "Atoms and Molecules",
        answersGraded: 4,
        marksAwarded: 9,
        marksPossible: 20,
        lastGradedAt: new Date("2026-03-10T10:00:00.000Z"),
      },
    ],
    CHAPTER_COLUMNS,
  );
  const [header, body] = csv.slice(1).split("\r\n");
  eq("chapter header is the documented map", header, CHAPTER_COLUMNS.map((c) => c.header).join(","));
  ok("chapter score is a one-decimal percentage", body.includes("45.0"), body);
}

// The export must not be able to carry a field the dashboard would not show.
{
  const columnNames = [...ATTEMPT_COLUMNS, ...CHAPTER_COLUMNS].map((c) => c.header);
  const leaks = columnNames.filter((h) =>
    ["transcript", "ocr", "storage", "comment", "note", "phone", "email", "sha256", "label"].some((bad) =>
      h.includes(bad),
    ),
  );
  ok("no export column is a field a parent could not see", leaks.length === 0, leaks.join(", "));
}

// ---------------------------------------------------------------------------
// 5. Live API — consent, revocation, and the response body
// ---------------------------------------------------------------------------

const BASE = process.argv[2];

const SCHOOL_SCOPE = "11111111-1111-1111-1111-111111111111";
const ADMIN_PHONE = "+919810000031";
const PARENT_PHONE = "+919810000011";
const HOUSEHOLD_PHONE = "+919810000010";

/** Deep scan of a JSON response for any key the policy forbids. */
function forbiddenKeysIn(value, path = "") {
  const hits = [];
  if (value === null || typeof value !== "object") return hits;
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...forbiddenKeysIn(v, `${path}[${i}]`)));
    return hits;
  }
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    if (FORBIDDEN_FIELDS.includes(k) || FORBIDDEN_RELATIONS.includes(k)) hits.push(p);
    hits.push(...forbiddenKeysIn(v, p));
  }
  return hits;
}

class Client {
  constructor(base) {
    this.base = base.replace(/\/$/, "");
    this.cookie = "";
  }
  async call(path, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (init.body) headers["content-type"] = "application/json";
    const res = await fetch(`${this.base}${path}`, { ...init, headers, redirect: "manual" });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(";")[0];
      if (pair.startsWith("ncert_session=")) this.cookie = pair;
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* CSV, or an empty body */
    }
    return { status: res.status, json, text, headers: res.headers };
  }
  login(phone, scopeId) {
    return this.call("/api/dev/login/", {
      method: "POST",
      body: JSON.stringify(scopeId ? { phone, scopeId } : { phone }),
    });
  }
}

if (!BASE) {
  console.log("\n(skipping live API checks — pass a base URL, e.g. http://localhost:3324)");
} else {
  section(`live API — ${BASE}`);

  const admin = new Client(BASE);
  const parent = new Client(BASE);
  const kabir = new Client(BASE);

  const adminLogin = await admin.login(ADMIN_PHONE, SCHOOL_SCOPE);
  eq("admin signs in", adminLogin.status, 200);

  const provisioned = await admin.call("/api/parent/accounts/", {
    method: "POST",
    headers: { "idempotency-key": "test-parent-account" },
    body: JSON.stringify({ phone: PARENT_PHONE, displayName: "Latha Menon" }),
  });
  ok("admin provisions a PARENT account", provisioned.status === 200, JSON.stringify(provisioned.json));
  const parentUserId = provisioned.json?.parentUserId;

  const again = await admin.call("/api/parent/accounts/", {
    method: "POST",
    headers: { "idempotency-key": "test-parent-account" },
    body: JSON.stringify({ phone: PARENT_PHONE, displayName: "Latha Menon" }),
  });
  ok("…idempotently", again.json?.parentUserId === parentUserId && again.json?.created === false, JSON.stringify(again.json));

  eq("parent signs in", (await parent.login(PARENT_PHONE, SCHOOL_SCOPE)).status, 200);
  eq("student signs in", (await kabir.login(HOUSEHOLD_PHONE)).status, 200);
  const kabirId = (await kabir.call("/api/auth/session/")).json?.user?.id;

  // Before anything: no data, and no hint about whether the id is even real.
  const beforeAnything = await parent.call(`/api/parent/overview/?studentId=${kabirId}`);
  eq("no link at all → 403, not 404", beforeAnything.status, 403);

  // Ask. The household number is the join, and it matches both siblings.
  const asked = await parent.call("/api/parent/links/", {
    method: "POST",
    headers: { "idempotency-key": "test-link-request" },
    body: JSON.stringify({ studentPhone: HOUSEHOLD_PHONE }),
  });
  eq("a parent may ask", asked.status, 200);
  ok("…and the answer carries no count and no ids", !/\d/.test(JSON.stringify(asked.json ?? {})), JSON.stringify(asked.json));

  const unknown = await parent.call("/api/parent/links/", {
    method: "POST",
    headers: { "idempotency-key": "test-link-request-nobody" },
    body: JSON.stringify({ studentPhone: "+919899999999" }),
  });
  ok(
    "asking about a number nobody uses answers identically — no existence oracle",
    unknown.status === asked.status && JSON.stringify(unknown.json) === JSON.stringify(asked.json),
    JSON.stringify(unknown.json),
  );

  // Consent is required before any data.
  const pendingOverview = await parent.call(`/api/parent/overview/?studentId=${kabirId}`);
  eq("a pending request grants nothing → 403", pendingOverview.status, 403);

  const parentLinks = await parent.call("/api/parent/links/");
  const pendingRow = parentLinks.json?.children?.find((c) => c.studentUserId === kabirId);
  ok("the parent sees a request is outstanding", pendingRow?.status === "PENDING", JSON.stringify(pendingRow));
  ok("…with no name attached to it yet", pendingRow?.displayName === null, JSON.stringify(pendingRow));

  const studentView = await kabir.call("/api/parent/links/");
  const request = studentView.json?.requests?.find((r) => r.parentUserId === parentUserId);
  ok("the student sees who asked", Boolean(request), JSON.stringify(studentView.json));
  ok("…identified enough to recognise", /•+\d{4}$/.test(request?.phoneHint ?? ""), request?.phoneHint);

  // A parent cannot consent on the student's behalf.
  const selfGrant = await parent.call("/api/parent/consent/", {
    method: "POST",
    headers: { "idempotency-key": "test-self-grant" },
    body: JSON.stringify({ parentUserId, decision: "GRANT" }),
  });
  eq("a parent cannot grant themselves access", selfGrant.status, 403);

  // The student grants.
  const granted = await kabir.call("/api/parent/consent/", {
    method: "POST",
    headers: { "idempotency-key": "test-grant" },
    body: JSON.stringify({ parentUserId, decision: "GRANT" }),
  });
  ok("the student grants", granted.json?.status === "ACTIVE", JSON.stringify(granted.json));

  const overview = await parent.call(`/api/parent/overview/?studentId=${kabirId}`);
  eq("consent opens the dashboard", overview.status, 200);
  ok("…and it carries recommendations", Array.isArray(overview.json?.recommendations) && overview.json.recommendations.length > 0);
  {
    const hits = forbiddenKeysIn(overview.json);
    ok("no forbidden field appears anywhere in the response", hits.length === 0, hits.join(", "));
  }
  ok(
    "chapters carry a band, never a figure",
    (overview.json?.chapters ?? []).every((c) => typeof c.band === "string" && c.fraction === undefined),
  );

  // Another parent's student is still off limits: the link is per-pair.
  const otherId = "00000000-0000-0000-0000-0000000000ff";
  eq("a consented parent still cannot read a student they are not linked to", (await parent.call(`/api/parent/overview/?studentId=${otherId}`)).status, 403);

  // Revocation bites immediately.
  const revoked = await kabir.call("/api/parent/consent/", {
    method: "POST",
    headers: { "idempotency-key": "test-revoke" },
    body: JSON.stringify({ parentUserId, decision: "REVOKE" }),
  });
  ok("the student revokes", revoked.json?.status === "REVOKED", JSON.stringify(revoked.json));
  eq("access is gone on the very next request", (await parent.call(`/api/parent/overview/?studentId=${kabirId}`)).status, 403);

  const revokedAgain = await kabir.call("/api/parent/consent/", {
    method: "POST",
    headers: { "idempotency-key": "test-revoke" },
    body: JSON.stringify({ parentUserId, decision: "REVOKE" }),
  });
  ok("revoking twice is revoking once", revokedAgain.json?.status === "REVOKED");

  // Roles.
  eq("a student cannot read the parent overview", (await kabir.call("/api/parent/overview/")).status, 403);
  eq("a parent cannot provision parent accounts", (await parent.call("/api/parent/accounts/", { method: "POST", headers: { "idempotency-key": "x" }, body: JSON.stringify({ phone: "+919812345678" }) })).status, 403);

  // Export.
  section("live API — export");
  eq("a parent cannot export", (await parent.call("/api/export/?dataset=attempts")).status, 403);
  eq("a student cannot export", (await kabir.call("/api/export/?dataset=attempts")).status, 403);

  const docs = await admin.call("/api/export/");
  ok("an admin gets the documented column map", Array.isArray(docs.json?.columns?.attempts), JSON.stringify(docs.json)?.slice(0, 120));

  const csv = await admin.call("/api/export/?dataset=attempts");
  eq("an admin gets a CSV", csv.status, 200);
  ok("…served as text/csv", (csv.headers.get("content-type") ?? "").startsWith("text/csv"), csv.headers.get("content-type"));
  ok("…as an attachment", (csv.headers.get("content-disposition") ?? "").includes("attachment"));
  ok("…never cached by a proxy", csv.headers.get("cache-control") === "no-store");
  // `res.text()` decodes UTF-8 and swallows the BOM on the way, so it is absent
  // here even though the bytes on the wire carry it — the direct `toCsv` check
  // further up is the one that proves it is written.
  const headerLine = csv.text.replace(/^﻿/, "").split("\r\n")[0];
  ok("…with the documented header row", headerLine === ATTEMPT_COLUMNS.map((c) => c.header).join(","), headerLine);

  eq("a bad dataset name is a 400", (await admin.call("/api/export/?dataset=everything")).status, 400);
  const sync = await admin.call("/api/export/sync/", {
    method: "POST",
    headers: { "idempotency-key": "test-sync" },
    body: JSON.stringify({ dataset: "attempts" }),
  });
  eq("the LMS sync stub refuses rather than pretending", sync.status, 503);
  eq("…with a code a client can branch on", sync.json?.error?.code, "NOT_AVAILABLE");
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
