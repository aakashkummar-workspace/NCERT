/**
 * GET    /api/doubts/<id>/  — one thread: the doubt and its replies.
 * DELETE /api/doubts/<id>/  — the author's own erasure path.
 *
 * DELETE is the student's right to take back something they wrote, and it is
 * deliberately *not* the moderator's tool: a moderator removes, which keeps the
 * row so a pattern of behaviour survives the post. src/lib/moderation.ts.
 */
import { route, ApiError } from "@/lib/api";
import { deleteOwnPost, readThread } from "@/lib/doubts";

function idOf(params: Record<string, string | string[]>): string {
  const id = params.id;
  if (typeof id !== "string") throw ApiError.notFound("Doubt");
  return id;
}

export const GET = route({ auth: ["STUDENT", "ADMIN"] }, async ({ user, params }) => {
  return readThread({ viewer: user, doubtId: idOf(params) });
});

export const DELETE = route({ auth: "STUDENT" }, async ({ user, params }) => {
  await deleteOwnPost({ actor: user, postId: idOf(params) });
  return { deleted: true };
});
