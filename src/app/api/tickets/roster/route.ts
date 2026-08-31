/**
 * GET /api/tickets/roster/ — who is on, and who would get the next script.
 *
 * The operational question behind the dual-engine queue: at 23:30 on a Tuesday,
 * which tuition staff are rostered, how much capacity do they have left, and
 * does a Class 10 Science script go to them or to the open network? Whoever
 * plans a shift needs to be able to ask that about a *future* instant, not only
 * about now, which is why `at` is a parameter.
 *
 * That parameter is also what makes the overnight case checkable rather than
 * merely argued. The specification this replaces compared a bare `TIME` column
 * against `new Date()`, which matches no rows at all for a 22:00–02:00 shift —
 * the shift with the most demand in a product whose peak is Indian evenings.
 * `?at=2026-09-01T18:30:00Z` is 00:00 IST, and this route says in as many words
 * whether the night shift is on.
 *
 * Admin-only, and scoped: an admin is an admin *of a scope*. The roster of one
 * school is not the business of another, and the query that forgets that is the
 * one nobody re-reads once tenancy lands.
 *
 * `at` and the subject/class pair are query parameters rather than session
 * facts because they are not identity — they are the question being asked. Who
 * is asking still comes from the session, and nothing here reads a user out of
 * the request.
 */
import { ApiError, route } from "@/lib/api";
import prisma from "@/lib/db";
import {
  decideRouting,
  isWithinShift,
  OPEN_TICKET_STATUSES,
  shiftFor,
  type Shift,
} from "@/lib/queue";

export const GET = route({ auth: "ADMIN" }, async ({ user, req }) => {
  const params = req.nextUrl.searchParams;

  const atRaw = params.get("at");
  const at = atRaw ? new Date(atRaw) : new Date();
  if (Number.isNaN(at.getTime())) {
    throw ApiError.validation([{ path: "at", message: "must be an ISO-8601 instant" }]);
  }

  const profiles = await prisma.evaluatorProfile.findMany({
    where: { user: { role: "EVALUATOR", scopeId: user.scopeId } },
    include: {
      user: { select: { id: true, displayName: true } },
      subjects: true,
    },
  });

  const open = await prisma.evaluationTicket.groupBy({
    by: ["claimedById"],
    where: {
      claimedById: { in: profiles.map((p) => p.userId) },
      status: { in: [...OPEN_TICKET_STATUSES] },
    },
    _count: { _all: true },
  });
  const openBy = new Map(open.filter((g) => g.claimedById).map((g) => [g.claimedById!, g._count._all]));

  const roster = profiles.map((p) => {
    const shift: Shift | null = shiftFor(p.userId, p.evaluatorType);
    const openTickets = openBy.get(p.userId) ?? 0;
    return {
      evaluatorId: p.userId,
      displayName: p.user.displayName,
      evaluatorType: p.evaluatorType,
      activeForRouting: p.activeForRouting,
      /** Null means no fixed hours — the open gig network, not a missing roster. */
      shift,
      /** True for an unrostered evaluator: they are never *off* shift. */
      onShift: shift === null || isWithinShift(shift, at),
      /** True when a shift crosses midnight, which is the case the old spec lost. */
      overnight: shift !== null && shift.startMinute > shift.endMinute,
      openTickets,
      maxConcurrent: p.maxConcurrent,
      hasCapacity: openTickets < p.maxConcurrent,
      qualifications: p.subjects.map((s) => ({ subject: s.subject, classNum: s.classNum })),
    };
  });

  // Optional: what would happen to a script for this subject and class, at `at`.
  const subject = params.get("subject");
  const classNumRaw = params.get("classNum");
  let routing = null;
  if (subject && classNumRaw) {
    const classNum = Number(classNumRaw);
    if (!Number.isInteger(classNum)) {
      throw ApiError.validation([{ path: "classNum", message: "must be an integer" }]);
    }
    routing = await decideRouting({ scopeId: user.scopeId, subject, classNum, at });
  }

  return { at: at.toISOString(), roster, routing };
});
