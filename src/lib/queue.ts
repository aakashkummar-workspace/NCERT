/**
 * The evaluator queue: who may take a ticket, which ticket they get, and what
 * happens when they walk away from it.
 *
 * Three things here are corrections of the specification in
 * `CBSE_EdTech_Platform_Technical_Specification.md`, and each of them is a bug
 * that only appears under load or after dark:
 *
 * 1. **Claiming is one conditional `UPDATE`, not `findFirst` then `create`.**
 *    The spec reads a free ticket, then writes a claim, outside a transaction.
 *    Two tutors polling 30 ms apart both read the same free ticket and both
 *    write a claim to it; the second silently overwrites the first, and two
 *    people grade one script while a third ticket nobody looked at ages out.
 *    `claimNextTicket` issues the statement in `prisma/README.md` — an `UPDATE`
 *    whose subselect takes `FOR UPDATE SKIP LOCKED LIMIT 1`. The returned row
 *    *is* the claim. Zero rows means there was nothing to claim, which is an
 *    empty queue and not an error. No Redis, no lock service, no heartbeat.
 *
 * 2. **A shift is a window in a named timezone, and it may cross midnight.**
 *    The spec compares a bare `TIME` column against `new Date()`. That is wrong
 *    twice: `TIME` carries no zone, so it means "22:00 wherever this server
 *    happens to be", and a `start <= now <= end` comparison matches *nothing at
 *    all* for a 22:00-02:00 shift — which is the night shift, in a product
 *    whose peak load is Indian evenings. `isWithinShift` converts the instant
 *    into the shift's own IANA zone and handles the wrap explicitly.
 *
 * 3. **`maxConcurrent` is actually enforced.** The spec stores
 *    `max_concurrent_fixed_tickets` and never reads it. Here the check runs
 *    inside the claim transaction under a per-evaluator advisory lock, so an
 *    evaluator's two open browser tabs cannot both see "4 of 5" and both claim.
 *    The lock is keyed on the evaluator, so two *different* evaluators never
 *    contend and `SKIP LOCKED` keeps doing its job across the pool.
 *
 * ## The deviations from the SQL as printed in prisma/README.md
 *
 * The README's statement is written against snake_case columns
 * (`claimed_by_id`, `class_num`). The generated migration has **quoted
 * camelCase** columns — the models carry `@@map` for table names but no `@map`
 * on any field — so the SQL as printed does not run. `docs/PLATFORM.md` §6 says
 * so in as many words. Every column below is therefore quoted camelCase.
 *
 * The only *structural* change is that
 *
 * ```sql
 *   AND c.subject = $2 AND c.class_num = $3
 * ```
 *
 * becomes a row-constructor membership test over the evaluator's whole
 * qualification set, because an evaluator qualifies for several (subject,
 * class) pairs at once — Meera marks Science 9 *and* Science 10 — and running
 * the statement once per pair would take the best ticket of the first pair
 * rather than the best ticket overall, quietly breaking `priority`. With a
 * single pair the two forms are the same predicate and the same plan.
 *
 * The lease interval is `make_interval(mins => $n)` rather than a literal
 * `interval '15 minutes'`, so the duration is one configured number rather than
 * three copies of a string in three statements.
 */
import { Prisma } from "@prisma/client";
import type { EvaluationTicket, EvaluatorProfile, EvaluatorType, User } from "@prisma/client";
import prisma from "@/lib/db";
import { ApiError } from "@/lib/api";

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

/**
 * A recurring daily window, in a named zone.
 *
 * `startMinute` and `endMinute` are minutes past local midnight, 0-1439.
 * `startMinute > endMinute` is a shift that crosses midnight and is a normal
 * thing to write, not an input error: 22:00-02:00 is `{ start: 1320, end: 120 }`.
 */
export interface Shift {
  startMinute: number;
  endMinute: number;
  /** An IANA zone name — "Asia/Kolkata". Never a UTC offset: offsets move. */
  timeZone: string;
}

/**
 * The platform's default zone. Named rather than implied: the spec's `TIME`
 * columns implied one and got it from whatever the server was configured with,
 * which is a different answer in a Mumbai datacentre and a Frankfurt one.
 */
export const DEFAULT_TIME_ZONE = process.env.EVALUATOR_TIME_ZONE ?? "Asia/Kolkata";

