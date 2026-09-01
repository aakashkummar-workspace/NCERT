#!/usr/bin/env node
/**
 * The whole student journey, once, end to end.
 *
 *   npx next dev -p 3350                             # in one shell
 *   node scripts/smoke-journey.mjs http://localhost:3350   # in another
 *
 * Twelve features were built in parallel and integrated only by contract — the
 * Prisma schema, the `WrittenHandoff` interface in src/lib/test-attempts.ts,
 * and docs/PLATFORM.md. Every lane tested its own half. This walks the seams
 * *between* them, in the order one student meets them:
 *
 *    1  sign in                     as a Class 10 student
 *    2  sit a dual-track test       Section A auto-marks, Section B hands off
 *    3  photograph the written half create, pages, answers, submit
 *    4  ask for grading             with no ANTHROPIC_API_KEY it must degrade
 *                                   to `queued` and write NOTHING
 *    5  a human marks it            dispatch, claim, review, append, close
 *    6  the student reads the mark   and the supersede chain behind it
 *    7  the mark reaches revision    src/lib/revision.ts
 *    8  a parent asks, the student   consents, and the parent sees a trend and
 *       decides                      not the scan, the transcript or a comment
 *
 * ## One browser, held open across the whole walk
 *
 * Step 2 and steps 3–8 used to be two halves that did not touch. The sitting
 * lives in IndexedDB; the submission lives in Postgres; and the
 * `WrittenHandoff` that documents the seam between them had **no caller
 * anywhere in src/** — `attachScan()` and `attachGrade()` were exported,
 * documented, unit-safe and dead. Four checks were `GAP` lines for it.
 *
 * The seam is closed, and proving it needs the device to stay alive for the
 * whole journey: the sitting's IndexedDB is what a grade has to reach, and it
 * dies with the browser context. So one page is opened at step 1, carrying the
 * student's own session cookie, and every step after that runs against it —
 *
 *    step 2  sits the test, and the finish pushes it to `POST /api/attempts/`
 *    step 3  posts the submission under the `attemptId` that came back
 *    step 7  reopens /revise, where `GradeSync` polls
 *            `GET /api/attempts/{id}/grades/`, and reads the SM-2 card the
 *            teacher's mark landed on
 *
 * — which is the actual product path, not a simulation of one. Nothing here
 * calls `attachGrade()` itself; it waits for the application to.
 *
 * ## Re-runnable
 *
 * Every fixture is created by this run under the `journey-<run>` marker and a
 * random phone, and removed again in a `finally` — `prisma/seed.ts` upserts and
 * never truncates, and other lanes have real work in this database. The one
 * fixture it borrows rather than creates is the seeded evaluator (Meera Iyer,
 * Science 9+10): an `EvaluatorProfile` with qualifications and a roster cannot
 * be provisioned through any route that exists.
 *
 * Exit 0 all green, 1 a failed check or an unclosed gap, 3 the preflight —
 * "I was pointed at the wrong server, and never ran a thing".
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { PrismaClient } from "@prisma/client";
import { preflight } from "./lib/preflight.mjs";

const BASE = (process.argv[2] ?? "http://localhost:3350").replace(/\/+$/, "");
const RUN = randomUUID().slice(0, 8);
const MARKER = `journey-${RUN}`;

/** The seed's evaluator. Ids are derived from stable names, so this holds across reseeds. */
const EVALUATOR_EMAIL = "meera.iyer@example.invalid";
const SEED_PASSWORD = "ncert-dev-2026";
/** Our own fixtures' password. Not the seed's, so a leak of one is not a leak of the other. */
const PASSWORD = "journey-walk-2026";

/**
 * The paper the walk uses. `class10-science-2025-26` q10 is a 2-mark VSA with a
 * hand-authored rubric in data/rubrics.json, so the evaluator gets a real
 * checklist and the parent's chapter signal has a chapter to land in (jesc1 §5).
 */
const PAPER = "class10-science-2025-26";
const QUESTION = 10;
const QUESTION_MAX = 2;
/** Where that question's rubric files a mark - and so which SM-2 card it moves. */
const CHAPTER_BOOK = "jesc1";
const CHAPTER = 5;
/** What the student gave themselves at step 2, before anybody else marked it. */
const SELF_MARKS = 1.5;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function note(line) {
  console.log(`      ${line}`);
}
function step(n, title) {
  console.log(`\n--- ${n}. ${title} ${"-".repeat(Math.max(0, 58 - title.length))}`);
}

// --- HTTP, with a cookie jar per person ------------------------------------

function jar() {
  const store = new Map();
  return {
    header: () => [...store].map(([k, v]) => `${k}=${v}`).join("; "),
    /** The same cookies, in the shape Playwright's `addCookies` wants. */
    forBrowser: (url) => {
      const { hostname } = new URL(url);
      return [...store].map(([name, value]) => ({ name, value, domain: hostname, path: "/" }));
    },
    absorb(res) {
      for (const cookie of res.headers.getSetCookie?.() ?? []) {
        const [pair] = cookie.split(";");
        const eq = pair.indexOf("=");
        store.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    },
  };
}

/**
 * Note the trailing slash on every path below. `next.config.ts` sets
 * `trailingSlash: true`, so `POST /api/x` 308s and `redirect: "manual"` turns
 * that into a visible 308 rather than an invisible empty body.
 */
async function req(who, method, path, { body, form, headers = {} } = {}) {
  const h = { ...headers };
  if (who.header()) h.cookie = who.header();
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: payload, redirect: "manual" });
  who.absorb(res);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const idem = () => ({ "idempotency-key": randomUUID() });

