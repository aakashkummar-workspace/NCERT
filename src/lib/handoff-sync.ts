"use client";

/**
 * The device half of the seam: it carries a finished sitting up to the server,
 * and carries scans and marks back down onto the `WrittenHandoff` rows that
 * were designed to receive them.
 *
 * `src/lib/test-attempts.ts` documents `attachScan()` and `attachGrade()` as
 * the two writers another lane calls. Until this file existed, nothing did:
 * grading worked, the SM-2 engine worked, and a teacher's mark could not reach
 * `/revise` because nothing joined them. This is the join, and it is
 * deliberately the *only* thing that knows both sides — the store below it has
 * no idea there is a server, and the routes above it have no idea there is an
 * IndexedDB.
 *
 * ## Nothing here may affect a sitting
 *
 * A student mid-exam on no network is the normal case, not the edge case. So:
 *
 *  - **Every call is after the fact.** The sync runs when a sitting is finished
 *    and whenever the app is idle enough to poll. Nothing in the exam path
 *    awaits it, and `DualTrackTest` does not block Finish on it.
 *  - **Every failure is silent and retried later.** `fetch` rejects offline;
 *    the server may 500; the session may have expired into a 401. All three are
 *    "not now" and none of them may lose a mark, so every one of them is caught
 *    and the sitting in IndexedDB is left exactly as it was. The next call
 *    picks up where this one stopped, because the server keys on
 *    `clientAttemptId` and a re-sync is an update rather than a second exam.
 *  - **Nothing is deleted, ever.** The device is the record of truth for a
 *    sitting. The server is a copy that makes a teacher's mark reachable.
 *
 * ## The cadence
 *
 * `pullGrades()` is a poll, and a poll that runs forever on a phone is a
 * battery bug. `syncPending()` returns how much is still outstanding, and
 * `GradeSync` stops the timer the moment that reaches zero. There is nothing to
 * poll for on a sitting where every written answer is already graded.
 *
 * ## Two kinds of sitting, one route
 *
 * There are two exam flows on this device and they are not the same shape:
 *
 *  - a **dual-track test** (`src/lib/test-attempts.ts`) — Section A marked by
 *    the app, Section B written on paper and handed off to be marked elsewhere.
 *    Pushed *and* polled.
 *  - a **practice paper** (`src/lib/attempts.ts`) — the original timed run at a
 *    CBSE sample paper, self-marked from end to end. Pushed only.
 *
 * Both land on `POST /api/attempts/` as `Attempt` + `AttemptQuestion`, because
 * both are the same fact — this student sat this paper and these are the marks
 * — and everything downstream (the parent's subject trend, an `Answer` bound to
 * the question it answers, a teacher's mark) is written against that pair. A
 * second path would be a second copy of the idempotency argument, the offline
 * argument and the "the server never overwrites a teacher's mark" argument.
 * `syncPracticeAttempt()` below is the whole of the difference.
 */
import {
  allAttempts as allPracticeAttempts,
  markSynced as markPracticeSynced,
  type Attempt as PracticeAttempt,
} from "./attempts";
import { getPaper, questionsFor, type PaperQuestion } from "./papers";
import {
  allTestAttempts,
  attachGrade,
  attachScan,
  findHandoff,
  handoffId,
  pendingHandoffs,
  setServerAttemptId,
  writtenMarks,
  type TestAttempt,
  type WrittenGrade,
} from "./test-attempts";

/** What one poll found, for a caller deciding whether to poll again. */
export interface SyncOutcome {
  /** Sittings pushed to the server this run — practice papers and tests both. */
  synced: number;
  /** Handoffs that gained a scan or a grade this run. */
  attached: number;
  /**
   * Written answers still waiting for a mark, across every synced sitting.
   * Zero means there is nothing left to poll for.
   */
  pending: number;
}

const EMPTY: SyncOutcome = { synced: 0, attached: 0, pending: 0 };

/** JSON, or null. A rejection is "not now", never an exception a caller sees. */
async function json<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface SyncResponse {
  attemptId: string;
  created: boolean;
}

interface GradesResponse {
  questions: {
    questionNumber: number;
    scanId: string;
    grade?: {
      awarded: number;
      maxMarks: number;
      gradedAt: number;
      source: "rubric" | "teacher";
      rubricId?: string;
      variant?: string;
      needsReview?: boolean;
      steps?: { stepId: string; outcome: "hit" | "partial" | "miss" | "unmarked"; awarded: number }[];
    } | null;
  }[];
}

/**
 * Push one sitting to the server and remember what it came back as.
 *
 * The body is the written half of the sitting plus the sitting's own totals:
 * `AttemptQuestion.questionNumber` is the paper's printed number, which is what
 * an uploaded answer is later matched on. Section A is not a paper question and
 * is folded into `totalScore` instead — see the note on the route.
 *
 * Returns the server's `Attempt.id`, or null if it could not be reached. Never
 * throws.
 */
