/**
 * POST /api/parent/consent/  { parentUserId, decision }  STUDENT only.
 *
 * The student's answer: GRANT, DECLINE, or REVOKE. This is the only route that
 * can turn a request into access, and only a student may call it.
 *
 * `parentUserId` is a *selector among the caller's own pending requests*, not an
 * identity — `recordDecision` looks it up inside the set of links belonging to
 * the acting student and 404s otherwise, so it can only ever name a parent who
 * already asked this student. The acting user is still the session's and only
 * the session's, per docs/PLATFORM.md §1.
 *
 * REVOKE takes effect on the parent's very next request: `requireConsentedLink`
 * re-reads the ledger every call and holds no cache. "You can take this away
 * whenever you like" is a promise about latency as much as about a button.
 *
 * Idempotent, and idempotent in the way that matters on a train: a student who
 * taps "revoke" three times on a stalled connection gets one ledger line and
 * one revocation, not three.
 */
import { route, v } from "@/lib/api";
import { recordDecision } from "@/lib/parent";

export const POST = route(
  {
    auth: "STUDENT",
    idempotent: true,
    body: v.object({
      parentUserId: v.uuid(),
      decision: v.enumOf(["GRANT", "DECLINE", "REVOKE"] as const),
    }),
  },
  async ({ user, body, idempotencyKey }) => {
    const link = await recordDecision({
      studentUserId: user.id,
      parentUserId: body.parentUserId,
      decision: body.decision,
      idempotencyKey,
    });

    return {
      parentUserId: link.parentUserId,
      status: link.status,
      decidedAt: link.decidedAt?.toISOString() ?? null,
    };
  },
);