// --- a page to photograph ---------------------------------------------------

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/**
 * A real PNG, 1000x1400, with ruled ink on it.
 *
 * Big enough and sharp enough to clear the capture thresholds in
 * `AnswerCapture`, and a genuine file rather than a stub because
 * `storage.put()` measures the bytes and `imageDimensions()` parses the header:
 * a placeholder would prove the route accepts placeholders.
 */
function answerPage(width = 1000, height = 1400) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const ink = y % 60 < 8 && x % 7 < 4 ? 20 : 235;
      raw[o++] = ink;
      raw[o++] = ink;
      raw[o++] = ink;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
const created = { userIds: [], submissionIds: [] };

/**
 * The student's phone, held open for the whole journey.
 *
 * A dual-track sitting is IndexedDB from end to end, and a grade awarded on
 * the server has to arrive *there* for `/revise` to see it. Closing the
 * browser after step 2 threw the sitting away, which is why the seam could
 * only ever be described rather than walked.
 */
const device = { browser: null, context: null, page: null, errors: [] };

async function openDevice(cookies) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    check("playwright is available for the browser half", false, "npm i -D playwright; step 2 was not walked");
    return false;
  }
  device.browser = await chromium.launch();
  device.context = await device.browser.newContext({ viewport: { width: 390, height: 844 } });
  // The same session the HTTP half is using. Signing in twice would make two
  // students and the journey would join nothing to nothing.
  await device.context.addCookies(cookies);
  device.page = await device.context.newPage();
  device.page.on("pageerror", (e) => device.errors.push(e.message));
  return true;
}

async function closeDevice() {
  if (device.browser) await device.browser.close();
  device.browser = null;
}