export async function syncAttempt(attempt: TestAttempt): Promise<string | null> {
  const body = {
    clientAttemptId: attempt.id,
    paperSlug: attempt.paperSlug,
    subject: attempt.subject,
    classNum: attempt.classNum,
    maxMarks: Math.round(attempt.maxMarks),
    startedAt: new Date(attempt.startedAt).toISOString(),
    durationMs: attempt.durationMs,
    submittedAt: attempt.submittedAt ? new Date(attempt.submittedAt).toISOString() : undefined,
    status: attempt.status,
    totalScore: attempt.totalScore,
    questions: attempt.sectionB.map((w) => {
      const marks = writtenMarks(w);
      return {
        questionNumber: w.n,
        maxMarks: w.maxMarks,
        type: w.type ?? "sa",
        sectionLabel: w.section,
        topic: w.topic,
        // `selfScore` is the student's own mark and nothing else. A grade the
        // server awarded is already the server's; sending it back would be this
        // device telling the grading lane what it decided.
        selfScore: w.handoff.grade ? (w.selfMarks ?? undefined) : (marks ?? undefined),
        // False only where the student *said* they left it blank. A question
        // nobody touched is not a question the student skipped.
        attempted: w.status !== "skipped",
      };
    }),
  };

  const result = await json<SyncResponse>("/api/attempts/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!result?.attemptId) return null;
  await setServerAttemptId(attempt.id, result.attemptId);
  return result.attemptId;
}

// --- the practice paper, which is the other kind of sitting -----------------

/**
 * A timed practice paper is entirely self-marked, and that is the honest map.
 *
 * `src/lib/attempts.ts` is the original flow and the one students use most: the
 * clock runs, they write on paper, then they mark themselves against the
 * official scheme. Its `QuestionScore` carries `score` and `maxMarks` per
 * question and nothing else, which is exactly what `AttemptQuestion.selfScore`
 * and `maxMarks` are for. So the mapping is one-to-one and needs no invention:
 *
 *   QuestionScore.n         -> AttemptQuestion.questionNumber
 *   QuestionScore.maxMarks  -> AttemptQuestion.maxMarks
 *   QuestionScore.score     -> AttemptQuestion.selfScore   (null = unscored)
 *   QuestionScore.attempted -> AttemptQuestion.attempted
 *
 * ### What is deliberately *not* mapped
 *
 *  - **No `WrittenHandoff`, and no scan.** A practice paper has no Section A/B
 *    split and no "I wrote this one" tick: the student never claimed to have a
 *    page for anybody to photograph. Writing handoffs here would put questions
 *    into `sittingsAwaitingScan()` that the student never offered, and put a
 *    permanent `pending` on the poll that nothing could ever clear. Every
 *    question in the grid is a paper question, so all of it is sent — and none
 *    of it is claimed to be awaiting a mark.
 *  - **No `awardedMarks`.** As on the dual-track path, that column belongs to
 *    the grading lane. This body has no field for it at all.
 *  - **Nothing is pulled back.** `pullGrades()` writes onto handoffs, and there
 *    are none. A practice paper is push-only, which is why it adds nothing to
 *    `SyncOutcome.pending` and so cannot keep `GradeSync`'s timer alive.
 *
 * `type`, `sectionLabel` and `topic` are not in the store, because the store is
 * about marks and the clock. They come from `data/papers.json`, which is baked
 * in at build time and so is available with no network — the same place
 * `ScoringGrid` reads them from, so a question cannot be typed one way on the
 * screen and another on the server.
 */
function practiceBody(attempt: PracticeAttempt) {
  const paper = getPaper(attempt.paperSlug);
  const meta = new Map<number, PaperQuestion>(
    paper ? questionsFor(paper).map((q) => [q.n, q]) : [],
  );
  return {
    clientAttemptId: attempt.id,
    paperSlug: attempt.paperSlug,
    subject: attempt.subject,
    classNum: attempt.classNum,
    maxMarks: Math.round(attempt.maxMarks),
    startedAt: new Date(attempt.startedAt).toISOString(),
    durationMs: attempt.durationMs,
    submittedAt: attempt.submittedAt ? new Date(attempt.submittedAt).toISOString() : undefined,
    status: attempt.status,
    totalScore: attempt.totalScore,
    questions: attempt.scores.map((q) => {
      const from = meta.get(q.n);
      return {
        questionNumber: q.n,
        maxMarks: q.maxMarks,
        // A paper whose slug is not in the manifest cannot have been sat, since
        // `startAttempt` is only ever called with one. The fallback exists so a
        // stale attempt left by an older manifest still syncs rather than 400s.
        type: from?.type ?? ("sa" as const),
        sectionLabel: from?.section.slice(0, 8),
        topic: from?.topic?.slice(0, 60),
        // Null is "nobody has scored this yet", not zero. Sending a zero would
        // tell a parent the student got it wrong when they simply stopped
        // marking half way.
        selfScore: q.score ?? undefined,
        attempted: q.attempted,
      };
    }),
  };
}

/**
 * Push one practice paper. Returns the server's `Attempt.id`, or null if it
 * could not be reached. Never throws — offline, 401 and 500 are all "not now".
 */
export async function syncPracticeAttempt(attempt: PracticeAttempt): Promise<string | null> {
  const result = await json<SyncResponse>("/api/attempts/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(practiceBody(attempt)),
  });
  if (!result?.attemptId) return null;
  try {
    await markPracticeSynced(attempt.id, result.attemptId, attempt.totalScore ?? null);
  } catch {
    // The push landed; only the note that it did was lost. The next pass sends
    // the same body under the same `clientAttemptId` and the server upserts the
    // same row, so the cost of a failed write here is one duplicate request —
    // never a lost sitting, and never a rejected promise reaching a caller that
    // fired this and walked away.
  }
  return result.attemptId;
}

