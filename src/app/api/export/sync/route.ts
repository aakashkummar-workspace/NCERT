/**
 * POST /api/export/sync/ — push an export to a school's LMS. ADMIN only.
 *
 * **This is a stub, and it throws.** It is here as one documented endpoint
 * rather than as a speculative integration, because the PRD asks for
 * "automated RESTful sync" and nobody has yet named an LMS, an auth model, a
 * schedule or a failure policy. Building against an imagined one produces code
 * that is wrong in a way nobody can see until the first real school arrives.
 *
 * It follows the same rule as the S3 storage driver in src/lib/storage.ts, and
 * for the same reason: **a sync that silently succeeds while sending nothing is
 * discovered when a school asks where their marks went.** So it returns
 * `NOT_AVAILABLE` (503) with the exact reason, and the CSV export beside it
 * works today.
 *
 * ## What a real implementation needs, so the next lane does not have to guess
 *
 *  - **A destination and a credential**, per scope, not per deployment: one
 *    school's LMS token must not be readable by another's admin. The schema has
 *    no table for that — `scopeId` is a bare UUID column with no `tenants` row
 *    behind it — so this needs the tenancy retrofit prisma/README.md describes,
 *    or a secrets store outside Postgres.
 *  - **A cursor**, so a nightly push sends what changed. `Attempt.updatedAt` and
 *    `GradingResult.createdAt` are both indexed and either would serve.
 *  - **Idempotency at the far end.** Ours does not help: retrying a push that
 *    the LMS already applied is the LMS's problem to deduplicate, so the
 *    payload needs a stable per-row key. `student_id` plus `attempt id` is one.
 *  - **The same disclosure gate.** Whatever is pushed must be built from
 *    `ATTEMPT_COLUMNS` / `CHAPTER_COLUMNS`, not assembled fresh, or the rule
 *    that an export cannot exceed what a parent may see is enforced in one
 *    place and not the other.
 *  - **A decision about consent.** A CSV is pulled by an admin who already has
 *    the data. A push sends a student's marks to a third-party system on a
 *    timer, which is a different thing to have agreed to, and this lane does
 *    not think an admin can agree to it on the student's behalf without
 *    somebody saying so out loud.
 */
import { ApiError, route, v } from "@/lib/api";

export const POST = route(
  {
    auth: "ADMIN",
    idempotent: true,
    body: v.object({
      dataset: v.enumOf(["attempts", "chapters"] as const),
      since: v.optional(v.date()),
    }),
  },
  async () => {
    throw new ApiError(
      "NOT_AVAILABLE",
      "No LMS destination is configured for this scope. Use GET /api/export/?dataset=attempts for a CSV in the meantime. See the notes in this route's source for what a real sync needs.",
    );
  },
);
