/**
 * Time-per-mark pacing — the maths behind the Board Exam Pacing Emulator.
 *
 * A CBSE paper is 80 marks in 180 minutes, so one mark is worth 2 min 15 s and
 * a 3-mark question is worth under seven. A student who spends twenty minutes
 * on one has already lost the paper and normally finds out when the bell goes.
 * This module exists so that it can be seen while it is still fixable.
 *
 * Every reading is a pure function of timestamps, for the same reason the
 * countdown in attempts.ts is: across three hours a phone locks, the tab is
 * backgrounded and its timers are throttled to nothing. A counter that added up
 * ticks would drift; worse, one that stopped while the tab slept would tell a
 * student they were on pace after they had lost forty minutes. So the only
 * state persisted is `reachedAt` — one wall-clock stamp per question, written
 * by `markReached` in attempts.ts — and everything below is recomputed from
 * those stamps against `now`. Sleep is not a pause: a gap lands, in full, on
 * whatever question was in hand, which is what the exam hall does too.
 *
 * No React, no browser APIs, no imports, so it is testable in plain Node.
 * See scripts/test-pacing.mjs.
 */

const MINUTE_MS = 60 * 1000;

/**
 * CBSE's headline ratio: 80 marks in 180 minutes. Nothing computes from this —
 * every paper's budget is derived from its own duration and total, so a 90-min
 * 40-mark paper still paces correctly — but it is the number the design was
 * built around and is worth stating once.
 */
export const CBSE_MS_PER_MARK = 2.25 * MINUTE_MS;

/**
 * How far a section may drift from its budget before it is worth saying so.
 *
 * Fifteen per cent of the section's own budget: on Section D of a Science paper
 * (20 marks, 45 minutes) that is about seven minutes, roughly the point at
 * which the time stops being recoverable inside the section. Below it, "behind"
 * is noise — and noise on this screen costs a student more than the minutes do.
 */
export const PACE_TOLERANCE = 0.15;

/**
 * ...and never less than this, however small the section. Fifteen per cent of a
 * single one-mark MCQ is twenty seconds; flagging that would leave the tracker
 * flickering between states while a student reads the question. Two minutes out
 * of a hundred and eighty is not a problem, so it is not reported as one.
 */
export const PACE_TOLERANCE_FLOOR_MS = 2 * MINUTE_MS;

export type PaceStatus = "ahead" | "on-pace" | "behind";

/** A question as the pacing maths needs it — satisfied by `PaperQuestion`. */
export interface PacedQuestion {
  n: number;
  maxMarks: number;
  section: string;
}

/** A stamp as the pacing maths needs it — satisfied by `QuestionScore`. */
export interface PacedStamp {
  n: number;
  reachedAt?: number;
}

/** "The student was starting question `n` at wall-clock `at`." */
export interface ReachMark {
  n: number;
  at: number;
}

/**
 * A contiguous run of questions under one section letter.
 *
 * Papers split a section across several rows of their own mark grid — Maths
 * lists Section A twice, eighteen one-markers then two assertion-reason — and a
 * student experiences that as one section. Adjacent rows sharing a label are
 * therefore merged; a label that genuinely reappears later stays its own block.
 */
export interface SectionBlock {
  label: string;
  from: number;
  to: number;
  marks: number;
}

export interface SectionPace extends SectionBlock {
  /** What the section is worth in time: its marks at the paper's rate. */
  budgetMs: number;
  /** Time actually spent inside it, from the stamps. */
  elapsedMs: number;
  /**
   * Over (+) or under (-) budget. A section still in hand is never under: a
   * student ten minutes into a forty-five minute section is not ahead, they
   * are simply not finished, and saying otherwise would be flattery.
   */
  driftMs: number;
  status: PaceStatus;
  state: "done" | "current" | "upcoming";
}

export interface Pacing {
  /** The paper's own rate: its duration spread across its marks. */
  budgetMsPerMark: number;
  /** Wall-clock time since the start, capped at the paper's deadline. */
  elapsedMs: number;
  /** Marks of the questions left behind — the ones actually banked. */
  marksDone: number;
  marksTotal: number;
  /** Observed rate so far; null before the first question is left behind. */
  actualMsPerMark: number | null;
  /** Where that rate lands the paper; null while there is nothing to project. */
  projectedTotalMs: number | null;
  /** How far past the deadline the projection runs. Negative is time to spare. */
  projectedOverrunMs: number | null;
  /** The rate that still finishes on time — the one actionable number here. */
  remainingMsPerMark: number | null;
  /** Every section's drift added up: how far the paper has slipped so far. */
  driftMs: number;
  /** The verdict, which is the section in hand's — see `pacing` below. */
  status: PaceStatus;
  currentQuestion: number | null;
  sections: SectionPace[];
  current: SectionPace | null;
  next: SectionPace | null;
}

/** Time one mark is worth. Zero for a paper with no marks — never NaN. */
export function budgetMsPerMark(durationMs: number, marksTotal: number): number {
  return marksTotal > 0 && durationMs > 0 ? durationMs / marksTotal : 0;
}

