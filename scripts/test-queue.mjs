#!/usr/bin/env node
/**
 * The evaluator queue, proved rather than argued.
 *
 * Most of the checks below correspond to a specific defect in
 * `CBSE_EdTech_Platform_Technical_Specification.md`, and the interesting ones
 * are invisible to a single-threaded read of the code:
 *
 *   1. the shipped roster crosses midnight, and is on at 01:59 and off at
 *      02:00 — the spec's `start <= now <= end` matches nothing at all for a
 *      window that wraps, so the night shift silently does not exist;
 *   2. routing prefers rostered staff and falls through to the open network,
 *      and the fall-through *follows the clock*;
 *   3. six simultaneous claims take six **distinct** tickets — the spec's
 *      `findFirst`-then-`create` hands the same one to everybody;
 *   4. two simultaneous claims on a queue of one give exactly one winner, and
 *      the loser gets an ordinary "nothing to claim" rather than an error;
 *   5. `maxConcurrent` is enforced even against two requests in flight at once —
 *      the spec stored the limit and never read it;
 *   6. an expired lease returns to the pool, and `claimCount` survives it;
 *   7. a human override appends a linear supersede chain, and a second
 *      evaluator overriding the same revision loses cleanly;
 *   8. a voice note is per question, capped at 90 s, and says honestly that it
 *      will not be transcribed when nothing is configured to transcribe it;
 *   9. routing a submission twice produces one ticket, not two paid tutors;
 *  10. nothing here reads an identity out of a request, and an admin of one
 *      scope sees nothing of another's.
 *
 * Concurrency is demonstrated with `Promise.all` over real HTTP against a real
 * server and a real Postgres. There is no way to demonstrate `SKIP LOCKED` by
 * reasoning about it, and a test that issues its requests one after another
 * passes just as happily against the broken implementation.
 *
 *   node scripts/test-queue.mjs                 # reuses or starts a dev server
 *   QUEUE_TEST_BASE=http://localhost:3323 node scripts/test-queue.mjs
 *
 * It needs the database from docs/PLATFORM.md §6 (port 5433) and the seed.
 * It creates its own fixtures under a `qtest-` marker and removes them again,
 * including on failure — `prisma/seed.ts` upserts and never truncates, and
 * another lane has real work in this database.
 */
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { PrismaClient } from "@prisma/client";

const PORT = Number(process.env.QUEUE_TEST_PORT ?? 3323);
const MARKER = "qtest-";

/**
 * Whatever server we end up talking to. Resolved by `startServer`.
 *
 * The shift expectations below deliberately do **not** set `EVALUATOR_SHIFTS`.
 * The default roster in `src/lib/queue.ts` already puts `INTERNAL_TUTOR` on
 * 16:00–02:00 Asia/Kolkata — the Indian evening peak running past midnight —
 * so the awkward case is the shipped default and the test exercises what a
 * deployment would actually run rather than a window invented for the test.
 */
let BASE = process.env.QUEUE_TEST_BASE ?? null;

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail = "") {
  passed++;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}
function bad(name, detail) {
  failed++;
  failures.push(`${name}: ${detail}`);
  console.log(`  ✗ ${name} — ${detail}`);
}
function check(name, condition, detail = "") {
  if (condition) ok(name, detail);
  else bad(name, detail || "assertion failed");
}
function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

let child = null;

const DEV_LOCK = path.resolve(".next/dev/lock");

/**
 * Is *this* app answering here?
 *
 * A bare "did something reply on that port" is not enough: development machines
 * have other things listening, and pointing the suite at one of them fails
 * later and confusingly. The signature checked for is this platform's own error
 * envelope from `src/lib/api.ts` — a 401 whose body is
 * `{ error: { code: "UNAUTHENTICATED", … } }` — or a signed-in session.
 */
async function reachable(base) {
  try {
    const res = await fetch(`${base}/api/auth/session/`, { cache: "no-store" });
    if (res.status !== 200 && res.status !== 401) return false;
    const json = await res.json().catch(() => null);
    if (res.status === 401) return json?.error?.code === "UNAUTHENTICATED";
    return json !== null && "user" in json;
  } catch {
    return false;
  }
}

