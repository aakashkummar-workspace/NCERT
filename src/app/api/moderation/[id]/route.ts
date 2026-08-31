/**
 * GET  /api/moderation/<id>/  — what has been done to this post, and by whom.
 * POST /api/moderation/<id>/  — hide, remove, restore, or dismiss.
 *
 * `<id>` is the reported post, not the report. A post gathers many reports and
 * one history, and the moderator acts on the post.
 *
 * POST is idempotent by header rather than by derivation, because repeating a
 * verb is a real thing a moderator does — hide, restore, hide again — and each
 * of those must land as its own row in the audit. The key separates "the same
 * decision, retried" from "a second decision".
 */
import { ApiError, route, v } from "@/lib/api";
import { MAX_NOTE_CHARS, auditTrail, moderatePost } from "@/lib/moderation";

function idOf(params: Record<string, string | string[]>): string {
  const id = params.id;
  if (typeof id !== "string") throw ApiError.notFound("Doubt");
  return id;
}

export const GET = route({ auth: "ADMIN" }, async ({ user, params }) => {
  return { audit: await auditTrail({ moderator: user, postId: idOf(params) }) };
});

export const POST = route(
  {
    auth: "ADMIN",
    idempotent: true,
    body: v.object({
      verb: v.enumOf(["hide", "remove", "restore", "dismiss"] as const),
      note: v.withDefault(v.string({ max: MAX_NOTE_CHARS }), ""),
    }),
  },
  async ({ user, body, params, idempotencyKey }) => {
    return moderatePost({
      moderator: user,
      postId: idOf(params),
      verb: body.verb,
      note: body.note,
      idempotencyKey,
    });
  },
);
