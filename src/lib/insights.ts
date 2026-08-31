/**
 * Performance signals in, household actions out.
 *
 * This is the whole point of the parent dashboard, and it is the part that is
 * easiest to get catastrophically wrong. "62% in Science" is not information a
 * household can act on; it is a number a parent can be disappointed at. The
 * PRD's own problem statement names **Punitive Parental Telemetry** as a cause
 * of study paralysis and academic dishonesty, so a dashboard that hands a
 * parent percentages and no instructions has not translated anything — it has
 * only widened the audience for a mark.
 *
 * Three rules, enforced in code rather than left to whoever writes the next
 * string:
 *
 *  1. **Every recommendation is an action somebody at home can take**, with a
 *     size in minutes. "Ask Ananya to teach you Reflection of Light out loud,
 *     ten minutes, no book" is a thing a parent does on a Tuesday. "Focus on
 *     Science" is not.
 *  2. **No bare percentages and no marks out of marks.** `assertHouseholdSafe`
 *     rejects them. The number is already on the screen if the parent wants it;
 *     repeating it inside the advice is how advice turns back into a report card.
 *  3. **Never scold.** Not the student, not the parent. A blocklist of the
 *     specific words that turn an observation into an accusation runs over
 *     every generated string before it is returned. If a rule cannot phrase
 *     itself without one of them, the rule is wrong.
 *
 * ## Pure on purpose
 *
 * No imports, no clock, no database. `now` is a parameter. That makes every
 * output deterministic and lets `scripts/test-parent.mjs` import *this file*
 * — not a re-implementation of it — with plain Node.
 *
 * ## On pronouns
 *
 * The schema records no gender and cannot be asked to guess one from a name, so
 * every string here uses the student's own first name. It reads better than
 * "your child" anyway.
 */

// ---------------------------------------------------------------------------
// Input — everything a parent is allowed to know, and nothing else
// ---------------------------------------------------------------------------

/** One calendar week of effort. Effort, not marks: this is the half of the */
/** picture a report card never shows and the half a parent can support. */
export interface WeekEffort {
  /** Midnight UTC on the Monday of this week. */
  weekStartMs: number;
  /** Distinct sittings — a proxy for turning up, which is the habit that matters. */
  sessions: number;
  minutes: number;
  papers: number;
}

/** How a subject has moved. Fractions in [0, 1], never rendered as such. */
export interface SubjectTrend {
  subject: string;
  /** Mean fraction of marks over the most recent papers. Null when unmarked. */
  recent: number | null;
  /** The same, over the papers before those. Null when there is no history. */
  earlier: number | null;
  papers: number;
}

/** Chapter-level difficulty: the one granularity a parent gets. */
export interface ChapterSignal {
  bookCode: string;
  chapter: number;
  subject: string;
  /** "Reflection of Light" — or "Chapter 10" where NCERT publishes no title. */
  label: string;
  /** How many separate sittings touched this chapter. High = re-reading it. */
  revisits: number;
  /** Fraction of marks across graded answers on this chapter. Null when unmarked. */
  fraction: number | null;
  answersGraded: number;
  lastSeenMs: number;
}