async function main() {
  await preflight(BASE, "scripts/smoke-journey.mjs");
  console.log(`run ${RUN}  —  fixtures are removed again at the end\n`);

  const student = jar();
  const admin = jar();
  const evaluator = jar();
  const parent = jar();

  // === 1. an account ======================================================
  step(1, "a Class 10 student gets an account");

  // Through the OTP flow rather than register+login, because the parent link's
  // only join is a phone number and an email account has none. §1 of
  // docs/PLATFORM.md: the role is never claimed, so this is a STUDENT.
  const phone = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const challenge = await req(student, "POST", "/api/auth/otp/request/", { body: { phone } });
  check("OTP request answers with a challenge", challenge.status === 200 && !!challenge.json.challenge, `${challenge.status}`);
  check(
    "the development code is returned rather than sent",
    typeof challenge.json.devCode === "string",
    "devCodeFor() throws in production; this is the dev affordance",
  );

  const verified = await req(student, "POST", "/api/auth/otp/verify/", {
    body: { challenge: challenge.json.challenge, code: challenge.json.devCode, displayName: `Journey ${RUN}`, classNum: 10 },
  });
  check("verifying the code signs the student in", verified.status === 201, `${verified.status}`);
  const studentId = verified.json.user?.id;
  if (studentId) created.userIds.push(studentId);

  const session = await req(student, "GET", "/api/auth/session/");
  check("the session says STUDENT, Class 10", session.json.user?.role === "STUDENT" && session.json.studentProfile?.classNum === 10, `${session.json.user?.role} / class ${session.json.studentProfile?.classNum}`);
  check(
    "a new account is never anything but a student",
    session.json.user?.hitlEnabled === false,
    "hitlEnabled is not claimable from a sign-up body",
  );

  // The other three. `role` is accepted by /api/auth/register/ outside
  // production only, which is what makes this walk possible without four
  // admin-only routes existing first.
  const emails = {
    admin: `${MARKER}-admin@example.invalid`,
    parent: `${MARKER}-parent@example.invalid`,
  };
  for (const [who, role] of [["admin", "ADMIN"], ["parent", "PARENT"]]) {
    const reg = await req(jar(), "POST", "/api/auth/register/", {
      body: { email: emails[who], password: PASSWORD, displayName: `Journey ${role} ${RUN}`, role },
    });
    check(`registering the ${who} answers 201 {ok:true}`, reg.status === 201 && reg.json.ok === true, `${reg.status}`);
  }
  const adminIn = await req(admin, "POST", "/api/auth/login/", { body: { email: emails.admin, password: PASSWORD } });
  const parentIn = await req(parent, "POST", "/api/auth/login/", { body: { email: emails.parent, password: PASSWORD } });
  const evalIn = await req(evaluator, "POST", "/api/auth/login/", { body: { email: EVALUATOR_EMAIL, password: SEED_PASSWORD } });
  for (const id of [adminIn.json.user?.id, parentIn.json.user?.id]) if (id) created.userIds.push(id);
  check("the admin, the parent and the evaluator can all sign in", adminIn.status === 200 && parentIn.status === 200 && evalIn.status === 200, `${adminIn.status}/${parentIn.status}/${evalIn.status}`);
  check(
    "the seeded evaluator is the one the queue knows",
    evalIn.json.user?.role === "EVALUATOR",
    "an EvaluatorProfile cannot be provisioned through any route, so this one is borrowed, not created",
  );
  const parentUserId = parentIn.json.user?.id;

  // === 2. the sitting =====================================================
  step(2, "a dual-track sitting");
  const deviceReady = await openDevice(student.forBrowser(BASE));
  const sitting = deviceReady ? await sitTheTest(device.page) : null;
  if (sitting) {
    check("Section A is marked the moment the paper is submitted", sitting.sectionAMarked, sitting.sectionALine);
    check(
      "every ticked Section B answer gets a WrittenHandoff",
      sitting.handoffs === sitting.ticked && sitting.ticked > 0,
      `${sitting.handoffs} handoffs for ${sitting.ticked} ticked answers`,
    );
    check(
      "finishing writes one SM-2 card per chapter",
      sitting.chapterCards > 0,
      `${sitting.chapterCards} chapter cards, ${sitting.paperCards} per-question fallbacks`,
    );
    // src/lib/test-attempts.ts, on writeRevisionCards: "a student who has only
    // marked half the paper should not be told the other half was wrong". That
    // is what `writtenMarks` returning null for an unscored answer is for - and
    // it did the opposite, because `unattempted` was the *default* status of
    // every Section B row and returned 0. A student who ticked two of nineteen
    // boxes was scheduled to re-revise the other seventeen at confidence
    // "again". There are three statuses now, and only a declared blank is a
    // zero; the state a row starts in is nobody having said anything.
    check(
      "questions the student never touched do not flood the revision queue",
      sitting.paperCards <= sitting.ticked,
      `${sitting.paperCards} per-question cards written for ${sitting.ticked} attempted answers`,
    );
    note(`the sitting's own id is ${JSON.stringify(sitting.attemptId)} — a Dexie key, not a UUID.`);
    note(`its handoff ids are ${JSON.stringify(sitting.handoffIds.slice(0, 2))}…`);

    // The push half of the seam. Finishing a sitting syncs it; the row it
    // writes is keyed on the Dexie id, which is what makes a retry an update
    // rather than a second exam.
    check(
      "finishing the sitting syncs it to the server",
      typeof sitting.serverAttemptId === "string" && sitting.serverAttemptId.length === 36,
      `Attempt.id ${String(sitting.serverAttemptId).slice(0, 8)}… for client id ${sitting.attemptId}`,
    );
    const row = sitting.serverAttemptId
      ? await prisma.attempt.findUnique({
          where: { id: sitting.serverAttemptId },
          include: { questions: true },
        })
      : null;
    check(
      "Attempt.clientAttemptId holds the sitting's own Dexie key",
      row?.clientAttemptId === sitting.attemptId && row?.studentId === studentId,
      `${row?.clientAttemptId}`,
    );
    check(
      "the student on the row came from the session, not the body",
      row?.studentId === studentId,
      "there is no studentId in the sync body at all",
    );
    check(
      "the mark grid is the written half, by the paper's own numbers",
      (row?.questions ?? []).length === sitting.sectionBCount &&
        (row?.questions ?? []).some((q) => q.questionNumber === QUESTION),
      `${row?.questions?.length} AttemptQuestion rows, q${QUESTION} among them`,
    );
    check(
      "a question the student never touched is not recorded as one they skipped",
      (row?.questions ?? []).every((q) => q.attempted),
      "`attempted: false` is a declared blank, and the student declared none",
    );
    check(
      "the sitting's whole score reaches the server, both tracks",
      row?.totalScore !== null && Number(row?.totalScore) === sitting.totalScore,
      `${row?.totalScore} of ${row?.maxMarks}`,
    );
  }

  // === 3. photograph the written half =====================================
  step(3, "the written answers are photographed and submitted");

  const submissionKey = randomUUID();
  // The sitting's server id, exactly as `AnswerCapture` now sends it.
  const attemptId = sitting?.serverAttemptId;
  const create = await req(student, "POST", "/api/submissions/", {
    headers: { "idempotency-key": submissionKey },
    body: { paperSlug: PAPER, attemptId, subject: "Science", classNum: 10, pageCount: 1 },
  });
  check("creating a submission answers 201", create.status === 201 && create.json.created === true, `${create.status}`);
  const submissionId = create.json.submissionId;
  if (submissionId) created.submissionIds.push(submissionId);

  const retry = await req(student, "POST", "/api/submissions/", {
    headers: { "idempotency-key": submissionKey },
    body: { paperSlug: PAPER, attemptId, subject: "Science", classNum: 10, pageCount: 1 },
  });
  check(
    "the retry a dropped connection generates is the same submission",
    retry.json.submissionId === submissionId && retry.json.created === false,
    `${retry.status}`,
  );
  const different = await req(student, "POST", "/api/submissions/", {
    headers: { "idempotency-key": submissionKey },
    body: { paperSlug: PAPER, attemptId, subject: "Science", classNum: 10, pageCount: 4 },
  });
  check(
    "the same key with a different page count is refused, not silently swallowed",
    different.status === 409 && different.json.error?.code === "IDEMPOTENCY_KEY_REUSED",
    `${different.status} ${different.json.error?.code}`,
  );

  const form = new FormData();
  form.set("file", new File([answerPage()], "page-0.png", { type: "image/png" }));
  form.set("pageIndex", "0");
  const page = await req(student, "POST", `/api/submissions/${submissionId}/pages/`, { form });
  check("a photographed page uploads", page.status === 201, `${page.status}`);
  check(
    "size and dimensions are measured server-side, not accepted",
    page.json.widthPx === 1000 && page.json.heightPx === 1400 && page.json.bytes > 0 && !!page.json.sha256,
    `${page.json.widthPx}x${page.json.heightPx}, ${page.json.bytes} bytes`,
  );

  const declared = await req(student, "POST", `/api/submissions/${submissionId}/answers/`, {
    body: { answers: [{ questionNumber: QUESTION, maxMarks: QUESTION_MAX, type: "vsa", pageIndexes: [0] }] },
  });
  check("declaring which pages hold which question works", declared.status === 200 && declared.json.answers?.[0]?.created === true, `${declared.status}`);
  const answerId = declared.json.answers?.[0]?.answerId;

  const submitted = await req(student, "POST", `/api/submissions/${submissionId}/submit/`, { headers: idem() });
  check("submitting joins the queue", submitted.status === 200 && submitted.json.status === "QUEUED", `${submitted.status} ${submitted.json.status}`);
  check(
    "and says out loud that nothing is configured to mark it",
    submitted.json.gradingConfigured === false,
    "there is no ANTHROPIC_API_KEY, and the route admits it rather than letting it be discovered later",
  );

  // The seam, from the submission's side. A photographed page that cannot name
  // the sitting it came out of is a page no grade can find its way back from.
  if (sitting) {
    const bound = await prisma.submission.findUnique({
      where: { id: submissionId },
      select: { attemptId: true },
    });
    check(
      "a submission can be tied back to the sitting that produced it",
      bound?.attemptId === sitting.serverAttemptId,
      `Submission.attemptId ${String(bound?.attemptId).slice(0, 8)}... is the sitting's own Attempt row`,
    );
    const answerRow = await prisma.answer.findUnique({
      where: { id: answerId },
      select: { attemptQuestion: { select: { questionNumber: true, attemptId: true } } },
    });
    check(
      "and the scan is bound to the question it answers, not merely to the exam",
      answerRow?.attemptQuestion?.questionNumber === QUESTION &&
        answerRow?.attemptQuestion?.attemptId === sitting.serverAttemptId,
      `Answer.attemptQuestionId -> q${answerRow?.attemptQuestion?.questionNumber} of the mark grid`,
    );
  }

  // === 4. grading, with no key ============================================
  step(4, "grading is asked for, and must decline honestly");

  const before = await prisma.gradingResult.count({ where: { answer: { submissionId } } });
  const batch = await req(student, "POST", "/api/grading/batch/", {
    headers: idem(),
    body: { submissionIds: [submissionId] },
  });
  check("the grading call answers 200, not an error", batch.status === 200, `${batch.status}`);
  check("it reports itself unconfigured", batch.json.configured === false, JSON.stringify(batch.json.reason ?? batch.json).slice(0, 90));

  const afterCount = await prisma.gradingResult.count({ where: { answer: { submissionId } } });
  check("no GradingResult was written", afterCount === before && afterCount === 0, `${afterCount} rows`);

  const stillQueued = await prisma.submission.findUnique({ where: { id: submissionId }, select: { status: true, gradedAt: true, failureReason: true } });
  check("the submission is still QUEUED — not FAILED, not GRADED", stillQueued?.status === "QUEUED", `${stillQueued?.status}`);
  check("nothing was stamped graded", stillQueued?.gradedAt === null, `${stillQueued?.gradedAt}`);
  check("and it was not marked failed either", stillQueued?.failureReason === null, "nothing was attempted, so nothing failed");

  const seenQueued = await req(student, "GET", `/api/submissions/${submissionId}/`);
  const queuedAnswer = seenQueued.json.submission?.answers?.[0];
  check(
    "the student is shown no mark at all",
    !queuedAnswer?.grade && queuedAnswer?.history?.length === 0,
    "no fabricated grade, no empty-shell revision 0",
  );

  // === 5. a human marks it ================================================
  step(5, "an evaluator claims the ticket and marks the script");

  const unforced = await req(admin, "POST", "/api/tickets/dispatch/", { headers: idem(), body: { submissionId } });
  check(
    "a student not enabled for human review is not routed by accident",
    unforced.status === 409 && unforced.json.error?.code === "CONFLICT",
    `${unforced.status} ${unforced.json.error?.code}`,
  );

  const dispatched = await req(admin, "POST", "/api/tickets/dispatch/", { headers: idem(), body: { submissionId, force: true } });
  check("an admin may route them anyway, in writing", dispatched.status === 200 && dispatched.json.created === true, `${dispatched.status}`);
  const ticketId = dispatched.json.ticket?.id;
  check(
    "subject and class come off the submission row, never the body",
    dispatched.json.ticket?.subject === "Science" && dispatched.json.ticket?.classNum === 10,
    `${dispatched.json.ticket?.subject} / ${dispatched.json.ticket?.classNum}`,
  );
  const again = await req(admin, "POST", "/api/tickets/dispatch/", { headers: idem(), body: { submissionId, force: true } });
  check("routing twice pays one tutor, not two", again.json.ticket?.id === ticketId && again.json.created === false, `${again.status}`);

  const board = await req(evaluator, "GET", "/api/tickets/");
  check(
    "the ticket is on the evaluator's board",
    (board.json.available ?? []).some((t) => t.id === ticketId),
    `${board.json.available?.length} available`,
  );
  check(
    "the board carries no student name or number",
    !JSON.stringify(board.json.available ?? []).includes(`Journey ${RUN}`) && !JSON.stringify(board.json.available ?? []).includes(phone),
    "an evaluator marks a script, not a person",
  );

  const claimed = await req(evaluator, "POST", "/api/tickets/claim/");
  check("claiming takes that ticket, with a lease", claimed.json.claimed === true && claimed.json.ticket?.id === ticketId && !!claimed.json.ticket?.leaseExpiresAt, `${claimed.status}`);

  const canvas = await req(evaluator, "GET", `/api/tickets/${ticketId}/`);
  const canvasAnswer = (canvas.json.answers ?? []).find((a) => a.id === answerId);
  check("the canvas loads the script and the page", canvas.status === 200 && (canvas.json.pages ?? []).length === 1, `${canvas.status}`);
  check(
    "and a rubric checklist, even though no model ever graded it",
    !!canvasAnswer?.checklist?.rubricId && canvasAnswer.checklist.items.length > 0,
    `${canvasAnswer?.checklist?.items?.length ?? 0} lines`,
  );
  const choose = (canvasAnswer?.checklist?.items ?? []).find((i) => i.kind === "CHOOSE");
  check("the page URL is signed at read time", typeof canvas.json.pages?.[0]?.url === "string", "storageKey on the row, never a URL");

  const opened = await req(evaluator, "POST", "/api/reviews/", { headers: idem(), body: { ticketId } });
  check("opening the canvas begins a review pass", opened.status === 200 && !!opened.json.review?.id, `${opened.status}`);
  const reviewId = opened.json.review?.id;
  const reopened = await req(evaluator, "POST", "/api/reviews/", { headers: idem(), body: { ticketId } });
  check("a second tab joins the same pass rather than opening a second", reopened.json.review?.id === reviewId && reopened.json.created === false, `${reopened.status}`);

  const first = await req(evaluator, "POST", `/api/reviews/${reviewId}/grade/`, {
    body: {
      answerId,
      expectedRevision: 0,
      awardedMarks: 1.5,
      comment: "Two strategies named; the second one is thin.",
      criteria: choose ? [{ rubricCriterionId: choose.rubricCriterionId, verdict: "PARTIAL", awarded: 1.5, note: "one fully, one partly" }] : [],
    },
  });
  check("a human verdict is appended as revision 1", first.status === 200 && first.json.revision === 1 && first.json.supersededId === null, `${first.status} rev ${first.json.revision}`);

  const second = await req(evaluator, "POST", `/api/reviews/${reviewId}/grade/`, {
    body: {
      answerId,
      expectedRevision: 1,
      awardedMarks: QUESTION_MAX,
      comment: "On a second read the other strategy stands. Full marks.",
      criteria: choose ? [{ rubricCriterionId: choose.rubricCriterionId, verdict: "HIT", awarded: QUESTION_MAX }] : [],
    },
  });
  check(
    "changing their mind appends revision 2 and supersedes revision 1",
    second.status === 200 && second.json.revision === 2 && second.json.supersededId === first.json.gradingResultId,
    `rev ${second.json.revision} supersedes ${String(second.json.supersededId).slice(0, 8)}`,
  );
  check("the chain is linear and both rows survive", (second.json.chain ?? []).length === 2, `${second.json.chain?.length} rows`);

  const stale = await req(evaluator, "POST", `/api/reviews/${reviewId}/grade/`, {
    body: { answerId, expectedRevision: 1, awardedMarks: 0, criteria: [] },
  });
  check(
    "an evaluator looking at a stale revision is refused, not merged",
    stale.status === 409 && stale.json.error?.code === "CONFLICT",
    `${stale.status} ${stale.json.error?.code}`,
  );

  const closed = await req(evaluator, "POST", `/api/reviews/${reviewId}/submit/`, {
    headers: idem(),
    body: { notes: `journey ${RUN}`, timeSpentSec: 90 },
  });
  check("closing the pass completes the ticket", closed.status === 200 && closed.json.completed === true, `${closed.status}`);
  check("agreement with the model is measured, not asserted", closed.json.review?.agreedWithAi === false, "this pass appended its own revision");

  // === 6. what the student sees ===========================================
  step(6, "the student reads the mark, and where it came from");

  const seen = await req(student, "GET", `/api/submissions/${submissionId}/`);
  const marked = seen.json.submission?.answers?.find((a) => a.answerId === answerId);
  check("the submission reads GRADED", seen.json.submission?.status === "GRADED", `${seen.json.submission?.status}`);
  check(
    "the current mark is the teacher's latest",
    marked?.grade?.source === "HUMAN" && marked.grade.revision === 2 && marked.grade.awardedMarks === QUESTION_MAX,
    `${marked?.grade?.source} rev ${marked?.grade?.revision}, ${marked?.grade?.awardedMarks}/${marked?.grade?.maxMarks}`,
  );
  check("it names who awarded it", marked?.grade?.evaluator === "Meera Iyer", `${marked?.grade?.evaluator}`);
  check(
    "the earlier verdict is on the page, not quietly replaced",
    (marked?.history ?? []).length === 1 && marked.history[0].revision === 1 && marked.history[0].awardedMarks === 1.5,
    `history: ${(marked?.history ?? []).map((h) => `${h.source} ${h.awardedMarks}`).join(" -> ")}`,
  );
  note("with no ANTHROPIC_API_KEY there is no AI draft to head the chain, so it reads");
  note(`"your teacher 1.5/2 -> your teacher 2/2" rather than "AI -> your teacher". The`);
  note("chain machinery itself — supersedesId, revision, both rows kept — is proved above.");

  // The marking scheme beside the mark. This is what makes a grade arguable
  // rather than authoritative, and it only appears if the grade names a rubric.
  check(
    "the marking scheme's own words are printed beside the mark",
    !!marked?.rubric?.externalId && (marked.rubric.scheme ?? []).length > 0,
    marked?.rubric ? `${marked.rubric.externalId}, ${marked.rubric.scheme.length} scheme lines` : "no rubric on the grade",
  );

  const stranger = await req(evaluator, "GET", `/api/submissions/${submissionId}/pages/`);
  check(
    "the evaluator who reviewed it may still read the script",
    stranger.status === 200,
    "claimed, assigned, or already reviewed — not any submission",
  );

  // === 7. does it reach revision? =========================================
  step(7, "the graded answer reaches the revision schedule");

  const callers = handoffCallers();
  check(
    "the handoff contract has a caller at all",
    callers > 0,
    `attachGrade() / attachScan() / pendingHandoffs() are used in ${callers} file(s) outside src/lib/test-attempts.ts`,
  );

  // The pull half. Nothing here calls attachGrade(); it opens the screen the
  // student would open and waits for the application to do it. /revise mounts
  // GradeSync, which asks GET /api/attempts/{id}/grades/ and writes the answer
  // onto the handoff — the path attachGrade() documents as safe after the
  // sitting has ended.
  let afterGrade = null;
  let gradedHandoff = null;
  let chapterCardAfter = null;
  if (sitting && device.page) {
    await device.page.goto(`${BASE}/revise/`, { waitUntil: "networkidle", timeout: 120_000 });
    afterGrade = await waitFor(
      device.page,
      (a) => Boolean(a?.sectionB?.find((w) => w.n === QUESTION)?.handoff?.grade),
      30_000,
    );
    gradedHandoff = afterGrade?.sectionB?.find((w) => w.n === QUESTION)?.handoff ?? null;
    const cards = await readAll(device.page, "ncert-revision", "cards");
    chapterCardAfter = cards.find((c) => c.id === `exercise:${CHAPTER_BOOK}:${CHAPTER}`) ?? null;
  }

  check(
    "a grade awarded on the server reaches the sitting on the device",
    gradedHandoff?.grade?.awarded === QUESTION_MAX && gradedHandoff?.grade?.source === "teacher",
    `handoff ${gradedHandoff?.id}: ${gradedHandoff?.grade?.source} ${gradedHandoff?.grade?.awarded}/${gradedHandoff?.grade?.maxMarks}`,
  );
  check(
    "the photograph is attached to the same handoff, by the same route",
    gradedHandoff?.scanId === answerId,
    "attachScan() is called with the Answer id - one question's worth of handwriting",
  );
  check(
    "the teacher's mark supersedes the student's own on the sitting's total",
    typeof afterGrade?.totalScore === "number" &&
      Math.abs(afterGrade.totalScore - (sitting?.totalScore ?? 0) - (QUESTION_MAX - SELF_MARKS)) < 1e-9,
    `${sitting?.totalScore} -> ${afterGrade?.totalScore} (self ${SELF_MARKS} -> teacher ${QUESTION_MAX})`,
  );
  check(
    "and reaches src/lib/revision.ts, on the chapter the rubric files it under",
    chapterCardAfter?.bookCode === CHAPTER_BOOK &&
      chapterCardAfter?.chapter === CHAPTER &&
      typeof chapterCardAfter?.lastScore === "number" &&
      Math.abs(
        chapterCardAfter.lastScore -
          (sitting?.chapterCardBefore?.lastScore ?? 0) -
          (QUESTION_MAX - SELF_MARKS),
      ) < 1e-9,
    `card ${chapterCardAfter?.id}: ${sitting?.chapterCardBefore?.lastScore} -> ${chapterCardAfter?.lastScore} / ${chapterCardAfter?.maxMarks}`,
  );
  // The same fact, read off the database rather than the phone. `prisma/README.md`
  // says the self-marked and graded paths converge on this row; this is that
  // sentence as an assertion.
  const gridRow = sitting?.serverAttemptId
    ? await prisma.attemptQuestion.findUnique({
        where: {
          attemptId_questionNumber: {
            attemptId: sitting.serverAttemptId,
            questionNumber: QUESTION,
          },
        },
      })
    : null;
  check(
    "the mark grid row carries both marks, the student's and the teacher's",
    Number(gridRow?.selfScore) === SELF_MARKS && Number(gridRow?.awardedMarks) === QUESTION_MAX,
    `selfScore ${gridRow?.selfScore}, awardedMarks ${gridRow?.awardedMarks}`,
  );
  check(
    "a re-sync never lets the device overwrite a mark the server awarded",
    Number(gridRow?.awardedMarks) === QUESTION_MAX,
    "the sync body has no awardedMarks field at all",
  );
  check(
    "the card's confidence is the one this sitting earned, and is not re-rated",
    chapterCardAfter?.lastConfidence === sitting?.chapterCardBefore?.lastConfidence,
    `${chapterCardAfter?.lastConfidence} — the band moves on the next honest review, not on a late mark`,
  );
  check(
    "a late grade does not advance the SM-2 schedule a second time",
    chapterCardAfter?.dueAt === sitting?.chapterCardBefore?.dueAt &&
      chapterCardAfter?.repetitions === sitting?.chapterCardBefore?.repetitions,
    "the card already reflects this sitting; re-reviewing it would push a chapter away for free",
  );

  // === 8. the parent ======================================================
  step(8, "a parent asks, the student decides");

  const asked = await req(parent, "POST", "/api/parent/links/", { headers: idem(), body: { studentPhone: phone } });
  check("the request is accepted", asked.status === 200 && asked.json.ok === true, `${asked.status}`);
  check(
    "and discloses nothing about who it matched",
    !("count" in (asked.json ?? {})) && !JSON.stringify(asked.json).includes(studentId),
    "no count, no ids — the same answer for a number nobody holds",
  );

  const noConsentYet = await req(parent, "GET", `/api/parent/overview/?studentId=${studentId}`);
  check(
    "before consent the parent can read nothing",
    noConsentYet.status === 403,
    `${noConsentYet.status} ${noConsentYet.json.error?.code}`,
  );

  const inbox = await req(student, "GET", "/api/parent/links/");
  const request = (inbox.json.requests ?? []).find((r) => r.parentUserId === parentUserId);
  check("the student sees who is asking", !!request && request.status === "PENDING", `${request?.status}`);
  check("with the request's whole history", (request?.history ?? []).some((h) => h.type === "REQUESTED"), `${request?.history?.length} entries`);

  const consent = await req(student, "POST", "/api/parent/consent/", { headers: idem(), body: { parentUserId, decision: "GRANT" } });
  check("granting turns the request into access", consent.status === 200 && consent.json.status === "ACTIVE", `${consent.status}`);

  const overview = await req(parent, "GET", `/api/parent/overview/?studentId=${studentId}`);
  check("the dashboard loads", overview.status === 200, `${overview.status}`);
  check("it names the child it is about", overview.json.child?.id === studentId, `${overview.json.child?.displayName}`);

  const chapter = (overview.json.chapters ?? []).find((c) => c.bookCode === "jesc1" && c.chapter === 5);
  check(
    "the graded answer shows up as a chapter signal",
    !!chapter && chapter.answersGraded === 1,
    chapter ? `${chapter.label}: band ${chapter.band}, ${chapter.answersGraded} graded` : "no chapter signal at all",
  );
  check(
    "chapter difficulty is a band, never a figure",
    !!chapter && typeof chapter.band === "string" && !("fraction" in chapter) && !("awarded" in chapter),
    "\"why did you get 40% in chapter 6\" is one number away at all times",
  );

  const payload = JSON.stringify(overview.json);
  check("no scan or page URL reaches the parent", !/storageKey|"url"|\.png|signature=/.test(payload), "");
  check("no transcript, comment or answer text reaches the parent", !/transcript|comment|On a second read/.test(payload), "");
  check("no evaluator is named to the parent", !payload.includes("Meera"), "");
  check("no submission or answer id reaches the parent", !payload.includes(submissionId) && !payload.includes(answerId), "");

  const peeking = await req(parent, "GET", `/api/submissions/${submissionId}/`);
  check(
    "a parent asking for the script directly gets a 404, not a 403",
    peeking.status === 404,
    "a 403 that distinguishes 'not yours' from 'does not exist' is a membership oracle",
  );
  const peekingPages = await req(parent, "GET", `/api/submissions/${submissionId}/pages/`);
  check("nor can they reach the pages", peekingPages.status === 404, `${peekingPages.status}`);

  const revoked = await req(student, "POST", "/api/parent/consent/", { headers: idem(), body: { parentUserId, decision: "REVOKE" } });
  const afterRevoke = await req(parent, "GET", `/api/parent/overview/?studentId=${studentId}`);
  check(
    "revoking takes effect on the parent's very next request",
    revoked.json.status === "REVOKED" && afterRevoke.status === 403,
    `${revoked.json.status}, then ${afterRevoke.status}`,
  );

  // Trend, which is the other half of what step 8 asks for. Both halves are
  // built from Attempt rows, so both were empty for every student on the
  // platform until something wrote one.
  const trend = (overview.json.subjects ?? []).find((t) => t.subject === "Science");
  check(
    "the parent sees a subject trend",
    !!trend && trend.papers >= 1 && typeof trend.recent === "number",
    trend ? `Science: ${trend.papers} paper(s), recent ${trend.recent}` : "subjects[] is empty",
  );
  check(
    "and how much work went in, by week",
    (overview.json.effort?.weeks ?? []).some((w) => w.sessions >= 1),
    `${(overview.json.effort?.weeks ?? []).length} week(s) of effort`,
  );
  check(
    "so the dashboard no longer says a working child has not started",
    !JSON.stringify(overview.json.recommendations ?? []).includes("has not started"),
    "a graded chapter and \"has not started using the app yet\" cannot both be on one screen",
  );
}

