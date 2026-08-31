/**
 * GET  /api/grading/rubrics/   what the grader can actually mark against
 * POST /api/grading/rubrics/   load data/rubrics.json into the database (ADMIN)
 *
 * The GET is the honest inventory: how many rubrics exist, how many are flagged
 * `needsReview` — which is the common case, not an edge case, and the reason
 * most misses come back unmarked rather than red — and which authored rubrics
 * the database does not hold at all. A question with no rubric is a student
 * whose answer nothing can grade, and that is worth being able to see rather
 * than discovering one submission at a time.
 *
 * The POST re-runs the import. It is idempotent by construction: ids are
 * derived from the authored id exactly as `prisma/seed.ts` derives them, so
 * running both is running one.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { route, v } from "@/lib/api";
import prisma from "@/lib/db";
import { importRubricsFromFile } from "@/lib/rubric-load";

async function authoredIds(): Promise<string[]> {
  const file = path.resolve(process.cwd(), "data/rubrics.json");
  const parsed = JSON.parse(await readFile(file, "utf8")) as
    | { id: string }[]
    | { rubrics?: { id: string }[]; items?: { id: string }[] };
  const list = Array.isArray(parsed) ? parsed : (parsed.rubrics ?? parsed.items ?? []);
  return list.map((r) => r.id);
}

export const GET = route({ auth: ["EVALUATOR", "ADMIN"] }, async () => {
  const [total, needsReview, rows] = await Promise.all([
    prisma.rubric.count(),
    prisma.rubric.count({ where: { needsReview: true } }),
    prisma.rubric.findMany({
      select: { externalId: true, paperSlug: true, questionNumber: true, variant: true, needsReview: true },
      orderBy: [{ paperSlug: "asc" }, { questionNumber: "asc" }],
    }),
  ]);
  const stored = new Set(rows.map((r) => r.externalId).filter(Boolean) as string[]);
  const missing = (await authoredIds()).filter((id) => !stored.has(id));

  return {
    total,
    needsReview,
    /** Authored in data/rubrics.json but not in the database, so ungradable. */
    missing,
    rubrics: rows,
  };
});

export const POST = route(
  {
    auth: "ADMIN",
    idempotent: true,
    body: v.object({
      /** Authored ids to load. Omit for the whole file. */
      only: v.optional(v.array(v.string({ max: 160 }), { min: 1, max: 400 })),
    }),
  },
  async ({ body }) => {
    const report = await importRubricsFromFile(body.only ? { only: body.only } : {});
    return {
      imported: report.imported.length,
      // Named, never counted away. A rubric the database refused is a question
      // no student can be graded on, and the reason belongs in the response.
      rejected: report.rejected,
    };
  },
);