/**
 * Drift into a word. Symmetrical: the slack that stops a small overrun being
 * called "behind" also stops a small saving being called "ahead", because a
 * tracker that swings between the two every minute is not a calm one.
 */
export function paceStatus(driftMs: number, budgetMs: number): PaceStatus {
  const slack = Math.max(PACE_TOLERANCE_FLOOR_MS, Math.abs(budgetMs) * PACE_TOLERANCE);
  if (driftMs > slack) return "behind";
  if (driftMs < -slack) return "ahead";
  return "on-pace";
}

/** Questions in ascending order, with anything malformed dropped. */
function ordered(questions: PacedQuestion[]): PacedQuestion[] {
  return questions
    .filter((q) => Number.isFinite(q.n) && Number.isFinite(q.maxMarks))
    .sort((a, b) => a.n - b.n);
}

/** Adjacent questions sharing a section label, merged into blocks. */
export function sectionBlocks(questions: PacedQuestion[]): SectionBlock[] {
  const blocks: SectionBlock[] = [];
  for (const q of ordered(questions)) {
    const last = blocks[blocks.length - 1];
    if (last && last.label === q.section) {
      last.to = q.n;
      last.marks += q.maxMarks;
    } else {
      blocks.push({ label: q.section, from: q.n, to: q.n, marks: q.maxMarks });
    }
  }
  return blocks;
}

/**
 * The stamps, cleaned into a usable timeline.
 *
 * Three things can go wrong with data a phone writes across three hours: the
 * stamps come back out of question order, one predates the start of the paper,
 * or the device clock steps backwards between two of them. Each would produce a
 * negative segment, and a negative segment is time credited back to a student
 * who did not earn it. So stamps are sorted by question, floored at `startedAt`
 * and forced to run forwards. The start of the paper is the implicit first
 * mark: question one begins when the clock does.
 *
 * `until` drops stamps that have not happened yet. A stamp ahead of `now` is
 * either a clock that jumped forwards or a reading of an attempt as it stood
 * earlier; either way the student cannot have reached that question, and
 * counting it would spend time the paper has not yet had.
 */
export function reachMarks(
  stamps: PacedStamp[],
  startedAt: number,
  firstQuestion: number,
  until = Number.POSITIVE_INFINITY,
): ReachMark[] {
  const marks: ReachMark[] = [{ n: firstQuestion, at: startedAt }];
  const stamped = stamps
    .filter((s): s is PacedStamp & { reachedAt: number } => Number.isFinite(s.reachedAt))
    .map((s) => ({ n: s.n, at: s.reachedAt }))
    .sort((a, b) => a.n - b.n);

  for (const s of stamped) {
    if (s.n <= firstQuestion) continue;
    const previous = marks[marks.length - 1];
    const at = Math.max(previous.at, s.at, startedAt);
    if (at > until) break;
    marks.push({ n: s.n, at });
  }
  return marks;
}

/** The question the student says they are on: the furthest one stamped. */
export function currentQuestion(
  questions: PacedQuestion[],
  stamps: PacedStamp[],
  startedAt = 0,
  now = Number.POSITIVE_INFINITY,
): number | null {
  const list = ordered(questions);
  if (list.length === 0) return null;
  const marks = reachMarks(stamps, startedAt, list[0].n, now);
  return marks[marks.length - 1].n;
}

/**
 * Milliseconds spent on each question so far.
 *
 * A student stamps a handful of points in a paper, not all thirty-nine, so one
 * segment usually spans several questions. Its time is split across them in
 * proportion to their marks, because marks are the unit this whole feature is
 * denominated in: five minutes across a run of one-markers is not the same
 * mistake as five minutes on a 5-marker, and an even split would say it was.
 *
 * The open segment — from the last stamp to now — stops at the end of the
 * section the student is in, rather than running to the end of the paper. Time
 * cannot have been spent in a section that has not been started, and spreading
 * it that way would show a student forty minutes into Section A as barely into
 * it, which is the opposite of the truth they need.
 */
export function spendByQuestion(
  questions: PacedQuestion[],
  startedAt: number,
  stamps: PacedStamp[],
  now: number,
): Map<number, number> {
  const list = ordered(questions);
  const spend = new Map<number, number>(list.map((q) => [q.n, 0]));
  if (list.length === 0) return spend;

  const marks = reachMarks(stamps, startedAt, list[0].n, now);
  const last = marks[marks.length - 1];
  const end = Math.max(last.at, now);
  const block = sectionBlocks(list).find((b) => last.n >= b.from && last.n <= b.to);
  const openTo = (block?.to ?? list[list.length - 1].n) + 1;
  const points: ReachMark[] = [...marks, { n: openTo, at: end }];

  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const duration = Math.max(0, to.at - from.at);
    if (duration === 0) continue;

    const covered = list.filter((q) => q.n >= from.n && q.n < to.n);
    if (covered.length === 0) continue;

    const marksInSegment = covered.reduce((sum, q) => sum + q.maxMarks, 0);
    for (const q of covered) {
      // A run of zero-mark questions cannot be split by marks, so split it by
      // head count rather than dividing by zero and losing the time entirely.
      const share = marksInSegment > 0 ? q.maxMarks / marksInSegment : 1 / covered.length;
      spend.set(q.n, (spend.get(q.n) ?? 0) + duration * share);
    }
  }
  return spend;
}

