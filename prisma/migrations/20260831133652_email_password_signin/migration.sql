-- Email + password sign-in, added alongside the OTP flow rather than in place
-- of it. Three changes, one of which needs explaining.
--
--   1. "passwordHash" — nullable, because an OTP-only or seeded account has no
--      password and that must stay legal. It is self-describing
--      (`scrypt$N$r$p$dkLen$salt$hash`), so the cost parameters can be raised
--      later without having to guess what an existing row was hashed with.
--   2. "phone" drops NOT NULL, because an account created with an email has no
--      number to put there.
--   3. "user_has_identifier" — the constraint that pays for (2).
--
-- ## Why (3) is not optional
--
-- The schema comment above `phone` made it NOT NULL deliberately: **NULLs are
-- distinct in a Postgres unique index**, so `@@unique([scopeId, phone])` does
-- not constrain NULL rows at all. Make the column nullable on its own and the
-- database will happily accept ten thousand users in one scope with no phone,
-- no email and nothing to tell them apart — the unique index silently stops
-- being an identity constraint.
--
-- That reasoning is correct and still applies; it is only the *shape* that
-- changes. NOT NULL said "everyone has a phone". The honest replacement is
-- "everyone has at least one identifier", which is what the CHECK says, with
-- both scoped uniques still doing their job wherever the value is present.
-- Empty strings are excluded explicitly: '' is not NULL, so without the length
-- test it would satisfy the CHECK while identifying nobody, and — being a real
-- value — it would collide under the unique index, letting exactly one
-- identifier-less user exist per scope and no more. Both halves of that are
-- confusing failures to debug later.
--
-- Column names are quoted camelCase, per the note at the top of
-- prisma/migrations/20260831100300_check_constraints/migration.sql: the models
-- carry @@map for tables but no @map on any field, so snake_case does not run.
--
-- Additive and non-destructive: existing rows all have a phone and satisfy the
-- CHECK as they stand, so nothing is rewritten and nothing is lost.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "passwordHash" VARCHAR(255),
ALTER COLUMN "scopeId" SET DEFAULT '00000000-0000-0000-0000-000000000000',
ALTER COLUMN "phone" DROP NOT NULL;

-- The replacement for NOT NULL. Not `IS NOT NULL` alone — see above.
ALTER TABLE "users"
  ADD CONSTRAINT "user_has_identifier" CHECK (
    length(coalesce("phone", '')) > 0 OR length(coalesce("email", '')) > 0
  );
