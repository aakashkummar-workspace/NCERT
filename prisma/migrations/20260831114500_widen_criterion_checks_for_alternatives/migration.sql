-- Widen two CHECK constraints so `alternatives` / `branch` criteria can exist.
--
-- `20260831100300_check_constraints` was written before `CriterionKind` gained
-- ALTERNATIVES and BRANCH, so both constraints silently reject every such row:
-- `criterion_marks_by_kind` has no disjunct for them and therefore evaluates
-- FALSE, and `option_has_parent` asserts an exact equivalence between "is an
-- option" and "has a parent" — which a BRANCH, and a branch's own steps, both
-- break. The symptom was that class10-science-2025-26-q28 could not be stored,
-- which is CBSE's OR *inside* a question: the case the kinds were added for.

ALTER TABLE "rubric_criteria" DROP CONSTRAINT "criterion_marks_by_kind";
ALTER TABLE "rubric_criteria" ADD CONSTRAINT "criterion_marks_by_kind" CHECK (
  ("kind" IN ('step','diagram','alternatives','branch') AND "marks" IS NOT NULL
     AND "marksEach" IS NULL AND "chooseAtLeast" IS NULL) OR
  ("kind" = 'choose' AND "marks" IS NULL AND "marksEach" IS NOT NULL AND "chooseAtLeast" >= 1) OR
  ("kind" = 'option' AND "marks" IS NULL AND "marksEach" IS NULL AND "chooseAtLeast" IS NULL));

-- An OPTION or a BRANCH must hang under a parent; a branch's own steps may too,
-- so this is an implication, not an equivalence.
ALTER TABLE "rubric_criteria" DROP CONSTRAINT "option_has_parent";
ALTER TABLE "rubric_criteria" ADD CONSTRAINT "child_has_parent" CHECK (
  ("kind" IN ('option','branch')) <= ("parentId" IS NOT NULL));
