/**
 * The micro-bridge engine: what to *offer* a student who has just found a gap.
 *
 * A bridge is a two-or-three-minute run-up to a chapter, built out of the
 * earlier chapter it leans on. `data/prerequisites.json` is the authored map;
 * this module turns it into something the UI can offer at the right moment and
 * — much harder — knows when to stay quiet.
 *
 * Three decisions are worth defending, because all three are the opposite of
 * the obvious implementation.
 *
 * 1. **Nothing is ever locked.** The original spec had the app block further
 *    testing until the student took the review. A lock is the most visible
 *    punishment a study app can hand a fourteen-year-old, and it is visible to
 *    whoever is sitting next to them. So a bridge is an offer: take it, ignore
 *    it, or dismiss it, and the quiz carries on either way. A student who
 *    dismisses twice is never asked about that bridge again — the second "no"
 *    is information, not resistance.
 *
 * 2. **A prerequisite is an earlier chapter in this corpus, or it is admitted
 *    to be missing.** The app mirrors Class 9 and 10 only. Where the real
 *    prerequisite is Class 7-8 work — Class 10 Statistics needs mean and
 *    median; there is no Class 9 statistics chapter — the data says so and this
 *    module refuses to offer anything, rather than sending a stuck student to
 *    the nearest chapter with a similar-sounding name. See
 *    data/prerequisites.schema.md.
 *
 * 3. **The weakness signal is the existing one.** Confidence comes from the
 *    SM-2 cards in src/lib/revision.ts, and a quiz miss comes from the answers
 *    src/lib/quiz-attempts.ts already has in hand. Inventing a second notion of
 *    "weak" would eventually disagree with the weak-area dashboard, and the
 *    student would be told two different things about the same chapter.
 *
 * Everything above the storage section is pure and dependency-free (the one
 * import from revision.ts is a type, which erases), so it is unit-tested in
 * plain Node — see scripts/test-bridge.mjs.
 */
import prerequisitesJson from "@data/prerequisites.json";
import { getBook, getChapter, type ClassNum } from "./manifest";
import type { ChapterConfidence } from "./revision";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The promise the UI makes before a student commits. Enforced by bridge:check. */
export const MAX_BRIDGE_MINUTES = 3;

// --- shapes --------------------------------------------------------------

export interface ChapterPrerequisite {
  kind: "chapter";
  bookCode: string;
  chapter: number;
  /** Resolved from the manifest, so the UI never restates a title. */
  title: string;
  classNum: ClassNum;
  subject: string;
  minutes: number;
  why: string;
  recap: string[];
  /** The reader route, for a student who wants the whole chapter instead. */
  href: string;
}

/**
 * A prerequisite we know about and cannot show. It carries no recap and no
 * minutes on purpose: there is nothing to open, and a fabricated summary of a
 * book we do not have is exactly the wrong link this file exists to avoid.
 */
export interface OutOfCorpusPrerequisite {
  kind: "out-of-corpus";
  grade: number;
  topic: string;
  why: string;
  note?: string;
}

export interface Bridge {
  id: string;
  bookCode: string;
  chapter: number;
  title: string;
  classNum: ClassNum;
  subject: string;
  /** Absent on a chapter-wide bridge; present when it targets one idea. */
  concept?: string;
  /** Question ids in data/questions.json that point at this bridge. */
  questionIds: string[];
  /** The review itself, in reading order. Empty means nothing can be offered. */
  steps: ChapterPrerequisite[];
  /** Honest gaps, shown as a note under the review and never as a step. */
  gaps: OutOfCorpusPrerequisite[];
  /** Sum of `steps[].minutes`. Never more than MAX_BRIDGE_MINUTES. */
  minutes: number;
}

// --- normalisation -------------------------------------------------------

type Raw = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(asString).filter((s): s is string => s !== undefined) : [];
}

function rowsOf(file: unknown): Raw[] {
  if (Array.isArray(file)) return file as Raw[];
  const obj = file as Record<string, unknown> | null;
  for (const key of ["bridges", "items"]) {
    const v = obj?.[key];
    if (Array.isArray(v)) return v as Raw[];
  }
  return [];
}