export interface HouseholdSnapshot {
  /** First name. See the note on pronouns above. */
  studentName: string;
  classNum: number;
  /** Evaluated against this instant. Passed in so output is deterministic. */
  now: number;
  weeks: readonly WeekEffort[];
  subjects: readonly SubjectTrend[];
  chapters: readonly ChapterSignal[];
  /** Answers sitting with a human evaluator. Nothing for a parent to do. */
  pendingHumanReview: number;
  /** Last activity of any kind, or null if there has never been any. */
  lastActiveMs: number | null;
  /** Sittings that began between 22:00 and 04:00 in the student's own timezone. */
  lateNightSessions: number;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type RecommendationKind =
  | "REST"
  | "RETURN_GENTLY"
  | "TEACH_BACK"
  | "NOTICE_EFFORT"
  | "ASK_WHAT_CHANGED"
  | "PROTECT_A_BLOCK"
  | "WAIT"
  | "NOTHING_NEEDED";

export interface Recommendation {
  /** Stable and derived from the signal, so the same week produces the same id. */
  id: string;
  kind: RecommendationKind;
  /** The action. Imperative, addressed to the parent, one sentence. */
  action: string;
  /** The observation it came from. Effort and behaviour, never a mark. */
  because: string;
  /** How long this takes. A household needs a size, not a project. */
  minutes: number;
  /** Higher first. Wellbeing outranks marks, always. */
  priority: number;
}

// ---------------------------------------------------------------------------
// The two guards
// ---------------------------------------------------------------------------

/**
 * Words and shapes that turn an observation into an accusation.
 *
 * This is a blocklist, which is the weaker kind of check, and it is here
 * anyway: it cannot prove a string is kind, but it reliably catches the
 * specific register that creeps in when somebody writes a "motivational"
 * message at the end of a long day. Every entry below was a phrase that would
 * have shipped.
 */
export const SCOLDING_PATTERNS: readonly RegExp[] = [
  /\blaz(y|iness)\b/i,
  /\b(must|has to|needs to) (try|work|do|study)\b/i,
  /\bshould have\b/i,
  /\bfail(s|ed|ing|ure)?\b/i,
  /\bpoor\b/i,
  /\bweak(ness|nesses)?\b/i,
  /\bbad\b/i,
  /\bdisappoint\w*/i,
  /\bonly (got|scored|managed)\b/i,
  /\bnot good enough\b/i,
  /\bstruggl\w*/i,
  /\bfalling behind\b/i,
  /\bpunish\w*/i,
  /\bcareless\b/i,
  /\bwaste\w*\b/i,
  /\bmake (him|her|them) \w+/i,
];

/** A bare percentage, or marks out of marks. Both belong on the chart, not in advice. */
export const BARE_NUMBER_PATTERNS: readonly RegExp[] = [
  /\d+(\.\d+)?\s*%/,
  /\b\d+(\.\d+)?\s*(?:\/|out of)\s*\d+\b/i,
  /\b\d+(\.\d+)?\s+marks?\b/i,
];

export class UnkindTextError extends Error {
  readonly offences: string[];
  constructor(offences: string[]) {
    super(
      `A recommendation would have been shown to a parent that scolds or restates a score:\n` +
        offences.map((o) => `  - ${o}`).join("\n") +
        `\n\nSee the three rules at the top of src/lib/insights.ts. Rephrase it as something` +
        ` somebody at home can do.`,
    );
    this.name = "UnkindTextError";
    this.offences = offences;
  }
}

/**
 * Throws unless every string in every recommendation is a household action that
 * neither scolds nor restates a mark. Called by `recommend()` before it
 * returns, so unkind text cannot reach a parent even if a rule generates it.
 */
export function assertHouseholdSafe(recommendations: readonly Recommendation[]): void {
  const offences: string[] = [];
  for (const r of recommendations) {
    for (const [field, text] of [
      ["action", r.action],
      ["because", r.because],
    ] as const) {
      for (const pattern of SCOLDING_PATTERNS) {
        if (pattern.test(text)) offences.push(`${r.id}.${field}: ${pattern} matched "${text}"`);
      }
      for (const pattern of BARE_NUMBER_PATTERNS) {
        if (pattern.test(text)) offences.push(`${r.id}.${field}: a bare score in "${text}"`);
      }
    }
  }
  if (offences.length) throw new UnkindTextError(offences);
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
/** Three late nights is a pattern; one is a deadline. */
const LATE_NIGHT_SESSIONS = 3;
/** Ten days of nothing is worth a conversation, not an alarm. */
const QUIET_DAYS = 10;
/** Below this, a chapter is genuinely not landing yet. */
const HARD_CHAPTER = 0.6;
/** Two graded answers before we are willing to call a chapter hard at all. */
const MIN_GRADED = 2;
/** A chapter opened this many times is the one being re-read. */
const REVISITED = 3;
/** An hour and a half in a week is real work, whatever the marks did. */
const REAL_EFFORT_MIN = 90;
/** A move of less than this is noise, not a trend. */
const TREND_EPSILON = 0.05;
/** Sittings shorter than this, repeated, are interruptions rather than study. */
const FRAGMENTED_SESSION_MIN = 12;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hoursAndMinutes(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  if (h === 0) return `${m} minutes`;
  if (m === 0) return h === 1 ? `an hour` : `${h} hours`;
  return `${h}h ${m}m`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function latestWeek(weeks: readonly WeekEffort[]): WeekEffort | null {
  if (weeks.length === 0) return null;
  return weeks.reduce((a, b) => (b.weekStartMs > a.weekStartMs ? b : a));
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Turn a snapshot into things to do this week, most important first.
 *
 * Deterministic: same snapshot, same array, same order, same ids. The ordering
 * is by priority and then by id, never by insertion, so adding a rule cannot
 * silently reshuffle the ones above it.
 *
 * Wellbeing rules outrank study rules by construction. A household that is up
 * past midnight does not need a chapter suggestion first.
 */
export function recommend(snapshot: HouseholdSnapshot): Recommendation[] {
  const name = snapshot.studentName;
  const out: Recommendation[] = [];

  // --- Wellbeing ----------------------------------------------------------

  // A quiet fortnight is the single most misread signal on a dashboard like
  // this. It is read as "not working" and answered with pressure, and it is
  // just as often illness, a phone that broke, or a bad month. So the action is
  // a question, and it explicitly puts marks second.
  const quietDays =
    snapshot.lastActiveMs === null ? null : Math.floor((snapshot.now - snapshot.lastActiveMs) / DAY_MS);
  if (quietDays !== null && quietDays >= QUIET_DAYS) {
    out.push({
      id: "return-gently",
      kind: "RETURN_GENTLY",
      action: `Ask ${name} what is getting in the way of opening a paper — before anything about marks.`,
      because: `It has been ${plural(quietDays, "day")} since ${name} last sat down with one. That gap is usually about something other than the subject.`,
      minutes: 10,
      priority: 100,
    });
  }

  if (snapshot.lateNightSessions >= LATE_NIGHT_SESSIONS) {
    out.push({
      id: "rest",
      kind: "REST",
      action: `Agree a fixed finish time — say 10 pm — and hold it for a week, including on the night before a test.`,
      because: `${plural(snapshot.lateNightSessions, "sitting")} in the last month started after 10 pm. Sleep does more for recall than the extra hour does.`,
      minutes: 5,
      priority: 95,
    });
  }

  // --- Effort, named out loud --------------------------------------------

  // The rule that exists because of the PRD's warning. When the hours went in
  // and the marks did not move, the dashboard's job is to make sure the parent
  // sees the hours. Left alone, this is exactly the week a household decides
  // the child is not trying.
  const week = latestWeek(snapshot.weeks);
  const flatOrDown = snapshot.subjects.some(
    (s) => s.recent !== null && s.earlier !== null && s.recent - s.earlier <= TREND_EPSILON,
  );
  if (week && week.minutes >= REAL_EFFORT_MIN && flatOrDown) {
    out.push({
      id: "notice-effort",
      kind: "NOTICE_EFFORT",
      action: `Tell ${name} you noticed the hours this week. Name the sittings, not the score.`,
      because: `${hoursAndMinutes(week.minutes)} across ${plural(week.sessions, "sitting")} in the last week. The work has gone in; the marks move later than the effort does.`,
      minutes: 2,
      priority: 85,
    });
  }

  // --- Chapter-level difficulty, as an action ----------------------------

  // Teach-back. The best-evidenced thing a non-specialist parent can do, and it
  // needs no subject knowledge at all: being explained to is the whole job.
  const teachBack = [...snapshot.chapters]
    .filter(
      (c) =>
        c.answersGraded >= MIN_GRADED &&
        c.fraction !== null &&
        c.fraction < HARD_CHAPTER &&
        c.revisits >= 2,
    )
    .sort(
      (a, b) =>
        b.revisits - a.revisits ||
        (a.fraction ?? 1) - (b.fraction ?? 1) ||
        a.bookCode.localeCompare(b.bookCode) ||
        a.chapter - b.chapter,
    )[0];
  if (teachBack) {
    out.push({
      id: `teach-back:${teachBack.bookCode}:${teachBack.chapter}`,
      kind: "TEACH_BACK",
      action: `Ask ${name} to teach you ${teachBack.label} out loud — ten minutes, book closed. Ask "why" twice.`,
      because: `It is the ${teachBack.subject} chapter ${name} has gone back to most: ${plural(teachBack.revisits, "sitting")} on it, and it is still the one that does not come easily.`,
      minutes: 10,
      priority: 80,
    });
  }

  // A chapter being re-read *without* a low score is a different thing: it is
  // usually a chapter the student has decided is important. Worth noticing,
  // never worth intervening in.
  const revisitedOnly = [...snapshot.chapters]
    .filter((c) => c.revisits >= REVISITED && (c.fraction === null || c.fraction >= HARD_CHAPTER))
    .sort((a, b) => b.revisits - a.revisits || a.bookCode.localeCompare(b.bookCode))[0];
  if (!teachBack && revisitedOnly) {
    out.push({
      id: `ask-about:${revisitedOnly.bookCode}:${revisitedOnly.chapter}`,
      kind: "ASK_WHAT_CHANGED",
      action: `Ask ${name} what keeps drawing them back to ${revisitedOnly.label}. Let them talk for the full answer.`,
      because: `${plural(revisitedOnly.revisits, "sitting")} on that one chapter, and it is going well. Something about it has their attention.`,
      minutes: 5,
      priority: 60,
    });
  }

  // --- A subject that is climbing ----------------------------------------

  const climbing = [...snapshot.subjects]
    .filter((s) => s.recent !== null && s.earlier !== null && s.recent - s.earlier > TREND_EPSILON && s.papers >= 2)
    .sort((a, b) => (b.recent ?? 0) - (b.earlier ?? 0) - ((a.recent ?? 0) - (a.earlier ?? 0)) || a.subject.localeCompare(b.subject))[0];
  if (climbing) {
    out.push({
      id: `ask-what-changed:${climbing.subject}`,
      kind: "ASK_WHAT_CHANGED",
      action: `Ask ${name} what they started doing differently in ${climbing.subject} — and whether it would work on another subject.`,
      because: `${climbing.subject} has been moving up across the last ${plural(climbing.papers, "paper")}. ${name} changed something, and naming it is what makes it repeatable.`,
      minutes: 5,
      priority: 70,
    });
  }

  // --- Practical household support ---------------------------------------

  if (week && week.sessions >= 4 && week.minutes / week.sessions < FRAGMENTED_SESSION_MIN) {
    out.push({
      id: "protect-a-block",
      kind: "PROTECT_A_BLOCK",
      action: `Protect one uninterrupted half-hour at home — same time, same place, phone in another room, including yours.`,
      because: `${plural(week.sessions, "sitting")} last week, none of them long. Short sittings are usually the house being busy rather than a choice.`,
      minutes: 30,
      priority: 65,
    });
  }

  // --- Things that are simply not the parent's turn -----------------------

  if (snapshot.pendingHumanReview > 0) {
    out.push({
      id: "wait",
      kind: "WAIT",
      action: `Nothing to do on these yet — leave them until the teacher has been through them.`,
      because:
        (snapshot.pendingHumanReview === 1
          ? `One of ${name}'s answers is`
          : `${snapshot.pendingHumanReview} of ${name}'s answers are`) +
        ` with a teacher for marking. Anything said now would be about a mark nobody has given.`,
      minutes: 0,
      priority: 30,
    });
  }

  if (out.length === 0) {
    out.push({
      id: "nothing-needed",
      kind: "NOTHING_NEEDED",
      action: `Nothing needs you this week. Ask ${name} how it is going, and take the answer at face value.`,
      because:
        snapshot.lastActiveMs === null
          ? `${name} has not started using the app yet, so there is nothing here to read into.`
          : `Steady sittings and no chapter standing out. A quiet week is a good week.`,
      minutes: 2,
      priority: 10,
    });
  }

  out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  // The last gate before a parent reads any of this.
  assertHouseholdSafe(out);
  return out;
}
