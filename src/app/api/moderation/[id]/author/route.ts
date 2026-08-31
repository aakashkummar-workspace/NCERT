/**
 * POST /api/moderation/<id>/author/  — who actually wrote this.
 *
 * The endpoint the whole Shadow Mode design exists to make possible. A
 * pseudonym is a label, not a wall: a moderator holding a credible report can
 * always find the person behind it, which is what makes anonymity safe to offer
 * to children in the first place. src/lib/shadow.ts says this at length.
 *
 * It is a POST rather than a GET because it *writes*. Identifying a minor is
 * recorded as an action, with the moderator's name on it and a reason they had
 * to type, before the identity is read. A `reason` is required and an
 * `Idempotency-Key` is required — both are friction, and the friction is the
 * feature. This should never be something a moderator does absent-mindedly
 * while scrolling.
 *
 * The response deliberately carries no phone number. It answers "who", which is
 * what deciding a report needs; reaching a child's guardian is a heavier act
 * that deserves its own justification and should not fall out of a click here.
 */
import { ApiError, route, v } from "@/lib/api";
import { revealAuthor } from "@/lib/moderation";

export const POST = route(
  {
    auth: "ADMIN",
    idempotent: true,
    body: v.object({ reason: v.string({ min: 4, max: 500 }) }),
  },
  async ({ user, body, params, idempotencyKey }) => {
    const id = params.id;
    if (typeof id !== "string") throw ApiError.notFound("Doubt");
    return { author: await revealAuthor({ moderator: user, postId: id, reason: body.reason, idempotencyKey }) };
  },
);