interface Ref {
  classNum: ClassNum;
  bookCode: string;
  chapter: number;
}

/**
 * The ordering rule, and the only thing standing between a student and a loop.
 *
 * The corpus supports exactly two orderings: class, and chapter number within
 * one book. It supports nothing across two books of the same class — a student
 * does not read `jemh1` chapter 3 before `jesc1` chapter 11 in any defined
 * sense — so such a link is rejected rather than guessed at. Because every
 * accepted edge strictly decreases (class, chapter), the graph cannot contain a
 * cycle; scripts/check-prerequisites.mjs still looks for one as a backstop.
 */
function isEarlier(target: Ref, prereq: Ref): boolean {
  if (prereq.classNum < target.classNum) return true;
  if (prereq.classNum > target.classNum) return false;
  return prereq.bookCode === target.bookCode && prereq.chapter < target.chapter;
}

function refOf(bookCode: string | undefined, chapter: number | undefined) {
  if (!bookCode || chapter === undefined) return undefined;
  const book = getBook(bookCode);
  const ch = getChapter(bookCode, chapter);
  if (!book || !ch) return undefined;
  return { book, chapter: ch };
}

function normalisePrerequisite(raw: Raw, target: Ref): ChapterPrerequisite | OutOfCorpusPrerequisite | undefined {
  const kind = asString(raw.kind) ?? "chapter";

  if (kind === "out-of-corpus") {
    const grade = asNumber(raw.grade);
    const topic = asString(raw.topic);
    const why = asString(raw.why);
    if (grade === undefined || !topic || !why) return undefined;
    return { kind: "out-of-corpus", grade, topic, why, note: asString(raw.note) };
  }

  if (kind !== "chapter") return undefined;

  const resolved = refOf(asString(raw.bookCode), asNumber(raw.chapter));
  if (!resolved) return undefined;

  const { book, chapter } = resolved;
  const ref: Ref = { classNum: book.class, bookCode: book.code, chapter: chapter.n };
  if (!isEarlier(target, ref)) return undefined;

  const why = asString(raw.why);
  const recap = asStrings(raw.recap);
  if (!why || recap.length === 0) return undefined;

  const minutes = asNumber(raw.minutes) ?? 1;
  if (minutes <= 0 || minutes > MAX_BRIDGE_MINUTES) return undefined;

  return {
    kind: "chapter",
    bookCode: book.code,
    chapter: chapter.n,
    title: chapter.title,
    classNum: book.class,
    subject: book.subject,
    minutes,
    why,
    recap,
    href: `/read/${book.code}/${chapter.n}`,
  };
}

function normaliseBridge(raw: Raw): Bridge | undefined {
  const id = asString(raw.id);
  const resolved = refOf(asString(raw.bookCode), asNumber(raw.chapter));
  if (!id || !resolved) return undefined;

  const { book, chapter } = resolved;
  const target: Ref = { classNum: book.class, bookCode: book.code, chapter: chapter.n };

  const parts = (Array.isArray(raw.prerequisites) ? (raw.prerequisites as Raw[]) : [])
    .map((p) => normalisePrerequisite(p, target))
    .filter((p): p is ChapterPrerequisite | OutOfCorpusPrerequisite => p !== undefined);

  const steps = parts.filter((p): p is ChapterPrerequisite => p.kind === "chapter");
  const gaps = parts.filter((p): p is OutOfCorpusPrerequisite => p.kind === "out-of-corpus");
  if (steps.length === 0 && gaps.length === 0) return undefined;

  const minutes = steps.reduce((n, s) => n + s.minutes, 0);
  // A bridge that has quietly grown past its promise is not offered rather than
  // shown with a time the student would find to be a lie.
  if (minutes > MAX_BRIDGE_MINUTES) return undefined;

  return {
    id,
    bookCode: book.code,
    chapter: chapter.n,
    title: chapter.title,
    classNum: book.class,
    subject: book.subject,
    concept: asString(raw.concept),
    questionIds: asStrings(raw.questionIds),
    steps,
    gaps,
    minutes,
  };
}