/** `"22:00"` to 1320. Throws on anything that is not a 24-hour wall time. */
export function parseWallTime(text: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  if (!m) {
    throw ApiError.validation([{ path: "shift", message: `"${text}" is not a HH:MM wall time` }]);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

export function shiftFromWallTimes(start: string, end: string, timeZone = DEFAULT_TIME_ZONE): Shift {
  return { startMinute: parseWallTime(start), endMinute: parseWallTime(end), timeZone };
}

/**
 * Which evaluator types work a fixed shift. `INTERNAL_TUTOR` is the tuition
 * staff engine; `FREELANCE` is the gig network and works whenever it likes;
 * `SCHOOL_TEACHER` marks tickets assigned to them and is not rostered.
 *
 * **This lives in code because the schema has nowhere to put it.**
 * `EvaluatorProfile` has `evaluatorType`, `activeForRouting` and
 * `maxConcurrent`, and no shift columns at all. The schema is frozen, so the
 * roster is configuration — overridable per deployment through
 * `EVALUATOR_SHIFTS`, and per evaluator through `EVALUATOR_SHIFT_OVERRIDES`.
 * When the schema unfreezes, this table becomes two `time` columns and a
 * `VARCHAR` zone on `evaluator_profiles`, and only `shiftFor` changes.
 *
 * The default is deliberately the awkward case: the Indian evening peak running
 * past midnight, which is exactly the window the spec's `start <= now <= end`
 * comparison matches zero rows for.
 */
const DEFAULT_SHIFTS: Partial<Record<EvaluatorType, Shift>> = {
  INTERNAL_TUTOR: { startMinute: 16 * 60, endMinute: 2 * 60, timeZone: DEFAULT_TIME_ZONE },
};

function parseShiftEnv(raw: string | undefined): Record<string, Shift> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("EVALUATOR_SHIFTS / EVALUATOR_SHIFT_OVERRIDES must be JSON.");
  }
  const out: Record<string, Shift> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const spec = value as { start?: string; end?: string; timeZone?: string } | null;
    if (!spec || typeof spec.start !== "string" || typeof spec.end !== "string") continue;
    out[key] = shiftFromWallTimes(spec.start, spec.end, spec.timeZone ?? DEFAULT_TIME_ZONE);
  }
  return out;
}

const SHIFT_BY_TYPE: Record<string, Shift> = parseShiftEnv(process.env.EVALUATOR_SHIFTS);
const SHIFT_BY_USER: Record<string, Shift> = parseShiftEnv(process.env.EVALUATOR_SHIFT_OVERRIDES);

/** The shift this evaluator works, or `null` for "no fixed hours". */
export function shiftFor(userId: string, evaluatorType: EvaluatorType): Shift | null {
  return (
    SHIFT_BY_USER[userId] ?? SHIFT_BY_TYPE[evaluatorType] ?? DEFAULT_SHIFTS[evaluatorType] ?? null
  );
}

/**
 * Minutes past local midnight for `at`, in `timeZone`.
 *
 * `Intl.DateTimeFormat` is the only thing in the standard library that knows
 * the IANA database, and it knows about the DST transitions a fixed offset
 * would get wrong twice a year. India does not observe DST, but the evaluator
 * network will not stay inside India, and "it worked in Delhi" is not a
 * property worth shipping.
 */
