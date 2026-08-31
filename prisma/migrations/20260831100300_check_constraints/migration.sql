-- The invariants Prisma's schema language cannot express, transcribed from
-- prisma/README.md ("Constraints Prisma cannot express").
--
-- Two departures from the SQL as written there, both mechanical:
--
--   1. Column names are quoted camelCase ("durationMs"), not snake_case. The
--      models carry @@map for table names but no @map on any field, so Prisma
--      emitted the field names verbatim. The README's SQL predates the
--      generated migration and would fail as printed.
--   2. Enum members are compared as their *mapped* values where a @map exists
--      ('step', 'choose', …) and as their Prisma names where none does
--      ('AI', 'UNMARKED', …). Getting this backwards is a silent no-op on some
--      of these, so each cast below is against the enum the column declares.
--
-- These live in their own migration rather than hand-edited into `init` so that
-- `init` stays exactly what `prisma migrate dev` generates and can be
-- regenerated without losing them.

ALTER TABLE "voice_notes"
  ADD CONSTRAINT "voice_note_max_90s" CHECK ("durationMs" > 0 AND "durationMs" <= 90000);

ALTER TABLE "grading_results"
  ADD CONSTRAINT "grade_within_max" CHECK ("awardedMarks" >= 0 AND "awardedMarks" <= "maxMarks"),
  ADD CONSTRAINT "grade_revision_positive" CHECK ("revision" >= 1),
  -- An AI grade has no evaluator; a human grade has one.
  ADD CONSTRAINT "grade_source_consistent" CHECK (
    ("source" = 'AI'::"GradeSource"    AND "evaluatorId" IS NULL) OR
    ("source" = 'HUMAN'::"GradeSource" AND "evaluatorId" IS NOT NULL)
  ),
  ADD CONSTRAINT "grade_unmarked_count_non_negative" CHECK ("unmarkedCount" >= 0);

ALTER TABLE "highlight_spans"
  ADD CONSTRAINT "highlight_box_normalised" CHECK (
    "x" >= 0 AND "y" >= 0 AND "width" > 0 AND "height" > 0 AND
    "x" + "width" <= 1 AND "y" + "height" <= 1
  );

ALTER TABLE "attempt_questions"
  ADD CONSTRAINT "self_score_within_max" CHECK (
    "selfScore" IS NULL OR ("selfScore" >= 0 AND "selfScore" <= "maxMarks")
  );

ALTER TABLE "student_profiles"
  -- Relax this the day Class 11 ships. Failing loudly at insert is the point:
  -- the alternative is /progress quietly filling with a class we have no books for.
  ADD CONSTRAINT "class_supported" CHECK ("classNum" IN (9, 10));

ALTER TABLE "criterion_results"
  -- UNMARKED and MISS both award zero and mean opposite things; only UNMARKED
  -- carries a reason, and only PARTIAL names a rule.
  ADD CONSTRAINT "criterion_verdict_consistent" CHECK (
    ("verdict" = 'UNMARKED'::"CriterionVerdict"
       AND "awarded" = 0 AND "unmarkedReason" IS NOT NULL AND "partialRuleId" IS NULL) OR
    ("verdict" = 'MISS'::"CriterionVerdict"
       AND "awarded" = 0 AND "unmarkedReason" IS NULL AND "partialRuleId" IS NULL) OR
    ("verdict" = 'PARTIAL'::"CriterionVerdict"
       AND "awarded" > 0 AND "unmarkedReason" IS NULL) OR
    ("verdict" = 'HIT'::"CriterionVerdict"
       AND "awarded" > 0 AND "unmarkedReason" IS NULL AND "partialRuleId" IS NULL)
  );

ALTER TABLE "rubric_criteria"
  -- Exactly one of marks / marksEach is set, and only a CHOOSE group counts.
  ADD CONSTRAINT "criterion_marks_by_kind" CHECK (
    ("kind" IN ('step'::"CriterionKind", 'diagram'::"CriterionKind")
       AND "marks" IS NOT NULL AND "marksEach" IS NULL AND "chooseAtLeast" IS NULL) OR
    ("kind" = 'choose'::"CriterionKind"
       AND "marks" IS NULL AND "marksEach" IS NOT NULL AND "chooseAtLeast" >= 1) OR
    ("kind" = 'option'::"CriterionKind"
       AND "marks" IS NULL AND "marksEach" IS NULL AND "chooseAtLeast" IS NULL)
  ),
  -- Every award is a positive multiple of 0.5 — the finest grain CBSE uses.
  ADD CONSTRAINT "criterion_marks_half" CHECK (
    ("marks"     IS NULL OR ("marks"     > 0 AND ("marks"     * 2) = trunc("marks"     * 2))) AND
    ("marksEach" IS NULL OR ("marksEach" > 0 AND ("marksEach" * 2) = trunc("marksEach" * 2)))
  ),
  -- An OPTION has a parent; nothing else does. Options are order-free, so
  -- `ordered` is meaningless on one.
  ADD CONSTRAINT "option_has_parent" CHECK (
    ("kind" = 'option'::"CriterionKind") = ("parentId" IS NOT NULL)
  ),
  ADD CONSTRAINT "option_not_ordered" CHECK (
    "kind" <> 'option'::"CriterionKind" OR "ordered" IS NULL
  ),
  -- A diagram step may not claim to be auto-gradable: a matcher cannot judge a
  -- photograph of a triangle.
  ADD CONSTRAINT "diagram_not_auto_gradable" CHECK (
    "kind" <> 'diagram'::"CriterionKind" OR "autoGradable" = FALSE
  );

ALTER TABLE "rubric_concepts"
  ADD CONSTRAINT "concept_has_phrasings" CHECK (cardinality("phrasings") > 0);

ALTER TABLE "partial_credit_rules"
  ADD CONSTRAINT "partial_award_half" CHECK ("award" > 0 AND ("award" * 2) = trunc("award" * 2));

ALTER TABLE "rubric_tag_requirements"
  ADD CONSTRAINT "tag_min_count_positive" CHECK ("minCount" >= 1);

-- Not in the README, but the same class of thing and free to add now: a
-- rubric's own maxMarks and an evaluator's concurrency budget are both numbers
-- the application would otherwise have to be trusted with.
ALTER TABLE "rubrics"
  ADD CONSTRAINT "rubric_max_marks_positive" CHECK ("maxMarks" > 0);

ALTER TABLE "evaluator_profiles"
  ADD CONSTRAINT "evaluator_max_concurrent_positive" CHECK ("maxConcurrent" >= 1);
