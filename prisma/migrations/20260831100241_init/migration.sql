-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('STUDENT', 'EVALUATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "EvaluatorType" AS ENUM ('SCHOOL_TEACHER', 'INTERNAL_TUTOR', 'FREELANCE');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('mcq', 'assertion-reason', 'vsa', 'sa', 'la', 'case-study');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('UPLOADING', 'QUEUED', 'OCR_RUNNING', 'AI_GRADING', 'AWAITING_REVIEW', 'UNDER_REVIEW', 'GRADED', 'FAILED');

-- CreateEnum
CREATE TYPE "OcrStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "RubricSource" AS ENUM ('CBSE_MARKING_SCHEME', 'AUTHORED', 'AI_GENERATED');

-- CreateEnum
CREATE TYPE "CriterionKind" AS ENUM ('step', 'choose', 'diagram', 'option');

-- CreateEnum
CREATE TYPE "RubricOrdering" AS ENUM ('ordered', 'unordered');

-- CreateEnum
CREATE TYPE "MatchMode" AS ENUM ('all', 'any');

-- CreateEnum
CREATE TYPE "PartialReason" AS ENUM ('unit-missing', 'unit-wrong', 'order-broken', 'keywords-partial', 'arithmetic-slip', 'formula-only', 'sign-error', 'unrounded');

-- CreateEnum
CREATE TYPE "GradeSource" AS ENUM ('AI', 'HUMAN');

-- CreateEnum
CREATE TYPE "CriterionVerdict" AS ENUM ('HIT', 'PARTIAL', 'MISS', 'UNMARKED');

-- CreateEnum
CREATE TYPE "UnmarkedReason" AS ENUM ('NOT_AUTO_GRADABLE', 'RUBRIC_NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "HighlightColor" AS ENUM ('GREEN', 'ORANGE', 'RED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('PENDING', 'CLAIMED', 'IN_REVIEW', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TranscriptStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "scopeId" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255),
    "displayName" VARCHAR(120),
    "role" "UserRole" NOT NULL,
    "hitlEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_profiles" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "classNum" INTEGER NOT NULL,
    "schoolName" VARCHAR(200),
    "language" VARCHAR(16) NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluator_profiles" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "evaluatorType" "EvaluatorType" NOT NULL,
    "activeForRouting" BOOLEAN NOT NULL DEFAULT true,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "evaluator_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluator_subjects" (
    "id" UUID NOT NULL,
    "evaluatorProfileId" UUID NOT NULL,
    "subject" VARCHAR(60) NOT NULL,
    "classNum" INTEGER NOT NULL,

    CONSTRAINT "evaluator_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempts" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "clientAttemptId" VARCHAR(120) NOT NULL,
    "paperSlug" VARCHAR(120) NOT NULL,
    "subject" VARCHAR(60) NOT NULL,
    "classNum" INTEGER NOT NULL,
    "maxMarks" INTEGER NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "submittedAt" TIMESTAMPTZ(6),
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "totalScore" DECIMAL(6,2),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempt_questions" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "questionNumber" INTEGER NOT NULL,
    "maxMarks" INTEGER NOT NULL,
    "type" "QuestionType" NOT NULL,
    "sectionLabel" VARCHAR(8),
    "topic" VARCHAR(60),
    "selfScore" DECIMAL(5,2),
    "attempted" BOOLEAN NOT NULL DEFAULT true,
    "awardedMarks" DECIMAL(5,2),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attempt_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "attemptId" UUID,
    "paperSlug" VARCHAR(120),
    "subject" VARCHAR(60) NOT NULL,
    "classNum" INTEGER NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'UPLOADING',
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "capturedAt" TIMESTAMPTZ(6),
    "gradedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_pages" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "pageIndex" INTEGER NOT NULL,
    "storageKey" VARCHAR(512) NOT NULL,
    "contentType" VARCHAR(64) NOT NULL,
    "bytes" INTEGER,
    "widthPx" INTEGER,
    "heightPx" INTEGER,
    "sha256" CHAR(64),
    "ocrStatus" "OcrStatus" NOT NULL DEFAULT 'PENDING',
    "ocrText" TEXT,
    "ocrCompletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "submission_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answers" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "attemptQuestionId" UUID,
    "questionNumber" INTEGER NOT NULL,
    "maxMarks" DECIMAL(5,2) NOT NULL,
    "type" "QuestionType" NOT NULL,
    "transcript" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answer_pages" (
    "answerId" UUID NOT NULL,
    "submissionPageId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "answer_pages_pkey" PRIMARY KEY ("answerId","submissionPageId")
);

-- CreateTable
CREATE TABLE "rubrics" (
    "id" UUID NOT NULL,
    "externalId" VARCHAR(160),
    "paperSlug" VARCHAR(120) NOT NULL,
    "questionNumber" INTEGER NOT NULL,
    "variant" VARCHAR(16) NOT NULL DEFAULT '',
    "session" VARCHAR(16),
    "type" "QuestionType" NOT NULL,
    "maxMarks" DECIMAL(5,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "source" "RubricSource" NOT NULL,
    "bookCode" VARCHAR(16) NOT NULL,
    "chapter" INTEGER NOT NULL,
    "subject" VARCHAR(60) NOT NULL,
    "classNum" INTEGER NOT NULL,
    "prompt" TEXT,
    "ordering" "RubricOrdering" NOT NULL DEFAULT 'unordered',
    "acceptEquivalentWording" BOOLEAN NOT NULL DEFAULT true,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewNotes" TEXT[],
    "schemeFile" VARCHAR(160),
    "schemePage" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rubrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rubric_criteria" (
    "id" UUID NOT NULL,
    "rubricId" UUID NOT NULL,
    "stepId" VARCHAR(40) NOT NULL,
    "parentId" UUID,
    "ordinal" INTEGER NOT NULL,
    "kind" "CriterionKind" NOT NULL DEFAULT 'step',
    "awardFor" VARCHAR(300) NOT NULL,
    "marks" DECIMAL(5,2),
    "marksEach" DECIMAL(5,2),
    "chooseAtLeast" INTEGER,
    "match" "MatchMode" NOT NULL DEFAULT 'all',
    "unitRequired" BOOLEAN NOT NULL DEFAULT false,
    "unitAccepted" TEXT[],
    "tags" TEXT[],
    "labels" TEXT[],
    "autoGradable" BOOLEAN NOT NULL DEFAULT true,
    "ordered" BOOLEAN,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rubric_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rubric_concepts" (
    "id" UUID NOT NULL,
    "rubricCriterionId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "phrasings" TEXT[],

    CONSTRAINT "rubric_concepts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partial_credit_rules" (
    "id" UUID NOT NULL,
    "rubricCriterionId" UUID NOT NULL,
    "reason" "PartialReason" NOT NULL,
    "award" DECIMAL(5,2) NOT NULL,
    "note" VARCHAR(300),

    CONSTRAINT "partial_credit_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rubric_tag_requirements" (
    "id" UUID NOT NULL,
    "rubricCriterionId" UUID NOT NULL,
    "tag" VARCHAR(40) NOT NULL,
    "minCount" INTEGER NOT NULL,

    CONSTRAINT "rubric_tag_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grading_results" (
    "id" UUID NOT NULL,
    "answerId" UUID NOT NULL,
    "rubricId" UUID,
    "source" "GradeSource" NOT NULL,
    "revision" INTEGER NOT NULL,
    "supersedesId" UUID,
    "awardedMarks" DECIMAL(5,2) NOT NULL,
    "maxMarks" DECIMAL(5,2) NOT NULL,
    "unmarkedCount" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION,
    "modelName" VARCHAR(80),
    "modelVersion" VARCHAR(40),
    "evaluatorId" UUID,
    "reviewId" UUID,
    "comment" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grading_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "criterion_results" (
    "id" UUID NOT NULL,
    "gradingResultId" UUID NOT NULL,
    "rubricCriterionId" UUID NOT NULL,
    "verdict" "CriterionVerdict" NOT NULL,
    "awarded" DECIMAL(5,2) NOT NULL,
    "partialRuleId" UUID,
    "unmarkedReason" "UnmarkedReason",
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "criterion_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "highlight_spans" (
    "id" UUID NOT NULL,
    "gradingResultId" UUID NOT NULL,
    "criterionResultId" UUID,
    "submissionPageId" UUID NOT NULL,
    "color" "HighlightColor" NOT NULL,
    "x" DECIMAL(6,5) NOT NULL,
    "y" DECIMAL(6,5) NOT NULL,
    "width" DECIMAL(6,5) NOT NULL,
    "height" DECIMAL(6,5) NOT NULL,
    "transcriptStart" INTEGER,
    "transcriptEnd" INTEGER,
    "label" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "highlight_spans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_tickets" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "subject" VARCHAR(60) NOT NULL,
    "classNum" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "TicketStatus" NOT NULL DEFAULT 'PENDING',
    "assignedEvaluatorId" UUID,
    "claimedById" UUID,
    "claimedAt" TIMESTAMPTZ(6),
    "leaseExpiresAt" TIMESTAMPTZ(6),
    "claimCount" INTEGER NOT NULL DEFAULT 0,
    "slaDueAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "evaluation_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluator_reviews" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "evaluatorId" UUID NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMPTZ(6),
    "agreedWithAi" BOOLEAN,
    "notes" TEXT,
    "timeSpentSec" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "evaluator_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_notes" (
    "id" UUID NOT NULL,
    "answerId" UUID NOT NULL,
    "reviewId" UUID,
    "evaluatorId" UUID NOT NULL,
    "storageKey" VARCHAR(512) NOT NULL,
    "mimeType" VARCHAR(64) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "bytes" INTEGER,
    "transcript" TEXT,
    "transcriptLang" VARCHAR(16),
    "transcriptStatus" "TranscriptStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "voice_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_scopeId_role_idx" ON "users"("scopeId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "users_scopeId_phone_key" ON "users"("scopeId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_scopeId_email_key" ON "users"("scopeId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_userId_key" ON "student_profiles"("userId");

-- CreateIndex
CREATE INDEX "student_profiles_classNum_idx" ON "student_profiles"("classNum");

-- CreateIndex
CREATE UNIQUE INDEX "evaluator_profiles_userId_key" ON "evaluator_profiles"("userId");

-- CreateIndex
CREATE INDEX "evaluator_profiles_activeForRouting_evaluatorType_idx" ON "evaluator_profiles"("activeForRouting", "evaluatorType");

-- CreateIndex
CREATE INDEX "evaluator_subjects_subject_classNum_idx" ON "evaluator_subjects"("subject", "classNum");

-- CreateIndex
CREATE UNIQUE INDEX "evaluator_subjects_evaluatorProfileId_subject_classNum_key" ON "evaluator_subjects"("evaluatorProfileId", "subject", "classNum");

-- CreateIndex
CREATE INDEX "attempts_studentId_startedAt_idx" ON "attempts"("studentId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "attempts_studentId_status_idx" ON "attempts"("studentId", "status");

-- CreateIndex
CREATE INDEX "attempts_paperSlug_idx" ON "attempts"("paperSlug");

-- CreateIndex
CREATE UNIQUE INDEX "attempts_studentId_clientAttemptId_key" ON "attempts"("studentId", "clientAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "attempt_questions_attemptId_questionNumber_key" ON "attempt_questions"("attemptId", "questionNumber");

-- CreateIndex
CREATE INDEX "submissions_studentId_createdAt_idx" ON "submissions"("studentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "submissions_status_createdAt_idx" ON "submissions"("status", "createdAt");

-- CreateIndex
CREATE INDEX "submissions_attemptId_idx" ON "submissions"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_studentId_idempotencyKey_key" ON "submissions"("studentId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "submission_pages_ocrStatus_createdAt_idx" ON "submission_pages"("ocrStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "submission_pages_submissionId_pageIndex_key" ON "submission_pages"("submissionId", "pageIndex");

-- CreateIndex
CREATE INDEX "answers_attemptQuestionId_idx" ON "answers"("attemptQuestionId");

-- CreateIndex
CREATE UNIQUE INDEX "answers_submissionId_questionNumber_key" ON "answers"("submissionId", "questionNumber");

-- CreateIndex
CREATE INDEX "answer_pages_submissionPageId_idx" ON "answer_pages"("submissionPageId");

-- CreateIndex
CREATE INDEX "rubrics_paperSlug_questionNumber_idx" ON "rubrics"("paperSlug", "questionNumber");

-- CreateIndex
CREATE INDEX "rubrics_bookCode_chapter_idx" ON "rubrics"("bookCode", "chapter");

-- CreateIndex
CREATE INDEX "rubrics_subject_classNum_idx" ON "rubrics"("subject", "classNum");

-- CreateIndex
CREATE INDEX "rubrics_needsReview_idx" ON "rubrics"("needsReview");

-- CreateIndex
CREATE UNIQUE INDEX "rubrics_externalId_version_key" ON "rubrics"("externalId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "rubrics_paperSlug_questionNumber_variant_version_key" ON "rubrics"("paperSlug", "questionNumber", "variant", "version");

-- CreateIndex
CREATE INDEX "rubric_criteria_parentId_idx" ON "rubric_criteria"("parentId");

-- CreateIndex
CREATE INDEX "rubric_criteria_rubricId_ordinal_idx" ON "rubric_criteria"("rubricId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "rubric_criteria_rubricId_stepId_key" ON "rubric_criteria"("rubricId", "stepId");

-- CreateIndex
CREATE UNIQUE INDEX "rubric_concepts_rubricCriterionId_ordinal_key" ON "rubric_concepts"("rubricCriterionId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "partial_credit_rules_rubricCriterionId_reason_key" ON "partial_credit_rules"("rubricCriterionId", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "rubric_tag_requirements_rubricCriterionId_tag_key" ON "rubric_tag_requirements"("rubricCriterionId", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "grading_results_supersedesId_key" ON "grading_results"("supersedesId");

-- CreateIndex
CREATE INDEX "grading_results_answerId_createdAt_idx" ON "grading_results"("answerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "grading_results_evaluatorId_createdAt_idx" ON "grading_results"("evaluatorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "grading_results_reviewId_idx" ON "grading_results"("reviewId");

-- CreateIndex
CREATE UNIQUE INDEX "grading_results_answerId_revision_key" ON "grading_results"("answerId", "revision");

-- CreateIndex
CREATE INDEX "criterion_results_verdict_unmarkedReason_idx" ON "criterion_results"("verdict", "unmarkedReason");

-- CreateIndex
CREATE INDEX "criterion_results_partialRuleId_idx" ON "criterion_results"("partialRuleId");

-- CreateIndex
CREATE UNIQUE INDEX "criterion_results_gradingResultId_rubricCriterionId_key" ON "criterion_results"("gradingResultId", "rubricCriterionId");

-- CreateIndex
CREATE INDEX "highlight_spans_gradingResultId_idx" ON "highlight_spans"("gradingResultId");

-- CreateIndex
CREATE INDEX "highlight_spans_submissionPageId_idx" ON "highlight_spans"("submissionPageId");

-- CreateIndex
CREATE INDEX "highlight_spans_criterionResultId_idx" ON "highlight_spans"("criterionResultId");

-- CreateIndex
CREATE UNIQUE INDEX "evaluation_tickets_submissionId_key" ON "evaluation_tickets"("submissionId");

-- CreateIndex
CREATE INDEX "evaluation_tickets_status_priority_createdAt_idx" ON "evaluation_tickets"("status", "priority" DESC, "createdAt");

-- CreateIndex
CREATE INDEX "evaluation_tickets_status_subject_classNum_priority_created_idx" ON "evaluation_tickets"("status", "subject", "classNum", "priority" DESC, "createdAt");

-- CreateIndex
CREATE INDEX "evaluation_tickets_status_leaseExpiresAt_idx" ON "evaluation_tickets"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "evaluation_tickets_claimedById_status_idx" ON "evaluation_tickets"("claimedById", "status");

-- CreateIndex
CREATE INDEX "evaluation_tickets_assignedEvaluatorId_status_idx" ON "evaluation_tickets"("assignedEvaluatorId", "status");

-- CreateIndex
CREATE INDEX "evaluator_reviews_ticketId_startedAt_idx" ON "evaluator_reviews"("ticketId", "startedAt");

-- CreateIndex
CREATE INDEX "evaluator_reviews_evaluatorId_submittedAt_idx" ON "evaluator_reviews"("evaluatorId", "submittedAt" DESC);

-- CreateIndex
CREATE INDEX "voice_notes_answerId_createdAt_idx" ON "voice_notes"("answerId", "createdAt");

-- CreateIndex
CREATE INDEX "voice_notes_reviewId_idx" ON "voice_notes"("reviewId");

-- CreateIndex
CREATE INDEX "voice_notes_transcriptStatus_createdAt_idx" ON "voice_notes"("transcriptStatus", "createdAt");

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluator_profiles" ADD CONSTRAINT "evaluator_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluator_subjects" ADD CONSTRAINT "evaluator_subjects_evaluatorProfileId_fkey" FOREIGN KEY ("evaluatorProfileId") REFERENCES "evaluator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_pages" ADD CONSTRAINT "submission_pages_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_attemptQuestionId_fkey" FOREIGN KEY ("attemptQuestionId") REFERENCES "attempt_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_pages" ADD CONSTRAINT "answer_pages_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "answers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_pages" ADD CONSTRAINT "answer_pages_submissionPageId_fkey" FOREIGN KEY ("submissionPageId") REFERENCES "submission_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rubric_criteria" ADD CONSTRAINT "rubric_criteria_rubricId_fkey" FOREIGN KEY ("rubricId") REFERENCES "rubrics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rubric_criteria" ADD CONSTRAINT "rubric_criteria_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "rubric_criteria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rubric_concepts" ADD CONSTRAINT "rubric_concepts_rubricCriterionId_fkey" FOREIGN KEY ("rubricCriterionId") REFERENCES "rubric_criteria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partial_credit_rules" ADD CONSTRAINT "partial_credit_rules_rubricCriterionId_fkey" FOREIGN KEY ("rubricCriterionId") REFERENCES "rubric_criteria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rubric_tag_requirements" ADD CONSTRAINT "rubric_tag_requirements_rubricCriterionId_fkey" FOREIGN KEY ("rubricCriterionId") REFERENCES "rubric_criteria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_results" ADD CONSTRAINT "grading_results_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "answers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_results" ADD CONSTRAINT "grading_results_rubricId_fkey" FOREIGN KEY ("rubricId") REFERENCES "rubrics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_results" ADD CONSTRAINT "grading_results_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "grading_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_results" ADD CONSTRAINT "grading_results_evaluatorId_fkey" FOREIGN KEY ("evaluatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_results" ADD CONSTRAINT "grading_results_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "evaluator_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "criterion_results" ADD CONSTRAINT "criterion_results_gradingResultId_fkey" FOREIGN KEY ("gradingResultId") REFERENCES "grading_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "criterion_results" ADD CONSTRAINT "criterion_results_rubricCriterionId_fkey" FOREIGN KEY ("rubricCriterionId") REFERENCES "rubric_criteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "criterion_results" ADD CONSTRAINT "criterion_results_partialRuleId_fkey" FOREIGN KEY ("partialRuleId") REFERENCES "partial_credit_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "highlight_spans" ADD CONSTRAINT "highlight_spans_gradingResultId_fkey" FOREIGN KEY ("gradingResultId") REFERENCES "grading_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "highlight_spans" ADD CONSTRAINT "highlight_spans_criterionResultId_fkey" FOREIGN KEY ("criterionResultId") REFERENCES "criterion_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "highlight_spans" ADD CONSTRAINT "highlight_spans_submissionPageId_fkey" FOREIGN KEY ("submissionPageId") REFERENCES "submission_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_tickets" ADD CONSTRAINT "evaluation_tickets_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_tickets" ADD CONSTRAINT "evaluation_tickets_assignedEvaluatorId_fkey" FOREIGN KEY ("assignedEvaluatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_tickets" ADD CONSTRAINT "evaluation_tickets_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluator_reviews" ADD CONSTRAINT "evaluator_reviews_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "evaluation_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluator_reviews" ADD CONSTRAINT "evaluator_reviews_evaluatorId_fkey" FOREIGN KEY ("evaluatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_notes" ADD CONSTRAINT "voice_notes_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "answers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_notes" ADD CONSTRAINT "voice_notes_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "evaluator_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_notes" ADD CONSTRAINT "voice_notes_evaluatorId_fkey" FOREIGN KEY ("evaluatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