const BRIDGES: Bridge[] = (() => {
  const seen = new Set<string>();
  const out: Bridge[] = [];
  for (const raw of rowsOf(prerequisitesJson as unknown)) {
    const bridge = normaliseBridge(raw);
    if (!bridge || seen.has(bridge.id)) continue;
    seen.add(bridge.id);
    out.push(bridge);
  }
  return out;
})();

// --- lookup --------------------------------------------------------------

export function allBridges(): Bridge[] {
  return BRIDGES;
}

/** Every bridge attached to one chapter: the chapter-wide one, then concepts. */
export function bridgesForChapter(bookCode: string, chapter: number): Bridge[] {
  return BRIDGES.filter((b) => b.bookCode === bookCode && b.chapter === chapter).sort(
    (a, b) => Number(Boolean(a.concept)) - Number(Boolean(b.concept)) || a.id.localeCompare(b.id),
  );
}

/**
 * The best bridge for a miss.
 *
 * A concept bridge wins over the chapter bridge when the concept is known: it
 * is shorter, and it is about the mistake the student actually made rather than
 * about the chapter they happen to be in.
 */
export function bridgeFor(bookCode: string, chapter: number, concept?: string): Bridge | undefined {
  const candidates = bridgesForChapter(bookCode, chapter);
  if (concept) {
    const key = concept.toLowerCase();
    const exact = candidates.find((b) => b.concept?.toLowerCase() === key);
    if (exact) return exact;
  }
  return candidates.find((b) => !b.concept) ?? candidates[0];
}

/** The bridge a specific wrong question points at, if the bank tags one. */
export function bridgeForQuestion(questionId: string): Bridge | undefined {
  return BRIDGES.find((b) => b.questionIds.includes(questionId));
}

/** True when there is something to actually show. Gap-only bridges are not. */
export function isOfferable(bridge: Bridge): boolean {
  return bridge.steps.length > 0;
}

/** Route for the review itself. */
export function bridgeHref(bridge: Pick<Bridge, "bookCode" | "chapter">): string {
  return `/bridge/${bridge.bookCode}/${bridge.chapter}`;
}

