/**
 * The one Prisma client, and the reason it is stashed on `globalThis`.
 *
 * Next.js hot-reloads by throwing away the module registry and re-evaluating
 * modules, so in dev a plain `new PrismaClient()` at module scope constructs a
 * fresh client — and a fresh connection pool — on every save. Postgres runs out
 * of connections long before the developer runs out of edits, and the failure
 * looks like a slow database rather than a leak. Caching on `globalThis`, which
 * survives the reload, is the standard fix.
 *
 * In production the module is evaluated once per process, so the cache is not
 * needed and is deliberately not populated: a value on `globalThis` that is
 * only ever written and never read is a trap for the next reader.
 *
 * This module is server-only. It must never be imported from a `"use client"`
 * file — the app is a static export today, and pulling `@prisma/client` into
 * the browser bundle fails at build time rather than at runtime, which is the
 * good outcome. The client-side stores (src/lib/attempts.ts, quiz-attempts.ts,
 * revision.ts) remain Dexie and are unaffected by anything here.
 */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Queries are noisy but they are the point of having a dev log at all;
    // in production only the things a human must act on.
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