/**
 * The whole picture, at one instant.
 *
 * `now` is capped at the paper's deadline, exactly as `submitAttempt` caps its
 * `submittedAt`: a phone left in a pocket overnight must not report a fourteen
 * hour paper, and once the time is up there is no pace left to measure.
 *
 * Each section is judged only against its own budget, and the verdict is the
 * section in hand's. Nothing accumulates a case against the student across
 * sections, for two reasons. It would be unfair — a section still in progress
 * has unspent budget that says nothing either way, so folding it into a running
 * total lets an overrun hide, or invents one that is not there. And it would be
 * unkind for no gain: the damage from every past section is already in
 * `remainingMsPerMark`, which is time left over marks left. "1:35 per mark
 * left" says everything "you are 22 minutes behind" says, without the second
 * sentence's accusation, and unlike it, tells the student what to do next.
 *
 * The limit of this is worth stating: with a stamp only at each section
 * boundary, twenty minutes lost on one 3-mark question shows up when the
 * section overruns, not at the twentieth minute. `reachedAt` is per question,
 * so a finer-grained tracker would need no change here — only more taps from a
 * student who is meant to be writing.
 */
export function pacing(
  input: {
    startedAt: number;
    durationMs: number;
    questions: PacedQuestion[];
    scores: PacedStamp[];
  },
  now = Date.now(),
): Pacing {
  const list = ordered(input.questions);
  const marksTotal = list.reduce((sum, q) => sum + q.maxMarks, 0);
  const rate = budgetMsPerMark(input.durationMs, marksTotal);

  const deadline = input.startedAt + input.durationMs;
  const at = Math.min(Math.max(now, input.startedAt), deadline);
  const elapsedMs = at - input.startedAt;

  const blocks = sectionBlocks(list);
  const spend = spendByQuestion(list, input.startedAt, input.scores, at);
  const current = currentQuestion(list, input.scores, input.startedAt, at);

  const marksDone = list
    .filter((q) => current !== null && q.n < current)
    .reduce((sum, q) => sum + q.maxMarks, 0);

  const actualMsPerMark = marksDone > 0 ? elapsedMs / marksDone : null;
  const projectedTotalMs = actualMsPerMark === null ? null : actualMsPerMark * marksTotal;
  const marksLeft = marksTotal - marksDone;
  const remainingMsPerMark = marksLeft > 0 ? Math.max(0, deadline - at) / marksLeft : null;

  const sections: SectionPace[] = blocks.map((b) => {
    const inBlock = list.filter((q) => q.n >= b.from && q.n <= b.to);
    const elapsed = inBlock.reduce((sum, q) => sum + (spend.get(q.n) ?? 0), 0);
    const budget = b.marks * rate;
    const state: SectionPace["state"] =
      current === null || current > b.to ? "done" : current >= b.from ? "current" : "upcoming";
    // A section not yet reached has spent nothing and is owed nothing. One in
    // hand can only be over, never under — its unspent budget is still the
    // student's to use. A finished one is judged both ways.
    const drift =
      state === "upcoming"
        ? 0
        : state === "current"
          ? Math.max(0, elapsed - budget)
          : elapsed - budget;
    return {
      ...b,
      budgetMs: budget,
      elapsedMs: elapsed,
      driftMs: drift,
      status: state === "upcoming" ? "on-pace" : paceStatus(drift, budget),
      state,
    };
  });

  const currentSection = sections.find((s) => s.state === "current") ?? null;
  const nextSection = currentSection
    ? (sections.find((s) => s.from > currentSection.from) ?? null)
    : null;

  return {
    budgetMsPerMark: rate,
    elapsedMs,
    marksDone,
    marksTotal,
    actualMsPerMark,
    projectedTotalMs,
    projectedOverrunMs: projectedTotalMs === null ? null : projectedTotalMs - input.durationMs,
    remainingMsPerMark,
    driftMs: sections.reduce((sum, s) => sum + s.driftMs, 0),
    status: currentSection?.status ?? "on-pace",
    currentQuestion: current,
    sections,
    current: currentSection,
    next: nextSection,
  };
}

/** How full a section's time is, 0–1 and clamped — the width of its bar. */
export function fillRatio(section: SectionPace): number {
  if (section.budgetMs <= 0) return section.elapsedMs > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, section.elapsedMs / section.budgetMs));
}

/** `M:SS` — a rate, read aloud as "two fifteen a mark". Never negative. */
export function formatPerMark(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "9 min", "1 hr 4 min" — a span, in the units a student thinks in. */
export function formatSpan(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}
