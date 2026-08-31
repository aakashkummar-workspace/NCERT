/**
 * POST /api/tickets/sweep/ — return every expired lease to the pool.
 *
 * Run from a cron, once a minute. This is the whole reason there is no
 * heartbeat service and no presence channel: a tutor who shuts their laptop
 * mid-review, loses signal on a train, or simply walks away does not strand a
 * student's script. The lease runs out and the ticket goes back on the board.
 *
 * It is admin-only rather than public because a sweep is a write, and because
 * an unauthenticated endpoint that resets ticket state is a denial-of-service
 * against the queue if the lease duration is ever misconfigured. A scheduler
 * calls it with an admin session, the same as any other operator action.
 *
 * The statement itself is scope-blind on purpose — an expired lease is expired
 * for everyone, and a sweeper that only cleaned one tenant would leave the
 * others' tickets stuck. It is the one query in this lane that does not filter
 * by `scopeId`, and it says so here so the omission reads as a decision.
 */
import { route } from "@/lib/api";
import { sweepExpiredLeases } from "@/lib/queue";

export const POST = route({ auth: "ADMIN" }, async () => {
  const released = await sweepExpiredLeases();
  return { released: released.length, ticketIds: released };
});