/**
 * Step 2, in a real browser, because there is no other way to reach it: the
 * sitting is IndexedDB from end to end and has no HTTP surface of its own.
 *
 * The page is the one held open for the whole journey — see `device`. Returns
 * null, with a FAIL recorded, rather than throwing, so that one broken step
 * does not take the other seven down with it.
 */
async function sitTheTest(page) {
  const errors = device.errors;

  try {
    await page.goto(`${BASE}/test/${PAPER}/`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.getByRole("button", { name: /^Start/ }).click();
    await page.waitForSelector('[role="group"]', { timeout: 30_000 });

    // Section A: the first option on every question. The score is whatever it
    // deserves — this suite is checking that marking happens, not that the
    // right answer is A. scripts/smoke-quiz.mjs is where marking is proved.
    const groups = page.locator('[role="group"]');
    const total = await groups.count();
    for (let i = 0; i < total; i++) await groups.nth(i).locator("button").first().click();

    await page.getByRole("button", { name: /^Section B/ }).click();
    await page.waitForTimeout(400);
    const boxes = page.locator('input[type="checkbox"]');
    const ticked = 2;
    await boxes.nth(0).check();
    await boxes.nth(7).check();
    await page.waitForTimeout(300);

    await page.getByRole("button", { name: /Submit and score/ }).click();
    await page.getByRole("button", { name: /Yes, submit/ }).click();
    await page.waitForSelector("text=/Section A marked/", { timeout: 30_000 });
    const sectionALine = (await page.locator("text=/Section A marked: \\d+ \\/ \\d+/").first().textContent())?.trim() ?? "";

    // Self-mark the two written answers, then finish, which is what writes the
    // SM-2 cards.
    await page.getByRole("button", { name: "My marks" }).click();
    await page.waitForTimeout(400);
    await page.getByLabel(`Marks for question ${QUESTION}`).fill(String(SELF_MARKS));
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Finish" }).click();
    await page.waitForTimeout(1500);

    // The sync is fire-and-forget by design — a student must never wait on a
    // network to finish an exam — so the id it writes back arrives a moment
    // after Finish returns.
    const attempt = await waitFor(page, (a) => Boolean(a?.serverAttemptId), 20_000);
    const cards = await readAll(page, "ncert-revision", "cards");
    const handoffs = (attempt?.sectionB ?? []).filter((w) => w.status === "written").map((w) => w.handoff);

    if (errors.length) check("no uncaught page error during the sitting", false, errors.slice(0, 2).join(" | "));

    return {
      attemptId: attempt?.id,
      serverAttemptId: attempt?.serverAttemptId,
      totalScore: attempt?.totalScore,
      sectionBCount: (attempt?.sectionB ?? []).length,
      sectionAMarked: /Section A marked: \d+ \/ \d+/.test(sectionALine) && attempt?.sectionAMarks !== undefined,
      sectionALine,
      ticked,
      handoffs: handoffs.length,
      handoffIds: handoffs.map((h) => h.id),
      chapterCards: cards.filter((c) => c.sourceType === "exercise" && c.bookCode).length,
      paperCards: cards.filter((c) => c.sourceType === "paper").length,
      /** The chapter card the graded answer will land in, before it is graded. */
      chapterCardBefore: cards.find((c) => c.id === `exercise:${CHAPTER_BOOK}:${CHAPTER}`) ?? null,
    };
  } catch (err) {
    check("the dual-track sitting can be walked in a browser", false, String(err).slice(0, 160));
    return null;
  }
}

/** Poll the sitting in IndexedDB until `ready`, or give up and return it anyway. */
async function waitFor(page, ready, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let attempt = await readOne(page, "ncert-tests", "attempts");
  while (!ready(attempt) && Date.now() < until) {
    await page.waitForTimeout(500);
    attempt = await readOne(page, "ncert-tests", "attempts");
  }
  return attempt;
}

function readAll(page, dbName, store) {
  return page.evaluate(
    ([dbName, store]) =>
      new Promise((resolve) => {
        const open = indexedDB.open(dbName);
        open.onsuccess = () => {
          let tx;
          try {
            tx = open.result.transaction(store, "readonly");
          } catch {
            return resolve([]);
          }
          const all = tx.objectStore(store).getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => resolve([]);
        };
        open.onerror = () => resolve([]);
      }),
    [dbName, store],
  );
}
async function readOne(page, dbName, store) {
  const rows = await readAll(page, dbName, store);
  return rows[0];
}

/** How many places outside its own module use the handoff contract. */
function handoffCallers() {
  try {
    const out = execFileSync(
      "git",
      // `--untracked`, because the file that closes this seam is a *new* file
      // and git grep would not see it until it was committed - which would have
      // this answer "still dead" about code sitting right there.
      ["grep", "-l", "--untracked", "-E", "attachGrade|attachScan|pendingHandoffs|findHandoff", "--", "src"],
      { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
    );
    return out.split("\n").filter((f) => f && !f.endsWith("src/lib/test-attempts.ts")).length;
  } catch {
    return 0; // git grep exits 1 when nothing matches.
  }
}

/**
 * Take the fixtures back out. `User` cascades to attempts, submissions, pages,
 * answers, grades and tickets, so deleting the three accounts is almost all of
 * it; the photographs live outside the database and are removed by hand.
 */
async function cleanup() {
  for (const id of created.submissionIds) {
    rmSync(path.resolve(process.cwd(), ".storage", "submissions", id), { recursive: true, force: true });
  }
  if (created.userIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  }
  // Belt and braces: anything this run named, whether or not we kept the id.
  await prisma.user.deleteMany({ where: { email: { startsWith: MARKER } } });
}

let failed = 1;
try {
  await main();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  if (bad.length) {
    console.log("\nStill failing:");
    for (const b of bad) console.log(`  FAIL  ${b.name}`);
  }
  failed = bad.length === 0 ? 0 : 1;
} catch (err) {
  console.error(err);
  failed = 1;
} finally {
  try {
    await closeDevice();
  } catch {
    // A browser that will not close is not a reason to skip the cleanup below.
  }
  try {
    await cleanup();
    console.log(`\nfixtures for run ${RUN} removed`);
  } catch (err) {
    console.error(`\ncleanup failed for run ${RUN} — fixtures may be left behind:`, err?.message ?? err);
  }
  await prisma.$disconnect();
}
process.exit(failed);
