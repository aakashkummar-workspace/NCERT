/**
 * POST /api/doubts/<id>/resolve/  — "I understand it now."
 *
 * No `Idempotency-Key`: resolving is setting a field to a value, so a retry
 * lands on the same state and returns the same row. Demanding a key for an
 * operation that is already idempotent is ceremony, and ceremony on a flaky
 * connection is a student tapping a button that does nothing.
 */
import { route, v, ApiError } from "@/lib/api";
import { resolveDoubt } from "@/lib/doubts";

export const POST = route(
  {
    auth: ["STUDENT", "ADMIN"],
    body: v.object({ resolved: v.withDefault(v.boolean(), true) }),
  },
  async ({ user, body, params }) => {
    const id = params.id;
    if (typeof id !== "string") throw ApiError.notFound("Doubt");
    const doubt = await resolveDoubt({ actor: user, doubtId: id, resolved: body.resolved });
    return { doubt };
  },
);