/** `{ pid, port, appUrl }` from Next's single-instance lock, or null. */
function readDevLock() {
  try {
    return JSON.parse(readFileSync(DEV_LOCK, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Find a server to talk to, or start one.
 *
 * `next dev` takes a single-instance lock per project directory, and this repo
 * is worked on by several people at once — so the common case is that somebody
 * else's dev server is already up. Reusing it is correct: it is the same tree
 * and the same code, and the checks below drive it through HTTP and Postgres
 * rather than through anything process-local. A lock left behind by a dev
 * server that crashed is cleared, but only after confirming its pid is gone.
 */
async function startServer() {
  if (BASE) {
    if (!(await reachable(BASE))) throw new Error(`Nothing is answering at ${BASE}.`);
    console.log(`Using the server at ${BASE} (QUEUE_TEST_BASE).`);
    return;
  }

  const lock = readDevLock();
  const candidates = [];
  if (lock?.appUrl) candidates.push(lock.appUrl);
  for (const p of [PORT, 3322, 3324, 3000]) candidates.push(`http://localhost:${p}`);

  for (const candidate of candidates) {
    if (await reachable(candidate)) {
      BASE = candidate;
      console.log(`Reusing the dev server already running at ${BASE}.`);
      return;
    }
  }

  if (lock && !pidAlive(lock.pid)) {
    console.log(`Clearing a stale dev lock (pid ${lock.pid} is gone).`);
    rmSync(DEV_LOCK, { force: true });
  }

  BASE = `http://localhost:${PORT}`;
  console.log(`Starting next dev on ${PORT}…`);
  child = spawn("npx", ["next", "dev", "--port", String(PORT)], {
    env: { ...process.env, NODE_ENV: "development" },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (b) => {
    const text = String(b);
    if (/error/i.test(text)) process.stderr.write(text);
  });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await reachable(BASE)) {
      console.log("Server is up.");
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("The dev server did not come up within three minutes.");
}

function stopServer() {
  if (!child) return;
  // `next dev` forks a worker; killing the parent alone leaves the port held.
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  child = null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function login(phone, scopeId) {
  const res = await fetch(`${BASE}/api/dev/login/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(scopeId ? { phone, scopeId } : { phone }),
  });
  if (!res.ok) throw new Error(`dev login failed for ${phone}: ${res.status} ${await res.text()}`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  return cookies.join("; ");
}

async function api(cookie, path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PHONES = {
  student: "+919810000001", // Aarti — Class 10, hitlEnabled
  meera: "+919810000021", // SCHOOL_TEACHER, Science 9 + 10
  // Vikram, the seeded admin, is an admin *of the school scope* — every fixture
  // below lives in the public (nil-UUID) scope, and he must not be able to see
  // it. That is the rule working, not an obstacle, so the test provisions its
  // own public-scope admin and keeps Vikram around to prove the boundary holds.
  schoolAdmin: "+919810000031",
  admin: "+919810009993",
  qtestScience: "+919810009991",
  qtestNight: "+919810009992",
};

const PUBLIC_SCOPE = "00000000-0000-0000-0000-000000000000";
/** The seed's second scope, where Vikram and the Menon sibling live. */
const SCHOOL_SCOPE = "11111111-1111-1111-1111-111111111111";

async function upsertUser(phone, name, role) {
  return prisma.user.upsert({
    where: { scopeId_phone: { scopeId: PUBLIC_SCOPE, phone } },
    update: { displayName: name, role },
    create: { phone, displayName: name, role },
  });
}

async function upsertEvaluator({ phone, name, evaluatorType, maxConcurrent, subjects }) {
  const user = await prisma.user.upsert({
    where: { scopeId_phone: { scopeId: PUBLIC_SCOPE, phone } },
    update: { displayName: name, role: "EVALUATOR" },
    create: { phone, displayName: name, role: "EVALUATOR" },
  });
  const profile = await prisma.evaluatorProfile.upsert({
    where: { userId: user.id },
    update: { evaluatorType, maxConcurrent, activeForRouting: true },
    create: { userId: user.id, evaluatorType, maxConcurrent, activeForRouting: true },
  });
  for (const s of subjects) {
    await prisma.evaluatorSubject.upsert({
      where: {
        evaluatorProfileId_subject_classNum: {
          evaluatorProfileId: profile.id,
          subject: s.subject,
          classNum: s.classNum,
        },
      },
      update: {},
      create: { evaluatorProfileId: profile.id, ...s },
    });
  }
  return user;
}

async function makeSubmission(studentId, n, { subject = "Science", classNum = 10 } = {}) {
  const submission = await prisma.submission.create({
    data: {
      studentId,
      subject,
      classNum,
      paperSlug: "class10-science-2025-26",
      idempotencyKey: `${MARKER}${n}-${Date.now()}`,
      status: "AWAITING_REVIEW",
      pageCount: 1,
    },
  });
  const page = await prisma.submissionPage.create({
    data: {
      submissionId: submission.id,
      pageIndex: 0,
      storageKey: `submissions/${submission.id}/pages/000.jpg`,
      contentType: "image/jpeg",
    },
  });
  const answer = await prisma.answer.create({
    data: {
      submissionId: submission.id,
      questionNumber: 13, // class10-science-2025-26 Q13: 3 marks, needsReview, has a DIAGRAM
      maxMarks: 3,
      type: "SA",
      transcript: "Ohm's law states V = IR. Resistance is 4 ohm.",
    },
  });
  await prisma.answerPage.create({
    data: { answerId: answer.id, submissionPageId: page.id, ordinal: 0 },
  });
  return { submission, page, answer };
}

async function makeTicket(submissionId, { subject = "Science", classNum = 10, priority = 0 } = {}) {
  return prisma.evaluationTicket.create({
    data: { submissionId, subject, classNum, priority },
  });
}

async function cleanup() {
  const submissions = await prisma.submission.findMany({
    where: { idempotencyKey: { startsWith: MARKER } },
    select: { id: true, answers: { select: { id: true } } },
  });
  for (const s of submissions) {
    for (const a of s.answers) {
      // The rows cascade; the objects under `.storage/` do not, because storage
      // has no idea a row referred to it. Sweep the prefix `storageKeys` owns.
      rmSync(path.resolve(".storage/voice-notes", a.id), { recursive: true, force: true });
      // `GradingResult.supersedes` is ON DELETE RESTRICT, so the chain has to
      // come apart newest-first rather than by cascade.
      const chain = await prisma.gradingResult.findMany({
        where: { answerId: a.id },
        orderBy: { revision: "desc" },
        select: { id: true },
      });
      for (const g of chain) await prisma.gradingResult.delete({ where: { id: g.id } });
    }
    await prisma.submission.delete({ where: { id: s.id } });
  }
  for (const phone of [PHONES.qtestScience, PHONES.qtestNight, PHONES.admin]) {
    const user = await prisma.user.findUnique({
      where: { scopeId_phone: { scopeId: PUBLIC_SCOPE, phone } },
      select: { id: true },
    });
    if (user) await prisma.user.delete({ where: { id: user.id } });
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * The instant at which it is `minute` past midnight on 2026-09-01 in `zone`.
 *
 * Built by search rather than by adding an offset, so it stays correct for a
 * zone that observes DST. India does not, but the evaluator network will not
 * stay inside India, and "it worked in Delhi" is not a property worth shipping.
 */
function instantAtLocalMinute(zone, minute) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const localMinute = (d) => {
    const p = fmt.formatToParts(d);
    return Number(p.find((x) => x.type === "hour").value) * 60 +
      Number(p.find((x) => x.type === "minute").value);
  };
  const base = Date.UTC(2026, 8, 1, 0, 0);
  for (let offset = 0; offset < 1440; offset++) {
    const d = new Date(base + offset * 60_000);
    if (localMinute(d) === minute) return d.toISOString();
  }
  throw new Error(`no instant maps to minute ${minute} in ${zone}`);
}

const mod1440 = (m) => ((m % 1440) + 1440) % 1440;

async function testShiftWrap(adminCookie) {
  section("1. A shift that crosses midnight actually exists");

  const now = await api(adminCookie, "/api/tickets/roster/");
  if (now.status !== 200) {
    bad("read the roster", `HTTP ${now.status} ${JSON.stringify(now.json)}`);
    return;
  }
  const tutor = now.json.roster.find((r) => r.shift && r.overnight);
  if (!tutor) {
    bad(
      "an overnight roster is configured",
      `no rostered evaluator whose window wraps midnight: ${JSON.stringify(
        now.json.roster.map((r) => [r.evaluatorType, r.shift]),
      )}`,
    );
    return;
  }

  const { startMinute, endMinute, timeZone } = tutor.shift;
  const wall = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  ok(
    "the shipped default roster crosses midnight",
    `${tutor.evaluatorType} ${wall(startMinute)}–${wall(endMinute)} ${timeZone}`,
  );

  // Inside the window (including the two hours after midnight), at its
  // inclusive start, at its exclusive end, and well outside it.
  const spanLength = mod1440(endMinute - startMinute);
  const cases = [
    { minute: startMinute, label: "the first minute of the shift", expected: true },
    { minute: mod1440(startMinute + Math.floor(spanLength / 2)), label: "the middle of the shift", expected: true },
    { minute: mod1440(endMinute - 1), label: "the last minute of the shift", expected: true },
    { minute: endMinute, label: "the minute the shift ends", expected: false },
    { minute: mod1440(startMinute - 1), label: "the minute before it starts", expected: false },
    { minute: mod1440(endMinute + Math.floor((1440 - spanLength) / 2)), label: "the middle of the gap", expected: false },
  ];
  // The wrap is only being exercised if some of these fall after midnight.
  check(
    "the checks below straddle midnight",
    cases.some((c) => c.minute < endMinute) && cases.some((c) => c.minute >= startMinute),
    cases.map((c) => wall(c.minute)).join(", "),
  );

  for (const c of cases) {
    const at = instantAtLocalMinute(timeZone, c.minute);
    const { status, json } = await api(
      adminCookie,
      `/api/tickets/roster/?at=${encodeURIComponent(at)}`,
    );
    if (status !== 200) {
      bad(`roster at ${wall(c.minute)}`, `HTTP ${status}`);
      continue;
    }
    const row = json.roster.find((r) => r.evaluatorId === tutor.evaluatorId);
    check(
      `${wall(c.minute)} ${timeZone} — ${c.label} — is ${c.expected ? "on" : "off"} shift`,
      row?.onShift === c.expected,
      `onShift=${row?.onShift}`,
    );
  }

  // For contrast: the comparison this replaces, applied to the same window.
  const naive = (m) => m >= startMinute && m <= endMinute;
  check(
    "the `start <= now <= end` comparison this replaces matches no minute of the day",
    ![...Array(1440).keys()].some(naive),
    `unsatisfiable for ${wall(startMinute)}–${wall(endMinute)} — the night shift silently never exists`,
  );

  return tutor;
}

async function testRouting(adminCookie, tutor) {
  section("2. Routing: rostered staff first, then the open network");

  if (!tutor?.shift) {
    bad("routing", "no overnight roster to route against");
    return;
  }
  const { startMinute, endMinute, timeZone } = tutor.shift;
  const spanLength = mod1440(endMinute - startMinute);
  // Deep inside the small hours, and the middle of the daytime gap.
  const onShiftAt = instantAtLocalMinute(timeZone, mod1440(endMinute - 30));
  const offShiftAt = instantAtLocalMinute(
    timeZone,
    mod1440(endMinute + Math.floor((1440 - spanLength) / 2)),
  );

  const night = await api(
    adminCookie,
    `/api/tickets/roster/?subject=${encodeURIComponent("Social Science")}&classNum=9&at=${encodeURIComponent(onShiftAt)}`,
  );
  check(
    "a Social Science 9 script inside the night shift goes to rostered staff",
    night.json?.routing?.engine === "FIXED_SHIFT" && night.json.routing.assignedEvaluatorId,
    `engine=${night.json?.routing?.engine} · ${night.json?.routing?.rationale}`,
  );

  const noon = await api(
    adminCookie,
    `/api/tickets/roster/?subject=${encodeURIComponent("Social Science")}&classNum=9&at=${encodeURIComponent(offShiftAt)}`,
  );
  check(
    "the same script outside those hours falls through to the open network",
    noon.json?.routing?.engine === "OPEN_POOL" && noon.json.routing.assignedEvaluatorId === null,
    `engine=${noon.json?.routing?.engine} · ${noon.json?.routing?.rationale}`,
  );
  check(
    "and the fall-through names the reason on the candidate it skipped",
    (noon.json?.routing?.considered ?? []).some((c) => c.reason === "OFF_SHIFT"),
    JSON.stringify((noon.json?.routing?.considered ?? []).map((c) => [c.evaluatorType, c.reason])),
  );

  const gig = await api(adminCookie, `/api/tickets/roster/?subject=Mathematics&classNum=10`);
  check(
    "an unrostered freelance evaluator is never assigned, only offered the board",
    gig.json?.routing?.engine === "OPEN_POOL",
    gig.json?.routing?.rationale ?? "",
  );
}

async function testConcurrentClaims(cookies, studentId) {
  section("3. Six simultaneous claims take six distinct tickets");

  const made = [];
  for (let i = 0; i < 6; i++) {
    const { submission } = await makeSubmission(studentId, `c${i}`);
    made.push(await makeTicket(submission.id));
  }

  const claimers = [
    cookies.meera,
    cookies.qtestScience,
    cookies.meera,
    cookies.qtestScience,
    cookies.meera,
    cookies.qtestScience,
  ];
  const results = await Promise.all(
    claimers.map((c) => api(c, "/api/tickets/claim/", { method: "POST", body: "{}" })),
  );

  const claimed = results.filter((r) => r.json?.claimed).map((r) => r.json.ticket.id);
  const distinct = new Set(claimed);
  check("every request returned 200", results.every((r) => r.status === 200), `statuses ${results.map((r) => r.status).join(",")}`);
  check("six tickets were claimed", claimed.length === 6, `claimed ${claimed.length}`);
  check(
    "no ticket was handed out twice",
    distinct.size === claimed.length,
    `${distinct.size} distinct of ${claimed.length}`,
  );

  const rows = await prisma.evaluationTicket.findMany({
    where: { id: { in: made.map((t) => t.id) } },
    select: { id: true, status: true, claimedById: true, claimCount: true, leaseExpiresAt: true },
  });
  check(
    "each claimed row carries exactly one holder, one lease and claimCount 1",
    rows.every(
      (r) => r.status === "CLAIMED" && r.claimedById && r.leaseExpiresAt && r.claimCount === 1,
    ),
    JSON.stringify(rows.map((r) => [r.status, r.claimCount])),
  );

  return made;
}

async function testSingleTicketRace(cookies, studentId) {
  section("4. Two simultaneous claims, one ticket");

  const { submission } = await makeSubmission(studentId, "race");
  const ticket = await makeTicket(submission.id);

  const [a, b] = await Promise.all([
    api(cookies.meera, "/api/tickets/claim/", { method: "POST", body: "{}" }),
    api(cookies.qtestScience, "/api/tickets/claim/", { method: "POST", body: "{}" }),
  ]);

  const winners = [a, b].filter((r) => r.json?.claimed);
  const losers = [a, b].filter((r) => !r.json?.claimed);
  check("exactly one claimed it", winners.length === 1, `${winners.length} winners`);
  check(
    "the loser got an ordinary 200, not an error",
    losers.length === 1 && losers[0].status === 200,
    `status ${losers[0]?.status}, message ${JSON.stringify(losers[0]?.json?.message)}`,
  );
  check(
    "and the winner holds the row",
    winners[0]?.json?.ticket?.id === ticket.id,
    `${winners[0]?.json?.ticket?.id} vs ${ticket.id}`,
  );

  return ticket;
}

async function testMaxConcurrent(cookies, studentId, qtestScienceUserId) {
  section("5. maxConcurrent is enforced under concurrency");

  // Clear this evaluator's hands, then allow exactly one ticket at a time.
  await prisma.evaluationTicket.updateMany({
    where: { claimedById: qtestScienceUserId, status: { in: ["CLAIMED", "IN_REVIEW"] } },
    data: { status: "PENDING", claimedById: null, claimedAt: null, leaseExpiresAt: null },
  });
  await prisma.evaluatorProfile.update({
    where: { userId: qtestScienceUserId },
    data: { maxConcurrent: 1 },
  });

  for (let i = 0; i < 2; i++) {
    const { submission } = await makeSubmission(studentId, `cap${i}`);
    await makeTicket(submission.id);
  }

  const [a, b] = await Promise.all([
    api(cookies.qtestScience, "/api/tickets/claim/", { method: "POST", body: "{}" }),
    api(cookies.qtestScience, "/api/tickets/claim/", { method: "POST", body: "{}" }),
  ]);

  const claimed = [a, b].filter((r) => r.json?.claimed);
  const refused = [a, b].filter((r) => !r.json?.claimed);
  check(
    "one of two simultaneous claims by a limit-1 evaluator succeeds",
    claimed.length === 1,
    `${claimed.length} claimed`,
  );
  check(
    "the other is refused with AT_CONCURRENCY_LIMIT",
    refused.length === 1 && refused[0].json?.reason === "AT_CONCURRENCY_LIMIT",
    `reason ${JSON.stringify(refused[0]?.json?.reason)}`,
  );

  const held = await prisma.evaluationTicket.count({
    where: { claimedById: qtestScienceUserId, status: { in: ["CLAIMED", "IN_REVIEW"] } },
  });
  check("the database agrees the limit held", held === 1, `holding ${held}`);

  const board = await api(cookies.qtestScience, "/api/tickets/");
  check(
    "the board tells the evaluator why the button is off",
    board.json?.evaluator?.canClaim === false &&
      board.json.evaluator.refusedMessage?.includes("as many tickets"),
    JSON.stringify(board.json?.evaluator?.refusedMessage),
  );
}

async function testLeaseSweeper(cookies, studentId) {
  section("6. An expired lease returns to the pool");

  const { submission } = await makeSubmission(studentId, "lease");
  const ticket = await makeTicket(submission.id);

  const claim = await api(cookies.meera, "/api/tickets/claim/", { method: "POST", body: "{}" });
  check("claimed for the lease test", claim.json?.claimed === true, JSON.stringify(claim.json?.message));

  const claimedId = claim.json?.ticket?.id ?? ticket.id;

  // A tutor who shut their laptop sixteen minutes ago.
  await prisma.evaluationTicket.update({
    where: { id: claimedId },
    data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
  });

  const before = await prisma.evaluationTicket.findUnique({ where: { id: claimedId } });
  const sweep = await api(cookies.admin, "/api/tickets/sweep/", { method: "POST", body: "{}" });
  check("the sweeper ran", sweep.status === 200, `HTTP ${sweep.status}`);
  check(
    "and released the expired ticket",
    (sweep.json?.ticketIds ?? []).includes(claimedId),
    `released ${sweep.json?.released}`,
  );

  const after = await prisma.evaluationTicket.findUnique({ where: { id: claimedId } });
  check(
    "the ticket is back on the board with no holder and no lease",
    after.status === "PENDING" && after.claimedById === null && after.leaseExpiresAt === null,
    `${after.status} / ${after.claimedById} / ${after.leaseExpiresAt}`,
  );
  check(
    "claimCount survives, because a repeatedly-dropped ticket is a bad scan",
    after.claimCount === before.claimCount && after.claimCount >= 1,
    `claimCount ${after.claimCount}`,
  );

  // And it can be claimed again — the point of putting it back.
  const again = await api(cookies.meera, "/api/tickets/claim/", { method: "POST", body: "{}" });
  const reclaimed = await prisma.evaluationTicket.findUnique({ where: { id: claimedId } });
  check(
    "a second claim increments claimCount rather than resetting it",
    again.json?.claimed === true && reclaimed.claimCount === before.claimCount + 1,
    `claimCount ${reclaimed.claimCount}`,
  );

  const extend = await api(cookies.meera, `/api/tickets/${claimedId}/lease/`, {
    method: "POST",
    body: JSON.stringify({ minutes: 20 }),
  });
  check("the holder can extend the lease", extend.status === 200 && !!extend.json?.leaseExpiresAt, `HTTP ${extend.status}`);

  const stranger = await api(cookies.qtestScience, `/api/tickets/${claimedId}/lease/`, {
    method: "POST",
    body: JSON.stringify({ minutes: 20 }),
  });
  check(
    "somebody who is not holding it cannot",
    stranger.status === 409 || stranger.status === 404,
    `HTTP ${stranger.status}`,
  );
}

async function testSupersedeChain(cookies, studentId) {
  section("7. A human override appends; the chain stays linear");

  // Take every fixture ticket from the earlier checks off the board, so the
  // claim below can only return the one this check is about. The claim is
  // deliberately not addressable — an evaluator gets the next ticket, not a
  // ticket of their choosing — so the queue has to be arranged instead.
  await prisma.evaluationTicket.updateMany({
    where: { submission: { idempotencyKey: { startsWith: MARKER } } },
    data: {
      status: "CANCELLED",
      claimedById: null,
      claimedAt: null,
      leaseExpiresAt: null,
    },
  });

  const { submission, answer } = await makeSubmission(studentId, "chain");
  const chainTicket = await makeTicket(submission.id);

  const claim = await api(cookies.meera, "/api/tickets/claim/", { method: "POST", body: "{}" });
  if (!claim.json?.claimed) {
    bad("claimed the chain ticket", JSON.stringify(claim.json));
    return;
  }
  const ticketId = claim.json.ticket.id;
  check("and it is the ticket under test", ticketId === chainTicket.id, `${ticketId} vs ${chainTicket.id}`);

  // The model's verdict, as the AI grader would have written it: a rubric
  // flagged needsReview, so the diagram step and the withheld miss are UNMARKED
  // rather than red.
  const rubric = await prisma.rubric.findFirst({
    where: { paperSlug: "class10-science-2025-26", questionNumber: 13 },
    include: { criteria: { orderBy: { ordinal: "asc" } } },
  });
  const ai = await prisma.gradingResult.create({
    data: {
      answerId: answer.id,
      rubricId: rubric.id,
      source: "AI",
      revision: 1,
      awardedMarks: 1,
      maxMarks: 3,
      unmarkedCount: 2,
      confidence: 0.62,
      modelName: "test-grader",
    },
  });
  for (const c of rubric.criteria) {
    const unmarked = !c.autoGradable || rubric.needsReview;
    await prisma.criterionResult.create({
      data: {
        gradingResultId: ai.id,
        rubricCriterionId: c.id,
        verdict: unmarked ? "UNMARKED" : "HIT",
        awarded: unmarked ? 0 : (c.marks ?? 0),
        unmarkedReason: unmarked
          ? c.autoGradable
            ? "RUBRIC_NEEDS_REVIEW"
            : "NOT_AUTO_GRADABLE"
          : null,
      },
    });
  }

  const detail = await api(cookies.meera, `/api/tickets/${ticketId}/`);
  check("the canvas payload loads", detail.status === 200, `HTTP ${detail.status}`);
  const canvasAnswer = detail.json?.answers?.find((a) => a.id === answer.id);
  const items = canvasAnswer?.checklist?.items ?? [];
  if (!items.length) {
    bad("the checklist carries the rubric", JSON.stringify(canvasAnswer?.checklist ?? detail.json?.error));
    return;
  }
  check(
    "unmarked criteria are surfaced first",
    items.length > 0 &&
      items[0].urgency !== "SETTLED" &&
      items[0].verdict === "UNMARKED",
    `first item urgency=${items[0]?.urgency} verdict=${items[0]?.verdict}`,
  );
  check(
    "a diagram step is flagged as needing a human eye, not a signature",
    items.some((i) => i.kind === "DIAGRAM" && i.unmarkedReason === "NOT_AUTO_GRADABLE"),
    JSON.stringify(items.map((i) => [i.kind, i.unmarkedReason])),
  );
  check(
    "the unsigned rubric is called out to the evaluator",
    canvasAnswer?.checklist?.rubricNeedsReview === true,
    `needsReview=${canvasAnswer?.checklist?.rubricNeedsReview}`,
  );

  const started = await api(cookies.meera, "/api/reviews/", {
    method: "POST",
    headers: { "idempotency-key": `qtest-review-${ticketId}` },
    body: JSON.stringify({ ticketId }),
  });
  check("a review opened", started.status === 200 && !!started.json?.review?.id, `HTTP ${started.status}`);
  const reviewId = started.json.review.id;

  const again = await api(cookies.meera, "/api/reviews/", {
    method: "POST",
    headers: { "idempotency-key": `qtest-review-${ticketId}` },
    body: JSON.stringify({ ticketId }),
  });
  check(
    "opening the canvas twice reuses the same pass",
    again.json?.review?.id === reviewId && again.json?.created === false,
    `${again.json?.review?.id} created=${again.json?.created}`,
  );

  // The teacher resolves the unmarked lines: full marks on everything.
  const criteria = items.map((i) => ({
    rubricCriterionId: i.rubricCriterionId,
    verdict: i.worth > 0 ? "HIT" : "UNMARKED",
    awarded: i.worth > 0 ? i.worth : 0,
    unmarkedReason: i.worth > 0 ? undefined : "NOT_AUTO_GRADABLE",
    highlights:
      i.worth > 0
        ? [
            {
              submissionPageId: detail.json.pages[0].id,
              color: "GREEN",
              x: 0.1,
              y: 0.1,
              width: 0.4,
              height: 0.08,
              label: "resolved by hand",
            },
          ]
        : [],
  }));

  const graded = await api(cookies.meera, `/api/reviews/${reviewId}/grade/`, {
    method: "POST",
    body: JSON.stringify({
      answerId: answer.id,
      expectedRevision: 1,
      comment: "Gave the formula, so the working counts.",
      criteria,
    }),
  });
  check("the override was accepted", graded.status === 200, `HTTP ${graded.status} ${JSON.stringify(graded.json?.error?.message ?? "")}`);
  check("it is revision 2", graded.json?.revision === 2, `revision ${graded.json?.revision}`);
  check(
    "and it supersedes the AI's verdict rather than replacing it",
    graded.json?.supersededId === ai.id,
    `supersedes ${graded.json?.supersededId}`,
  );

  const surviving = await prisma.gradingResult.findUnique({ where: { id: ai.id } });
  check(
    "the AI's row is still there, untouched",
    surviving !== null &&
      Number(surviving.awardedMarks) === 1 &&
      surviving.source === "AI" &&
      surviving.confidence === 0.62,
    `awarded ${surviving?.awardedMarks}, confidence ${surviving?.confidence}`,
  );

  const aiCriteria = await prisma.criterionResult.count({ where: { gradingResultId: ai.id } });
  check(
    "so are its per-criterion verdicts",
    aiCriteria === rubric.criteria.length,
    `${aiCriteria} of ${rubric.criteria.length}`,
  );

  const chain = graded.json?.chain ?? [];
  check(
    'the chain reads "AI → teacher"',
    chain.length === 2 && chain[0].source === "AI" && chain[1].source === "HUMAN" && chain[1].current,
    chain.map((c) => `${c.source} ${c.awardedMarks}/${c.maxMarks}`).join(" -> "),
  );

  // A second evaluator overriding the same revision loses cleanly rather than
  // leaving two rows each claiming to be current.
  const stale = await api(cookies.meera, `/api/reviews/${reviewId}/grade/`, {
    method: "POST",
    body: JSON.stringify({ answerId: answer.id, expectedRevision: 1, criteria }),
  });
  check(
    "a second override of revision 1 is refused",
    stale.status === 409,
    `HTTP ${stale.status} ${JSON.stringify(stale.json?.error?.code)}`,
  );

  const rows = await prisma.gradingResult.findMany({
    where: { answerId: answer.id },
    orderBy: { revision: "asc" },
    select: { id: true, revision: true, supersedesId: true, source: true },
  });
  const linear = rows.every(
    (r, i) => r.revision === i + 1 && r.supersedesId === (i === 0 ? null : rows[i - 1].id),
  );
  check("the chain is linear with no forks", linear && rows.length === 2, JSON.stringify(rows.map((r) => r.revision)));

  const denormalised = await prisma.criterionResult.count({
    where: { gradingResultId: graded.json.gradingResultId },
  });
  check(
    "the human revision wrote its own criterion results rather than sharing the AI's",
    denormalised === criteria.length,
    `${denormalised} of ${criteria.length}`,
  );

  const spans = await prisma.highlightSpan.findMany({
    where: { gradingResultId: graded.json.gradingResultId },
    include: { criterionResult: { select: { verdict: true } } },
  });
  check(
    "no highlight span was written for an unmarked criterion",
    spans.every((s) => s.criterionResult?.verdict !== "UNMARKED"),
    `${spans.length} span(s)`,
  );

  // The constraint, from the other side: an UNMARKED verdict that tries to
  // award marks is refused with a field-level message, not a bare 500.
  const bogus = await api(cookies.meera, `/api/reviews/${reviewId}/grade/`, {
    method: "POST",
    body: JSON.stringify({
      answerId: answer.id,
      expectedRevision: 2,
      criteria: [
        {
          rubricCriterionId: items[0].rubricCriterionId,
          verdict: "UNMARKED",
          awarded: 1,
          unmarkedReason: "NOT_AUTO_GRADABLE",
        },
      ],
    }),
  });
  check(
    "an UNMARKED criterion awarding marks is a 400, not a 500",
    bogus.status === 400 && bogus.json?.error?.code === "VALIDATION_FAILED",
    `HTTP ${bogus.status} ${JSON.stringify(bogus.json?.error?.code)}`,
  );

  await testVoiceNotes(cookies, reviewId, answer.id);
}

async function testVoiceNotes(cookies, reviewId, answerId) {
  section("8. Voice notes: per question, capped at 90s, honest about transcription");

  async function upload(fields) {
    const form = new FormData();
    for (const [k, value] of Object.entries(fields)) form.set(k, value);
    const res = await fetch(`${BASE}/api/reviews/${reviewId}/voice-notes/`, {
      method: "POST",
      headers: { cookie: cookies.meera },
      body: form,
    });
    const json = await res.json();
    return { status: res.status, json };
  }

  // A WebM/Matroska magic number and nothing else. The route measures the bytes
  // it was given rather than believing a declared length, so eight of them are
  // as good a test as eight hundred thousand.
  const audio = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])], {
    type: "audio/webm",
  });

  const saved = await upload({ answerId, durationMs: "45000", audio });
  check(
    "a 45-second note uploads",
    saved.status === 201,
    `HTTP ${saved.status} ${JSON.stringify(saved.json?.error?.message ?? "")}`,
  );
  check(
    "it is attached to the question, not to the script",
    saved.json?.voiceNote?.answerId === answerId,
    `answerId ${saved.json?.voiceNote?.answerId}`,
  );

  // Transcription degrades honestly. With no provider configured the row must
  // say so rather than sitting on PENDING forever pretending a worker is
  // coming — and `transcript` must stay null rather than being invented.
  const available = saved.json?.transcription?.available;
  check(
    "the response states whether transcription is configured at all",
    typeof available === "boolean",
    `available=${available}`,
  );
  if (available === false) {
    check(
      "with no provider, the status is FAILED rather than a forever-PENDING lie",
      saved.json.voiceNote.transcriptStatus === "FAILED",
      `status ${saved.json.voiceNote.transcriptStatus}`,
    );
    check(
      "and no transcript is fabricated",
      saved.json.voiceNote.transcript === null,
      JSON.stringify(saved.json.voiceNote.transcript),
    );
    check(
      "and the message says why in words",
      /no transcription provider is configured/i.test(saved.json.transcription.message ?? ""),
      JSON.stringify(saved.json.transcription.message),
    );
  } else {
    check(
      "with a provider, the note is queued",
      saved.json.voiceNote.transcriptStatus === "PENDING",
      `status ${saved.json.voiceNote.transcriptStatus}`,
    );
  }

  const tooLong = await upload({ answerId, durationMs: "90001", audio });
  check(
    "91 seconds is refused with a field-level message, not a 500",
    tooLong.status === 400 && tooLong.json?.error?.code === "VALIDATION_FAILED",
    `HTTP ${tooLong.status} ${JSON.stringify(tooLong.json?.error?.issues?.[0]?.message ?? "")}`,
  );

  const wrongType = new Blob(["<html>not audio</html>"], { type: "text/html" });
  const rejected = await upload({ answerId, durationMs: "1000", audio: wrongType });
  check(
    "a file outside the audio allowlist is refused by the storage policy",
    rejected.status === 415,
    `HTTP ${rejected.status}`,
  );

  const listed = await api(cookies.meera, `/api/reviews/${reviewId}/voice-notes/`);
  check(
    "the notes list back with a freshly minted playback URL",
    listed.status === 200 &&
      listed.json.voiceNotes.length === 1 &&
      listed.json.voiceNotes[0].url.startsWith("/api/dev/storage/"),
    JSON.stringify(listed.json?.voiceNotes?.[0]?.url ?? listed.json),
  );

  const stored = await prisma.voiceNote.findFirst({ where: { answerId } });
  check(
    "the row holds an object key, never a URL",
    !!stored?.storageKey?.startsWith("voice-notes/") && !stored.storageKey.includes("://"),
    stored?.storageKey,
  );
}

async function testDispatch(cookies, studentId) {
  section("9. Putting a submission on the board is idempotent");

  const { submission } = await makeSubmission(studentId, "dispatch");
  const key = `qtest-dispatch-${submission.id}`;

  const first = await api(cookies.admin, "/api/tickets/dispatch/", {
    method: "POST",
    headers: { "idempotency-key": key },
    body: JSON.stringify({ submissionId: submission.id, priority: 3 }),
  });
  check(
    "the ticket was created",
    first.status === 200 && first.json?.created === true,
    `HTTP ${first.status} ${JSON.stringify(first.json?.error?.message ?? "")}`,
  );
  check(
    "and it carries the routing decision that made it",
    !!first.json?.routing?.engine,
    `${first.json?.routing?.engine} · ${first.json?.routing?.rationale}`,
  );
  check(
    "subject and class came from the submission row, not the request",
    first.json?.ticket?.subject === "Science" && first.json?.ticket?.classNum === 10,
    `${first.json?.ticket?.subject} ${first.json?.ticket?.classNum}`,
  );

  const retry = await api(cookies.admin, "/api/tickets/dispatch/", {
    method: "POST",
    headers: { "idempotency-key": key },
    body: JSON.stringify({ submissionId: submission.id, priority: 3 }),
  });
  check(
    "a dropped-and-retried POST does not pay two tutors to mark one script",
    retry.status === 200 &&
      retry.json?.created === false &&
      retry.json.ticket.id === first.json.ticket.id,
    `created=${retry.json?.created}`,
  );

  const noKey = await api(cookies.admin, "/api/tickets/dispatch/", {
    method: "POST",
    body: JSON.stringify({ submissionId: submission.id }),
  });
  check(
    "and the Idempotency-Key header is demanded rather than assumed",
    noKey.status === 400 && noKey.json?.error?.code === "IDEMPOTENCY_KEY_REQUIRED",
    `HTTP ${noKey.status} ${JSON.stringify(noKey.json?.error?.code)}`,
  );

  // A student who was never enabled for human review does not get routed to one
  // by accident — that spends money nobody agreed to spend.
  const imran = await prisma.user.findUnique({
    where: { scopeId_phone: { scopeId: PUBLIC_SCOPE, phone: "+919810000002" } },
  });
  const notEnabled = await makeSubmission(imran.id, "hitl");
  const refused = await api(cookies.admin, "/api/tickets/dispatch/", {
    method: "POST",
    headers: { "idempotency-key": `qtest-hitl-${notEnabled.submission.id}` },
    body: JSON.stringify({ submissionId: notEnabled.submission.id }),
  });
  check(
    "a student not enabled for human review is not routed to one",
    refused.status === 409,
    `HTTP ${refused.status} ${JSON.stringify(refused.json?.error?.message ?? "")}`,
  );
  const forced = await api(cookies.admin, "/api/tickets/dispatch/", {
    method: "POST",
    headers: { "idempotency-key": `qtest-hitl2-${notEnabled.submission.id}` },
    body: JSON.stringify({ submissionId: notEnabled.submission.id, force: true }),
  });
  check("unless an admin says so in writing", forced.status === 200, `HTTP ${forced.status}`);
}

async function testAuthBoundaries(cookies) {
  section("10. Identity comes from the session and nowhere else");

  const anon = await fetch(`${BASE}/api/tickets/claim/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ evaluatorId: "00000000-0000-0000-0000-000000000000" }),
  });
  check("an anonymous claim is 401", anon.status === 401, `HTTP ${anon.status}`);

  const student = await api(cookies.student, "/api/tickets/claim/", { method: "POST", body: "{}" });
  check("a student claiming is 403", student.status === 403, `HTTP ${student.status}`);

  const roster = await api(cookies.meera, "/api/tickets/roster/");
  check("an evaluator cannot read the roster", roster.status === 403, `HTTP ${roster.status}`);

  const sweep = await api(cookies.meera, "/api/tickets/sweep/", { method: "POST", body: "{}" });
  check("nor run the sweeper", sweep.status === 403, `HTTP ${sweep.status}`);

  // Scope is not decoration. Every row here is nil-UUID; the seeded admin is an
  // admin of the school scope and must see none of it.
  const foreign = await api(cookies.schoolAdmin, "/api/tickets/roster/");
  check(
    "an admin of another scope sees none of this scope's evaluators",
    foreign.status === 200 && foreign.json.roster.length === 0,
    `${foreign.json?.roster?.length} evaluator(s) visible`,
  );
  const foreignBoard = await api(cookies.schoolAdmin, "/api/tickets/");
  check(
    "nor any of its tickets",
    foreignBoard.status === 200 && (foreignBoard.json.tickets ?? []).length === 0,
    `${foreignBoard.json?.tickets?.length} ticket(s) visible`,
  );
}

// ---------------------------------------------------------------------------

async function main() {
  await startServer();

  try {
    await cleanup();

    const student = await prisma.user.findUnique({
      where: { scopeId_phone: { scopeId: PUBLIC_SCOPE, phone: PHONES.student } },
    });
    if (!student) throw new Error("Seed the database first: npx tsx prisma/seed.ts");

    await upsertUser(PHONES.admin, "Queue Test (Admin)", "ADMIN");
    const qtestScience = await upsertEvaluator({
      phone: PHONES.qtestScience,
      name: "Queue Test (Science)",
      evaluatorType: "SCHOOL_TEACHER",
      maxConcurrent: 8,
      subjects: [{ subject: "Science", classNum: 10 }],
    });
    await upsertEvaluator({
      phone: PHONES.qtestNight,
      name: "Queue Test (Night)",
      evaluatorType: "INTERNAL_TUTOR",
      maxConcurrent: 5,
      subjects: [{ subject: "Social Science", classNum: 9 }],
    });

    const cookies = {
      student: await login(PHONES.student),
      meera: await login(PHONES.meera),
      admin: await login(PHONES.admin),
      schoolAdmin: await login(PHONES.schoolAdmin, SCHOOL_SCOPE),
      qtestScience: await login(PHONES.qtestScience),
    };

    const overnight = await testShiftWrap(cookies.admin);
    await testRouting(cookies.admin, overnight);
    await testConcurrentClaims(cookies, student.id);
    await testSingleTicketRace(cookies, student.id);
    await testMaxConcurrent(cookies, student.id, qtestScience.id);
    await testLeaseSweeper(cookies, student.id);
    await testSupersedeChain(cookies, student.id);
    await testDispatch(cookies, student.id);
    await testAuthBoundaries(cookies);
  } finally {
    await cleanup().catch((err) => console.error("cleanup failed:", err));
    await prisma.$disconnect();
    stopServer();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  stopServer();
  process.exitCode = 1;
});