/**
 * Every finished practice paper the server does not yet hold, or holds at a
 * stale total. Returns how many were pushed.
 *
 * Only *submitted* papers, for the same reason the dual-track pass gives: a
 * paper still running is an exam in progress. A submitted paper that has not
 * been self-marked yet is still pushed — it is a real sitting, it is real
 * effort, and a parent being shown "sat, not yet marked" is honest where being
 * shown nothing is not.
 */
async function pushPracticeAttempts(): Promise<number> {
  let attempts: PracticeAttempt[];
  try {
    attempts = await allPracticeAttempts();
  } catch {
    return 0;
  }

  let synced = 0;
  for (const attempt of attempts) {
    if (attempt.status !== "submitted") continue;
    const total = attempt.totalScore ?? null;
    if (attempt.serverAttemptId && attempt.syncedTotalScore === total) continue;
    // Offline. Leave the record exactly as it is and try again next pass.
    if (await syncPracticeAttempt(attempt)) synced++;
  }
  return synced;
}

/**
 * Read one sitting's scans and marks back and write them onto its handoffs.
 *
 * `handoffId(attemptId, questionNumber)` is the whole of the addressing: the
 * paper's printed number is the same number the rubric, the marking scheme and
 * the student's page all use, so a mark cannot land on the wrong question.
 *
 * Both writers are idempotent, but `attachGrade` re-runs the revision write, so
 * a grade that has not changed is not re-applied — otherwise every poll would
 * re-total the sitting and churn the SM-2 schedule.
 */
export async function pullGrades(attempt: TestAttempt): Promise<number> {
  if (!attempt.serverAttemptId) return 0;
  const result = await json<GradesResponse>(
    `/api/attempts/${attempt.serverAttemptId}/grades/`,
  );
  if (!result?.questions) return 0;

  let attached = 0;
  for (const q of result.questions) {
    const id = handoffId(attempt.id, q.questionNumber);
    const handoff = await findHandoff(id);
    if (!handoff) continue;

    if (q.scanId && handoff.scanId !== q.scanId) {
      await attachScan(id, q.scanId);
      attached++;
    }

    if (!q.grade) continue;
    const current = handoff.grade;
    // Same mark, same moment, same author: already applied. `gradedAt` is the
    // grading row's own timestamp, and grading is append-only, so a new verdict
    // always carries a later one.
    if (
      current &&
      current.awarded === q.grade.awarded &&
      current.gradedAt === q.grade.gradedAt &&
      current.source === q.grade.source
    ) {
      continue;
    }
    const grade: WrittenGrade = {
      awarded: q.grade.awarded,
      maxMarks: q.grade.maxMarks,
      gradedAt: q.grade.gradedAt,
      source: q.grade.source,
      rubricId: q.grade.rubricId,
      variant: q.grade.variant,
      needsReview: q.grade.needsReview,
      steps: q.grade.steps,
    };
    await attachGrade(id, grade);
    attached++;
  }
  return attached;
}

/**
 * One pass: push what has not been pushed, pull what has been marked.
 *
 * Only *finished* sittings are pushed. A sitting in progress is an exam in
 * progress, and the server has no business holding half of one — nothing
 * downstream can use it, and an interrupted upload during an exam is exactly
 * the thing this module must never cause.
 *
 * Both kinds of sitting go up here. A practice paper is pushed first and never
 * polled: it has no written handoff, so it contributes to `synced` and never to
 * `pending` — which is what keeps `GradeSync`'s timer stopping when there is
 * genuinely nothing left to wait for. A practice paper that cannot be pushed is
 * also not a reason to skip the dual-track half, so its failures stay inside
 * `pushPracticeAttempts`.
 */
