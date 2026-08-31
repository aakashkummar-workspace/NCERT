-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CriterionKind" ADD VALUE 'alternatives';
ALTER TYPE "CriterionKind" ADD VALUE 'branch';

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'PARENT';

-- AlterTable
ALTER TABLE "rubric_criteria" ADD COLUMN     "branchLabel" VARCHAR(16);

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "scopeId" SET DEFAULT '00000000-0000-0000-0000-000000000000';