export function minutesOfDayIn(timeZone: string, at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/**
 * Is `at` inside `shift`?
 *
 * The half-open interval `[start, end)` is deliberate: a shift ending at 02:00
 * does not include 02:00, so back-to-back shifts do not both claim the instant
 * they meet at.
 *
 * The wrap is the whole point. For 22:00-02:00 the spec's
 * `start <= now && now <= end` is `1320 <= m && m <= 120`, which is false for
 * every m, so the night shift never exists. Here `start > end` means the window
 * spans midnight and the test becomes a union rather than an intersection.
 */
export function isWithinShift(shift: Shift, at: Date = new Date()): boolean {
  const m = minutesOfDayIn(shift.timeZone, at);
  const { startMinute: start, endMinute: end } = shift;
  // start === end is a 24-hour roster, not a zero-length one. A zero-length
  // shift is not something anyone means to write.
  if (start === end) return true;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface Qualification {
  subject: string;
  classNum: number;
}

export interface EvaluatorContext {
  user: Pick<User, "id" | "scopeId" | "role">;
  profile: EvaluatorProfile;
  qualifications: Qualification[];
  shift: Shift | null;
  /** True when there is no shift, or `at` falls inside it. */
  onShift: boolean;
  /** Open tickets this evaluator is currently holding. */
  openTickets: number;
  /** `openTickets < profile.maxConcurrent`. */
  hasCapacity: boolean;
}

/** The statuses that count against `maxConcurrent`: work in someone's hands. */
export const OPEN_TICKET_STATUSES = ["CLAIMED", "IN_REVIEW"] as const;

/**
 * Everything the router and the claim need to know about one evaluator, in one
 * read. Throws `FORBIDDEN` when the user is not an evaluator at all — that is a
 * role error, not an empty queue.
 */
export async function evaluatorContext(
  user: Pick<User, "id" | "scopeId" | "role">,
  at: Date = new Date(),
): Promise<EvaluatorContext> {
  const profile = await prisma.evaluatorProfile.findUnique({
    where: { userId: user.id },
    include: { subjects: true },
  });
  if (!profile) {
    // Says nothing about what does exist. An evaluator profile's absence is not
    // the caller's business beyond "not you".
    throw ApiError.forbidden("You do not have an evaluator profile.");
  }

  const shift = shiftFor(user.id, profile.evaluatorType);
  const openTickets = await prisma.evaluationTicket.count({
    where: { claimedById: user.id, status: { in: [...OPEN_TICKET_STATUSES] } },
  });

  return {
    user,
    profile,
    qualifications: profile.subjects.map((s) => ({ subject: s.subject, classNum: s.classNum })),
    shift,
    onShift: shift === null || isWithinShift(shift, at),
    openTickets,
    hasCapacity: openTickets < profile.maxConcurrent,
  };
}

export type IneligibleReason =
  | "NOT_ACTIVE_FOR_ROUTING"
  | "OFF_SHIFT"
  | "AT_CONCURRENCY_LIMIT"
  | "NO_QUALIFICATIONS";

/** `null` when the evaluator may take work right now. */
export function ineligibleReason(ctx: EvaluatorContext): IneligibleReason | null {
  if (!ctx.profile.activeForRouting) return "NOT_ACTIVE_FOR_ROUTING";
  if (ctx.qualifications.length === 0) return "NO_QUALIFICATIONS";
  if (!ctx.onShift) return "OFF_SHIFT";
  if (!ctx.hasCapacity) return "AT_CONCURRENCY_LIMIT";
  return null;
}

export const INELIGIBLE_MESSAGE: Record<IneligibleReason, string> = {
  NOT_ACTIVE_FOR_ROUTING: "Your account is not currently taking tickets.",
  NO_QUALIFICATIONS: "You are not registered to mark any subject yet.",
  OFF_SHIFT: "You are outside your rostered hours.",
  AT_CONCURRENCY_LIMIT: "You are already holding as many tickets as you may at once.",
};

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

/**
 * 15 minutes, matching `prisma/README.md`. Short enough that an abandoned
 * ticket is back on the board before the student notices, long enough to grade
 * a five-mark answer without the page nagging.
 */
export const DEFAULT_LEASE_MINUTES = Number(process.env.TICKET_LEASE_MINUTES ?? 15);

function qualificationSql(qualifications: Qualification[]): Prisma.Sql {
  return Prisma.join(
    qualifications.map((q) => Prisma.sql`(${q.subject}::text, ${q.classNum}::int)`),
    ", ",
  );
}

export interface ClaimResult {
  ticket: EvaluationTicket | null;
  /** Set when nothing was claimed and the reason was the evaluator, not the queue. */
  refused: IneligibleReason | null;
}

/**
 * Take the next ticket this evaluator may have, atomically.
 *
 * Returns `{ ticket: null, refused: null }` for an empty queue — the ordinary
 * case a poller sees all day, and emphatically not an error.
 *
 * The transaction does three things in order, and the order matters:
 *
 * 1. `pg_advisory_xact_lock` on the evaluator. Two tabs belonging to the same
 *    person now serialise; two different people do not touch each other. This
 *    is what makes the `maxConcurrent` count below a decision rather than a
 *    guess — a bare `SELECT count(*)` takes no locks, so without this both
 *    tabs read "4 of 5" and both claim. Keying the lock on the evaluator rather
 *    than on the queue is what keeps `SKIP LOCKED` meaningful: fifty different
 *    tutors take fifty different locks and never wait on each other.
 * 2. Count the tickets already in this evaluator's hands, and stop if they are
 *    full. The specification being corrected stored this limit and never read
 *    it.
 * 3. The claim statement from `prisma/README.md`, unchanged apart from the
 *    column quoting and the qualification-set predicate documented at the top
 *    of this file. `FOR UPDATE SKIP LOCKED` inside the subselect is what makes
 *    fifty pollers pick fifty different tickets instead of queueing behind one;
 *    the repeated `status` / `claimedAt` predicates on the outer `UPDATE` close
 *    the window between the subselect and the write.
 */
export async function claimNextTicket(opts: {
  evaluatorId: string;
  qualifications: Qualification[];
  maxConcurrent: number;
  leaseMinutes?: number;
}): Promise<ClaimResult> {
  const { evaluatorId, qualifications } = opts;
  const leaseMinutes = opts.leaseMinutes ?? DEFAULT_LEASE_MINUTES;
  if (qualifications.length === 0) return { ticket: null, refused: "NO_QUALIFICATIONS" };

  return prisma.$transaction(async (tx) => {
    // `$executeRaw`, not `$queryRaw`: the lock function returns `void`, and
    // Prisma cannot deserialize a void column — it fails the whole claim with
    // an opaque error rather than taking the lock.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${evaluatorId}::text, 0))`;

    const counted = await tx.$queryRaw<{ open: bigint }[]>`
      SELECT count(*) AS open
        FROM evaluation_tickets
       WHERE "claimedById" = ${evaluatorId}::uuid
         AND status IN ('CLAIMED'::"TicketStatus", 'IN_REVIEW'::"TicketStatus")
    `;
    if (Number(counted[0]?.open ?? 0) >= opts.maxConcurrent) {
      return { ticket: null, refused: "AT_CONCURRENCY_LIMIT" as const };
    }

    const rows = await tx.$queryRaw<EvaluationTicket[]>`
      UPDATE evaluation_tickets AS t
         SET status           = 'CLAIMED'::"TicketStatus",
             "claimedById"    = ${evaluatorId}::uuid,
             "claimedAt"      = now(),
             "leaseExpiresAt" = now() + make_interval(mins => ${leaseMinutes}::int),
             "claimCount"     = t."claimCount" + 1,
             "updatedAt"      = now()
       WHERE t.id = (
               SELECT c.id
                 FROM evaluation_tickets AS c
                WHERE c.status = 'PENDING'::"TicketStatus"
                  AND c."claimedAt" IS NULL
                  AND (c.subject, c."classNum") IN (${qualificationSql(qualifications)})
                  AND (c."assignedEvaluatorId" IS NULL OR c."assignedEvaluatorId" = ${evaluatorId}::uuid)
                ORDER BY c.priority DESC, c."createdAt"
                FOR UPDATE SKIP LOCKED
                LIMIT 1
             )
         AND t.status = 'PENDING'::"TicketStatus"
         AND t."claimedAt" IS NULL
      RETURNING t.*
    `;

    return { ticket: rows[0] ?? null, refused: null };
  });
}

/**
 * Put every expired lease back on the board.
 *
 * Run it from a cron, once a minute. This is why there is no heartbeat service:
 * a tutor who shuts their laptop mid-review resolves itself, and the ticket is
 * available again within a minute rather than when someone notices.
 *
 * `claimCount` is deliberately not reset. A ticket claimed and abandoned four
 * times is a bad scan, not four bad tutors, and whoever triages the queue
 * should be able to see that and send it back to the student to re-photograph.
 */
export async function sweepExpiredLeases(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE evaluation_tickets
       SET status           = 'PENDING'::"TicketStatus",
           "claimedById"    = NULL,
           "claimedAt"      = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt"      = now()
     WHERE status IN ('CLAIMED'::"TicketStatus", 'IN_REVIEW'::"TicketStatus")
       AND "leaseExpiresAt" < now()
    RETURNING id
  `;
  return rows.map((r) => r.id);
}

/**
 * Push the lease out while the evaluator is demonstrably still working.
 *
 * Scoped to the holder: `"claimedById" = $2` means an extension request from
 * anyone else does nothing and returns zero rows, rather than handing a
 * stranger the power to keep a ticket parked indefinitely.
 */
export async function extendLease(
  ticketId: string,
  evaluatorId: string,
  leaseMinutes = DEFAULT_LEASE_MINUTES,
): Promise<Date | null> {
  const rows = await prisma.$queryRaw<{ leaseExpiresAt: Date }[]>`
    UPDATE evaluation_tickets
       SET "leaseExpiresAt" = now() + make_interval(mins => ${leaseMinutes}::int),
           "updatedAt"      = now()
     WHERE id = ${ticketId}::uuid
       AND "claimedById" = ${evaluatorId}::uuid
       AND status IN ('CLAIMED'::"TicketStatus", 'IN_REVIEW'::"TicketStatus")
    RETURNING "leaseExpiresAt"
  `;
  return rows[0]?.leaseExpiresAt ?? null;
}

/**
 * Hand a ticket back deliberately — "this scan is unreadable", or "I have to
 * go". Same shape as the sweeper, scoped to the holder.
 */
export async function releaseTicket(ticketId: string, evaluatorId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE evaluation_tickets
       SET status           = 'PENDING'::"TicketStatus",
           "claimedById"    = NULL,
           "claimedAt"      = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt"      = now()
     WHERE id = ${ticketId}::uuid
       AND "claimedById" = ${evaluatorId}::uuid
       AND status IN ('CLAIMED'::"TicketStatus", 'IN_REVIEW'::"TicketStatus")
    RETURNING id
  `;
  return rows.length > 0;
}

/** Mark a ticket done. Scoped to the holder, and only from a working state. */
export async function completeTicket(ticketId: string, evaluatorId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE evaluation_tickets
       SET status           = 'COMPLETED'::"TicketStatus",
           "completedAt"    = now(),
           "leaseExpiresAt" = NULL,
           "updatedAt"      = now()
     WHERE id = ${ticketId}::uuid
       AND "claimedById" = ${evaluatorId}::uuid
       AND status IN ('CLAIMED'::"TicketStatus", 'IN_REVIEW'::"TicketStatus")
    RETURNING id
  `;
  return rows.length > 0;
}

/** Move a claimed ticket into IN_REVIEW when the evaluator opens the canvas. */
export async function beginReviewOnTicket(ticketId: string, evaluatorId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE evaluation_tickets
       SET status      = 'IN_REVIEW'::"TicketStatus",
           "updatedAt" = now()
     WHERE id = ${ticketId}::uuid
       AND "claimedById" = ${evaluatorId}::uuid
       AND status IN ('CLAIMED'::"TicketStatus", 'IN_REVIEW'::"TicketStatus")
    RETURNING id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export interface TicketAccess {
  ticket: EvaluationTicket;
  /** True when this user holds the lease and may write against the ticket. */
  holdsLease: boolean;
}

/**
 * Load a ticket this user has business seeing, or throw.
 *
 * `docs/PLATFORM.md` §4 states the rule: an evaluator may read a submission
 * they have **claimed, been assigned, or already reviewed** — not any
 * submission, because an evaluator who can read everything by URL has no queue.
 * An admin may read anything inside their own scope.
 *
 * Everything refuses with the same `NOT_FOUND`, so a stranger cannot use this
 * route to learn which ticket ids are real.
 */
export async function ticketForUser(
  ticketId: string,
  user: Pick<User, "id" | "scopeId" | "role">,
): Promise<TicketAccess> {
  const ticket = await prisma.evaluationTicket.findFirst({
    where: { id: ticketId, submission: { student: { scopeId: user.scopeId } } },
  });
  if (!ticket) throw ApiError.notFound("Ticket");

  if (user.role === "ADMIN") return { ticket, holdsLease: false };

  const holdsLease = ticket.claimedById === user.id;
  if (holdsLease || ticket.assignedEvaluatorId === user.id) return { ticket, holdsLease };

  const reviewed = await prisma.evaluatorReview.findFirst({
    where: { ticketId: ticket.id, evaluatorId: user.id },
    select: { id: true },
  });
  if (reviewed) return { ticket, holdsLease: false };

  throw ApiError.notFound("Ticket");
}

/** The same load, but the caller is about to write: the lease must be theirs. */
export async function heldTicket(
  ticketId: string,
  user: Pick<User, "id" | "scopeId" | "role">,
): Promise<EvaluationTicket> {
  const { ticket, holdsLease } = await ticketForUser(ticketId, user);
  if (!holdsLease) {
    throw new ApiError(
      "CONFLICT",
      "You are not holding this ticket. It may have been released when its lease expired — claim it again before marking.",
    );
  }
  return ticket;
}

// ---------------------------------------------------------------------------
// Routing — the dual engine
// ---------------------------------------------------------------------------

export type RoutingEngine = "FIXED_SHIFT" | "OPEN_POOL";

export interface RoutingCandidate {
  evaluatorId: string;
  displayName: string | null;
  evaluatorType: EvaluatorType;
  rostered: boolean;
  onShift: boolean;
  openTickets: number;
  maxConcurrent: number;
  eligible: boolean;
  reason: IneligibleReason | null;
}

export interface RoutingDecision {
  engine: RoutingEngine;
  /** NULL for the open pool: the ticket goes on the bulletin board. */
  assignedEvaluatorId: string | null;
  /** Why, in words, for the admin screen and for the test to assert on. */
  rationale: string;
  /** Everyone considered, with the reason each was or was not picked. */
  considered: RoutingCandidate[];
}

/**
 * Decide which engine takes a submission: rostered tuition staff first, the
 * open gig network second.
 *
 * "First" is a real preference and not a tie-break — the internal staff are
 * salaried and their idle time is already paid for, so a ticket a rostered
 * tutor can take should not go to the marketplace. Only when nobody is
 * rostered, on shift, qualified and under their limit does the ticket become
 * open.
 *
 * Among eligible rostered staff, the one holding the fewest open tickets wins,
 * so a shift's work spreads rather than piling onto whoever the index happens to
 * return first.
 *
 * Scope is honoured even though every row is on the nil UUID today: an evaluator
 * in one school must not be handed another school's script the day tenancy
 * lands, and the query that forgot is the one nobody re-reads.
 */
export async function decideRouting(opts: {
  scopeId: string;
  subject: string;
  classNum: number;
  at?: Date;
}): Promise<RoutingDecision> {
  const at = opts.at ?? new Date();

  const candidates = await prisma.evaluatorProfile.findMany({
    where: {
      activeForRouting: true,
      user: { role: "EVALUATOR", scopeId: opts.scopeId },
      subjects: { some: { subject: opts.subject, classNum: opts.classNum } },
    },
    include: { user: { select: { id: true, displayName: true } } },
  });

  const openCounts = new Map<string, number>();
  if (candidates.length) {
    const grouped = await prisma.evaluationTicket.groupBy({
      by: ["claimedById"],
      where: {
        claimedById: { in: candidates.map((c) => c.userId) },
        status: { in: [...OPEN_TICKET_STATUSES] },
      },
      _count: { _all: true },
    });
    for (const g of grouped) {
      if (g.claimedById) openCounts.set(g.claimedById, g._count._all);
    }
  }

  const considered: RoutingCandidate[] = [];
  const rostered: { evaluatorId: string; openTickets: number }[] = [];

  for (const c of candidates) {
    const shift = shiftFor(c.userId, c.evaluatorType);
    // A fixed-shift evaluator is one with a roster. Everyone else is the open
    // network, and is not *assigned* work — they take it off the board.
    const isRostered = shift !== null;
    const onShift = shift === null || isWithinShift(shift, at);
    const openTickets = openCounts.get(c.userId) ?? 0;
    const hasCapacity = openTickets < c.maxConcurrent;
    const reason: IneligibleReason | null = !onShift
      ? "OFF_SHIFT"
      : !hasCapacity
        ? "AT_CONCURRENCY_LIMIT"
        : null;

    considered.push({
      evaluatorId: c.userId,
      displayName: c.user.displayName,
      evaluatorType: c.evaluatorType,
      rostered: isRostered,
      onShift,
      openTickets,
      maxConcurrent: c.maxConcurrent,
      eligible: isRostered && reason === null,
      reason,
    });

    if (isRostered && reason === null) rostered.push({ evaluatorId: c.userId, openTickets });
  }

  if (rostered.length) {
    rostered.sort(
      (a, b) => a.openTickets - b.openTickets || a.evaluatorId.localeCompare(b.evaluatorId),
    );
    const pick = rostered[0];
    return {
      engine: "FIXED_SHIFT",
      assignedEvaluatorId: pick.evaluatorId,
      rationale: `Assigned to rostered staff holding ${pick.openTickets} open ticket(s).`,
      considered,
    };
  }

  return {
    engine: "OPEN_POOL",
    assignedEvaluatorId: null,
    rationale:
      candidates.length === 0
        ? "No evaluator is qualified for this subject and class; the ticket waits on the open board."
        : "No rostered evaluator is on shift with capacity; the ticket goes to the open network.",
    considered,
  };
}