/** Distinct chapters that have a bridge, for generateStaticParams. */
export function bridgeChapters(): { code: string; chapter: number }[] {
  const seen = new Set<string>();
  const out: { code: string; chapter: number }[] = [];
  for (const b of BRIDGES) {
    const key = `${b.bookCode}:${b.chapter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code: b.bookCode, chapter: b.chapter });
  }
  return out;
}

// --- the weakness signal -------------------------------------------------

/**
 * Below this, a chapter's SM-2 confidence counts as a gap. It sits above the
 * dashboard's "shaky" line on purpose: /progress can afford to flag a wobble,
 * an interruption cannot.
 */
export const WEAK_CONFIDENCE = 0.6;

/** A quiz slice at or below this fraction correct counts as a gap. */
export const WEAK_SCORE = 0.5;

export interface WeakSignal {
  bookCode: string;
  chapter: number;
  concept?: string;
  /** 0–1. Higher means better evidence that the gap is real. */
  strength: number;
  at: number;
  source: "quiz" | "confidence";
}

/**
 * Signals from the revision cards — the same numbers /progress reads.
 *
 * A chapter tested once and missed is weaker evidence than one missed three
 * times, so strength is scaled by how much the chapter has been measured. No
 * data produces no signal, never a weak one: that is the honesty rule from
 * WeakAreas.tsx, and it matters more here, because this one interrupts.
 */
export function signalsFromConfidence(
  rows: ChapterConfidence[],
  now = Date.now(),
): WeakSignal[] {
  return rows
    .filter((r) => r.total > 0 && r.confidence < WEAK_CONFIDENCE)
    .map((r) => ({
      bookCode: r.bookCode,
      chapter: r.chapter,
      strength: Math.min(1, (1 - r.confidence) * Math.min(1, 0.5 + r.shaky / 4)),
      at: now,
      source: "confidence" as const,
    }));
}

export interface AnsweredRef {
  bookCode?: string;
  chapter?: number;
  /** Question id, so a tagged question can pick its concept bridge. */
  id?: string;
  correct: boolean;
}

/**
 * Signals from the quiz the student is sitting right now.
 *
 * Grouped per chapter, because one miss in ten is not a gap — it is a slip, and
 * interrupting over it is how a student learns to dismiss everything this
 * feature ever says.
 */
export function signalsFromAnswers(answers: AnsweredRef[], now = Date.now()): WeakSignal[] {
  const byChapter = new Map<string, { wrong: AnsweredRef[]; total: number }>();
  for (const a of answers) {
    if (!a.bookCode || a.chapter === undefined) continue;
    const key = `${a.bookCode}:${a.chapter}`;
    const slot = byChapter.get(key) ?? { wrong: [], total: 0 };
    slot.total++;
    if (!a.correct) slot.wrong.push(a);
    byChapter.set(key, slot);
  }

  const out: WeakSignal[] = [];
  for (const [key, { wrong, total }] of byChapter) {
    const ratio = wrong.length / total;
    if (wrong.length === 0 || 1 - ratio > WEAK_SCORE) continue;
    const [bookCode, chapter] = key.split(":");
    // If every miss in this chapter points at one concept bridge, aim there.
    const tagged = wrong
      .map((w) => (w.id ? bridgeForQuestion(w.id) : undefined))
      .filter((b): b is Bridge => b !== undefined && b.concept !== undefined);
    const concept =
      tagged.length === wrong.length && new Set(tagged.map((b) => b.id)).size === 1
        ? tagged[0].concept
        : undefined;
    out.push({
      bookCode,
      chapter: Number(chapter),
      concept,
      strength: ratio,
      at: now,
      source: "quiz",
    });
  }
  return out;
}

// --- what has already been offered ---------------------------------------

export interface BridgeRecord {
  /** How many times this bridge has been put in front of the student. */
  offered: number;
  lastOfferedAt: number;
  /** How many times they said no. Two is taken as final. */
  dismissed: number;
  lastDismissedAt?: number;
  takenAt?: number;
}

export type BridgeMemory = Record<string, BridgeRecord>;

/**
 * Rate limits. The numbers are a judgement about a bad afternoon, not about
 * pedagogy: a student who has just got four chapters wrong is having a hard
 * time, and four interruptions would make it worse rather than better.
 */
const MIN_GAP_MS = 6 * HOUR_MS;
const MAX_OFFERS_PER_DAY = 2;
/** Offered and neither taken nor dismissed — they were busy. Ask again tomorrow. */
const IGNORED_QUIET_MS = DAY_MS;
/** Quiet period after the first dismissal, then after the second. */
const DISMISS_QUIET_MS = [2 * DAY_MS, 14 * DAY_MS];
/** After this many dismissals the answer is no, permanently. */
export const MAX_DISMISSALS = 2;
/** Taken once; do not re-offer the same run-up until well after it is stale. */
const TAKEN_QUIET_MS = 21 * DAY_MS;

/** Whether this particular bridge may be shown again. Pure. */
export function isEligible(record: BridgeRecord | undefined, now: number): boolean {
  if (!record) return true;
  if (record.dismissed >= MAX_DISMISSALS) return false;
  if (record.dismissed > 0) {
    const quiet = DISMISS_QUIET_MS[Math.min(record.dismissed, DISMISS_QUIET_MS.length) - 1];
    if (now - (record.lastDismissedAt ?? record.lastOfferedAt) < quiet) return false;
  }
  if (record.takenAt !== undefined && now - record.takenAt < TAKEN_QUIET_MS) return false;
  if (record.offered > 0 && now - record.lastOfferedAt < IGNORED_QUIET_MS) return false;
  return true;
}

/**
 * Whether *any* bridge may be shown right now, whatever the gap.
 *
 * Counted per bridge rather than per event, because memory keeps one timestamp
 * per bridge; re-offering the same bridge is already blocked above, so the two
 * together cannot undercount a burst.
 */
export function withinRateLimit(memory: BridgeMemory, now: number): boolean {
  let recent = 0;
  for (const record of Object.values(memory)) {
    if (now - record.lastOfferedAt < MIN_GAP_MS) return false;
    if (now - record.lastOfferedAt < DAY_MS) recent++;
  }
  return recent < MAX_OFFERS_PER_DAY;
}

export interface BridgeOffer {
  bridge: Bridge;
  /** The gap that prompted it, so the UI can name the chapter honestly. */
  signal: WeakSignal;
  href: string;
}

/**
 * One offer, or nothing.
 *
 * Deliberately returns at most one. Offering a student three run-ups at once
 * tells them they are three chapters behind, which is both discouraging and
 * useless — they can only read one first anyway.
 */
export function selectBridge(
  signals: WeakSignal[],
  memory: BridgeMemory = {},
  now = Date.now(),
): BridgeOffer | null {
  if (!withinRateLimit(memory, now)) return null;

  const candidates: BridgeOffer[] = [];
  const seen = new Set<string>();

  for (const signal of signals) {
    const bridge = bridgeFor(signal.bookCode, signal.chapter, signal.concept);
    if (!bridge || !isOfferable(bridge)) continue;
    if (seen.has(bridge.id)) continue;
    seen.add(bridge.id);
    if (!isEligible(memory[bridge.id], now)) continue;
    candidates.push({ bridge, signal, href: bridgeHref(bridge) });
  }

  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) =>
      b.signal.strength - a.signal.strength ||
      // A quiz miss is a fact; a confidence score is an average of guesses.
      Number(b.signal.source === "quiz") - Number(a.signal.source === "quiz") ||
      // Then the cheapest help, so the first thing offered is the easiest yes.
      a.bridge.minutes - b.bridge.minutes ||
      a.bridge.id.localeCompare(b.bridge.id),
  );
  return candidates[0];
}

// --- memory, kept on the device -----------------------------------------

/** Pure updates, so scripts/test-bridge.mjs can drive a whole week in a loop. */
export function noteOffered(memory: BridgeMemory, id: string, now = Date.now()): BridgeMemory {
  const prev = memory[id];
  return {
    ...memory,
    [id]: { ...(prev ?? { dismissed: 0 }), offered: (prev?.offered ?? 0) + 1, lastOfferedAt: now },
  };
}

export function noteDismissed(memory: BridgeMemory, id: string, now = Date.now()): BridgeMemory {
  const prev = memory[id] ?? { offered: 0, lastOfferedAt: now, dismissed: 0 };
  return {
    ...memory,
    [id]: { ...prev, dismissed: prev.dismissed + 1, lastDismissedAt: now },
  };
}

export function noteTaken(memory: BridgeMemory, id: string, now = Date.now()): BridgeMemory {
  const prev = memory[id] ?? { offered: 0, lastOfferedAt: now, dismissed: 0 };
  return { ...memory, [id]: { ...prev, takenAt: now } };
}

const MEMORY_KEY = "ncert:bridge";

/**
 * Storage is localStorage rather than IndexedDB: this is a handful of
 * timestamps, and the property access itself throws in a locked-down WebView.
 * Losing it means a student is offered a run-up they have seen before — mildly
 * annoying, and much better than a crash mid-quiz. Same contract as prefs.ts.
 */
export function loadMemory(): BridgeMemory {
  try {
    const raw = window.localStorage.getItem(MEMORY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: BridgeMemory = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const r = value as Partial<BridgeRecord> | null;
      if (!r || typeof r !== "object") continue;
      out[id] = {
        offered: asNumber(r.offered) ?? 0,
        lastOfferedAt: asNumber(r.lastOfferedAt) ?? 0,
        dismissed: asNumber(r.dismissed) ?? 0,
        lastDismissedAt: asNumber(r.lastDismissedAt),
        takenAt: asNumber(r.takenAt),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveMemory(memory: BridgeMemory): void {
  try {
    window.localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // No storage: the offer simply will not be remembered across a reload.
  }
}

/** Load, apply a pure update, save. The three the UI actually calls. */
export function rememberOffered(id: string, now = Date.now()): void {
  saveMemory(noteOffered(loadMemory(), id, now));
}

export function rememberDismissed(id: string, now = Date.now()): void {
  saveMemory(noteDismissed(loadMemory(), id, now));
}

export function rememberTaken(id: string, now = Date.now()): void {
  saveMemory(noteTaken(loadMemory(), id, now));
}