export async function syncPending(): Promise<SyncOutcome> {
  const practice = await pushPracticeAttempts();

  let attempts: TestAttempt[];
  try {
    attempts = await allTestAttempts();
  } catch {
    return { ...EMPTY, synced: practice };
  }

  let synced = practice;
  let attached = 0;
  /** Sittings the server now knows about, by their Dexie key. */
  const onServer = new Set<string>();

  for (const attempt of attempts) {
    if (attempt.status !== "submitted") continue;
    // Nothing to say about a sitting with no written half, and nothing to poll.
    if (!attempt.sectionB.some((w) => w.status === "written")) continue;

    let current = attempt;
    if (!current.serverAttemptId) {
      const serverId = await syncAttempt(current);
      if (!serverId) continue; // Offline. Try again next pass; lose nothing.
      synced++;
      current = { ...current, serverAttemptId: serverId };
    }
    onServer.add(current.id);

    const landed = await pullGrades(current);
    attached += landed;
    // A grade that landed moved the sitting's total, and the parent
    // dashboard's subject trend is built from `Attempt.totalScore`. Push the
    // new total rather than leaving the server holding the self-marked one.
    if (landed > 0) {
      const fresh = (await allTestAttempts()).find((a) => a.id === current.id);
      if (fresh && (await syncAttempt(fresh))) synced++;
    }
  }

  let pending = 0;
  try {
    // Only a handoff on a sitting the server knows about is worth polling for.
    // One on an unsynced sitting is waiting on the *push*, which the next pass
    // retries anyway.
    const waiting = await pendingHandoffs();
    pending = waiting.filter((h) => onServer.has(h.attemptId)).length;
  } catch {
    pending = 0;
  }

  return { synced, attached, pending };
}

// --- what the capture screen needs ----------------------------------------

/** One finished sitting with written answers still to photograph. */
export interface ScannableSitting {
  /** The Dexie key. */
  clientAttemptId: string;
  /** The server's `Attempt.id`, once the sitting has been synced. */
  serverAttemptId?: string;
  title: string;
  paperSlug: string;
  subject: string;
  classNum: 9 | 10;
  startedAt: number;
  submittedAt?: number;
  /** The questions the student said they wrote and nobody has graded. */
  questions: {
    n: number;
    maxMarks: number;
    type: NonNullable<TestAttempt["sectionB"][number]["type"]>;
    /** Already photographed once; re-uploading replaces rather than adds. */
    scanned: boolean;
  }[];
}

/**
 * Finished sittings whose written half is still waiting on a photograph.
 *
 * This is what turns "upload some pages" into "upload *this exam*": the numbers
 * the student ticked in Section B are the numbers the paper prints, which is
 * what `POST /api/submissions/{id}/answers/` matches an answer on and what
 * binds a scan to the mark-grid row it answers.
 */
export async function sittingsAwaitingScan(): Promise<ScannableSitting[]> {
  let attempts: TestAttempt[];
  try {
    attempts = await allTestAttempts();
  } catch {
    return [];
  }
  return attempts
    .filter((a) => a.status === "submitted")
    .map((a) => ({
      clientAttemptId: a.id,
      serverAttemptId: a.serverAttemptId,
      title: a.title,
      paperSlug: a.paperSlug,
      subject: a.subject,
      classNum: a.classNum,
      startedAt: a.startedAt,
      submittedAt: a.submittedAt,
      questions: a.sectionB
        .filter((w) => w.status === "written" && !w.handoff.grade)
        .map((w) => ({
          n: w.n,
          maxMarks: w.maxMarks,
          type: w.type ?? ("sa" as const),
          scanned: Boolean(w.handoff.scanId),
        })),
    }))
    .filter((s) => s.questions.length > 0);
}

/**
 * The server's id for a sitting, syncing it first if it has never been sent.
 *
 * Null means the server could not be reached, and a null is not a reason to
 * stop: an answer sheet uploaded without an `attemptId` is still an answer
 * sheet, still graded and still shown. It is only the join back to the sitting
 * that is lost, and the next sync restores it.
 */
export async function ensureSynced(clientAttemptId: string): Promise<string | null> {
  let attempts: TestAttempt[];
  try {
    attempts = await allTestAttempts();
  } catch {
    return null;
  }
  const attempt = attempts.find((a) => a.id === clientAttemptId);
  if (!attempt) return null;
  if (attempt.serverAttemptId) return attempt.serverAttemptId;
  return syncAttempt(attempt);
}
