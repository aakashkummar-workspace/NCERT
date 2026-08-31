# The server data tier

Everything the app does today happens in the browser. `src/lib/attempts.ts`,
`src/lib/quiz-attempts.ts` and `src/lib/revision.ts` keep a student's whole history in
IndexedDB, which is the right place for it: the app is offline-first, and a self-marked
paper needs no server at all.

This schema exists for the one thing that model cannot hold — **a mark awarded by someone
other than the student**. A photographed answer sheet has to be stored, read, graded
against a rubric, possibly re-graded by a human, and handed back with coloured boxes drawn
over the student's own handwriting. None of that is the student's own claim about
themselves, so none of it can live only on the student's phone.

It replaces the DDL in `CBSE_EdTech_Platform_Technical_Specification.md`, which cannot
store a grade at all: its `evaluation_tickets` table has one `submission_payload_url`, no
question linkage, no marks and no rubric result — only an `ai_draft_feedback JSONB` blob.
The notes below are mostly about the places where this schema deliberately departs from
that document.

## Scope

Phases 0–4: students, attempts, submissions, pages, answers, rubrics, grades, highlights,
evaluator review, and the queue.

Deliberately **not** here: tenants, parent links, school rosters, wallets, ledgers,
payouts, the gig marketplace. They are real requirements and they are later ones. See
[Retrofitting tenancy](#retrofitting-tenancy) for the seam left for the first of them.

## The shape

```
User ──┬── StudentProfile
       ├── EvaluatorProfile ── EvaluatorSubject
       │
       └── Attempt ── AttemptQuestion ─────────┐
                          │                    │  (self-marked path: selfScore)
                          │                    │
        Submission ── SubmissionPage           │
             │            │                    │
             │       AnswerPage                │
             │            │                    │
             └────────── Answer ───────────────┘  (graded path: awardedMarks)
                          │
                          ├── GradingResult ──┬── CriterionResult ── HighlightSpan
                          │      (append-only)│                          │
                          │                   └── HighlightSpan ─────────┘
                          │                            │
                          └── VoiceNote                └── SubmissionPage

        Submission ── EvaluationTicket ── EvaluatorReview ──> GradingResult
                          (the queue)                          (source = HUMAN)

        Rubric ── RubricCriterion ──┬── RubricConcept
                                    ├── PartialCreditRule ──> CriterionResult
                                    ├── RubricTagRequirement
                                    ├── RubricCriterion  (OPTION children)
                                    └──> CriterionResult
```

### Why the relations are the way they are

**`Answer` is the unit, not `Submission`.** Marks, rubric verdicts, highlights and voice
notes all attach to one question's worth of writing. The spec attaches everything to the
ticket, which is why it can express "here is some feedback on your script" but not "you
lost half a mark on question 27 for the missing unit" — which is the entire product.

**`AnswerPage` is a real many-to-many.** Question 31 spills onto the next sheet, and that
sheet also starts question 32. A page column on `Answer`, or an answer column on
`SubmissionPage`, is wrong in one direction or the other.

**`AttemptQuestion` carries two marks.** `selfScore` is what the student awarded
themselves against the marking scheme — the existing Dexie flow, unchanged. `awardedMarks`
is copied down from the current `GradingResult` when the answer was photographed. The two
paths converge on the same row so that `/revise` and `/progress` need no new code: a
question is a question whether a person or a model put a number on it, and either number
can produce the SM-2 confidence that `confidenceFor()` already computes.

**`Attempt.clientAttemptId` is Dexie's key.** The client owns an attempt first — it is
created offline, mid-exam, on a phone that may not see a network for three hours — and
syncs later. Storing `${paperSlug}:${startedAt}` unique-per-student means a retried sync
updates the existing row instead of forking one exam into two.

**`storageKey`, never a URL.** Pages and voice notes store an object key. Pre-signed URLs
expire; a stored one is a dead link the next day. Mint the URL at read time.

**No `subjects` table.** Subject and class come from `data/manifest.json` and
`data/papers.json`, which generate every route in the app. A second copy of them in
Postgres is a copy that drifts. `EvaluatorSubject` therefore stores the subject string and
class number directly, and matches on them.

## The seven corrections

### 1. Identity is phone-first, and scoped

The spec has `users.email VARCHAR(255) UNIQUE NOT NULL`. Both halves are wrong.

*NOT NULL* is wrong because a Class 9 student in India routinely has no email address.
Requiring one at signup either loses the student or fills the column with
`ravi123@fake.com`. `phone` is the identifier — OTP is how this audience logs in
anyway — and `email` is nullable.

*Globally UNIQUE* is wrong because it makes tenancy a destructive migration and B2B roster
import a support ticket. Two schools import the same family's phone number; one of them
fails. So both identifiers are unique **within a scope**:

```prisma
@@unique([scopeId, phone])
@@unique([scopeId, email])
```

`scopeId` is a real UUID column, defaulting to the nil UUID, which means "the public B2C
scope". It is not a nullable column: Postgres treats NULLs as distinct in a unique index,
so a nullable scope would silently permit unlimited duplicate phone numbers in exactly the
scope that has the most users. Email stays nullable on purpose, and gets the same NULL
behaviour deliberately — any number of students may have no email at all.

### 2. Grades have somewhere to live

`Submission → SubmissionPage → Answer → GradingResult → CriterionResult → HighlightSpan`,
all as tables with foreign keys. The spec's `ai_draft_feedback JSONB` cannot be queried
("which criteria do Class 10 students miss most?"), cannot be constrained (nothing stops
awarding 7 marks on a 5-mark question), and cannot be partially superseded by a human.

`Rubric` and `RubricCriterion` are versioned, because marking schemes get corrected and a
grade must stay attached to the rubric it was actually given under. A correction is a new
version, never an edit.

They track `data/rubrics.json` field for field — that file is hand-converted from the
official marking-scheme PDFs and its contract is `data/rubrics.schema.md`. The JSON is the
*authoring* format, the way `data/questions.json` is; this table is where a loaded copy
lives, so that a `GradingResult` can hold a foreign key to the exact rubric version it was
given under rather than a slug that may since have been re-edited. `Rubric.externalId` is
the authored id, unique with `version`, so a re-import is idempotent.

Marks are `Decimal(5,2)`, never `Float`. CBSE awards half marks, and a column of 0.5s has
to add up to exactly what the paper is out of.

See [Tracking the rubric contract](#tracking-the-rubric-contract) for the shapes that took
more than a column.

### 3. Voice notes are per question

`VoiceNote.answerId` — not a single `audio_feedback_url` on the ticket. The PRD promises
"up to a 90-second voice note per question", and one recording per script cannot be played
beside question 27. `transcript` / `transcriptStatus` sit on the same row, so the
transcription worker has somewhere to write without touching the audio record's identity.

The 90-second cap is a CHECK constraint; see [Constraints Prisma cannot
express](#constraints-prisma-cannot-express).

### 4. Claiming is one conditional UPDATE — no Redis

The spec proposes `WATCH`/`MULTI`/`EXEC` against Redis. That adds a second stateful
system, and a second source of truth, to guard a row that Postgres can already guard by
itself. `EvaluationTicket` carries `status`, `claimedAt`, `claimedById`, `leaseExpiresAt`
and `claimCount`, which is everything the statement needs.

**Claim the next ticket:**

```sql
UPDATE evaluation_tickets AS t
   SET status           = 'CLAIMED'::"TicketStatus",
       claimed_by_id    = $1,
       claimed_at       = now(),
       lease_expires_at = now() + interval '15 minutes',
       claim_count      = t.claim_count + 1,
       updated_at       = now()
 WHERE t.id = (
         SELECT c.id
           FROM evaluation_tickets AS c
          WHERE c.status = 'PENDING'::"TicketStatus"
            AND c.claimed_at IS NULL
            AND c.subject = $2
            AND c.class_num = $3
            AND (c.assigned_evaluator_id IS NULL OR c.assigned_evaluator_id = $1)
          ORDER BY c.priority DESC, c.created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
   AND t.status = 'PENDING'::"TicketStatus"
   AND t.claimed_at IS NULL
RETURNING t.*;
```

Zero rows returned means there was nothing to claim — not an error.

Three things are doing work here and none of them is optional:

- `FOR UPDATE SKIP LOCKED` in the subselect is what makes fifty tutors polling at once
  pick fifty *different* tickets instead of all queueing behind the same row.
- The repeated `status`/`claimed_at` predicates on the outer `UPDATE` close the window
  between the subselect and the write. Belt and braces, but the braces are free.
- `ORDER BY priority DESC, created_at` matches `@@index([status, subject, class_num,
  priority DESC, created_at])`, so the scan is an index scan even when the queue is long.

**Release an expired lease** (a cron every minute; this is why no heartbeat service is
needed — a tutor who shuts their laptop mid-review resolves itself):

```sql
UPDATE evaluation_tickets
   SET status           = 'PENDING'::"TicketStatus",
       claimed_by_id    = NULL,
       claimed_at       = NULL,
       lease_expires_at = NULL,
       updated_at       = now()
 WHERE status IN ('CLAIMED'::"TicketStatus", 'IN_REVIEW'::"TicketStatus")
   AND lease_expires_at < now()
RETURNING id;
```

**Extend a lease while the evaluator is still working:**

```sql
UPDATE evaluation_tickets
   SET lease_expires_at = now() + interval '15 minutes',
       updated_at       = now()
 WHERE id = $1
   AND claimed_by_id = $2
   AND status IN ('CLAIMED'::"TicketStatus", 'IN_REVIEW'::"TicketStatus")
RETURNING id;
```

Run these through `prisma.$queryRaw` — Prisma's `updateMany` cannot `RETURNING`, and the
returned row *is* the claim.

`claimCount` is not bookkeeping: a ticket claimed and abandoned four times is a bad scan,
not four bad tutors, and it should be routed to a human differently or sent back to the
student to re-photograph.

### 5. Indexes on every hot path

The spec declares none. This schema indexes:

| Query | Index |
| --- | --- |
| Queue poll, any subject | `evaluation_tickets(status, priority DESC, created_at)` |
| Queue poll, by qualification | `evaluation_tickets(status, subject, class_num, priority DESC, created_at)` |
| Lease sweeper | `evaluation_tickets(status, lease_expires_at)` |
| "My queue" / "waiting for me" | `evaluation_tickets(claimed_by_id, status)`, `(assigned_evaluator_id, status)` |
| A student's submissions | `submissions(student_id, created_at DESC)` |
| Pipeline workers picking up work | `submissions(status, created_at)`, `submission_pages(ocr_status, created_at)` |
| Answers of a submission | `answers(submission_id, question_number)` (the unique) |
| Current grade for an answer | `grading_results(answer_id, revision)` (unique), `(answer_id, created_at DESC)` |
| Highlights for a page render | `highlight_spans(grading_result_id)`, `(submission_page_id)` |
| Routing to a qualified evaluator | `evaluator_subjects(subject, class_num)` |
| A student's attempt history | `attempts(student_id, started_at DESC)` |

### 6. Idempotency

`@@unique([studentId, idempotencyKey])` on `Submission`. The client generates the key
before the first byte is uploaded. Indian mobile networks drop and retry POSTs freely, and
a student who ends up with two copies of the same answer sheet is charged twice and shown
two contradictory grades. Create with `ON CONFLICT DO NOTHING` and read back by the key;
the retry becomes a no-op.

The key is scoped to the student rather than global, so it only has to be unique on one
device — a UUID from the client, or a hash of the page checksums.

`EvaluationTicket.submissionId` is `@unique` for the same reason one level up: routing the
same submission twice cannot produce two tickets, so the router needs no separate lock.

### 7. Grades are append-only

A grading result is evidence. `GradingResult` has **no `updatedAt`** and is never updated
in place.

A human override inserts a *new* row: `revision = previous + 1`, `supersedesId` pointing at
the row it replaces, `source = HUMAN`. The old AI verdict — its marks, its confidence, its
model version, its criterion results, its highlight spans — survives intact. This is what
lets the student be shown

> AI: 3/5 → your teacher: 4/5 — "gave the formula, so the working counts"

instead of a mark that quietly changed between two screens, and it is what lets the model's
accuracy be measured against human evaluators later without a separate audit log.

`supersedesId` is `@unique`, which keeps the chain linear: two evaluators cannot both
override revision 2 and leave two rows each claiming to be current.

Reading the current grade:

```sql
SELECT DISTINCT ON (answer_id) *
  FROM grading_results
 WHERE answer_id = ANY($1)
 ORDER BY answer_id, revision DESC;
```

`CriterionResult` and `HighlightSpan` hang off the `GradingResult`, not off the `Answer`,
for exactly this reason: the teacher's boxes are new rows and the AI's survive beside them.

## Tracking the rubric contract

`data/rubrics.schema.md` landed final after this schema was first drafted, and five of its
shapes needed more than a column. All of them are load-bearing at grading time, not
metadata.

### The fourth outcome, and why it has no colour

The contract's outcome table has four rows, not three:

| Outcome | Awarded | Colour |
|---|---|---|
| hit | `marks` | green |
| partial | the rule's `award` | orange |
| miss | 0 | red |
| **unmarked** | — | **none** |

`CriterionVerdict.UNMARKED` is the fourth. It arises two ways, and `UnmarkedReason` keeps
them apart because they need different things from a human: `NOT_AUTO_GRADABLE` is a
diagram step waiting on someone's eye, `RUBRIC_NEEDS_REVIEW` is a miss withheld on an
unsigned rubric, waiting on someone's signature.

**The absent colour is modelled as an absent row.** `HighlightSpan.color` stays `NOT NULL`
over exactly `GREEN | ORANGE | RED`; an unmarked criterion writes no span at all.

The alternative — a nullable `color`, or a fourth `NONE` member — was rejected because both
make the unsafe state representable. Every renderer, every export, every future report
would have to remember to skip a span whose colour is absent, and the one that forgets
falls back to a default. For a criterion that awarded nothing, the default it reaches for
is red. Red is precisely the false accusation the unmarked outcome exists to prevent, so
the schema should not leave a row lying around that a careless `SELECT` can paint. A row
that does not exist cannot be rendered by mistake.

Nothing is lost by the absence. The `CriterionResult` still carries `verdict = UNMARKED`
and its reason, so the evaluator's split-screen checklist shows "correct labelled figure —
needs your eye" on the right while nothing at all is drawn over the student's handwriting
on the left. That is the intended behaviour, and it falls out of the model rather than
depending on every reader to remember it.

`GradingResult.unmarkedCount` rolls the same fact up to the grade. Non-zero means the grade
is provisional and must be presented that way: "out of 5 you scored 3" and "of the 4 marks
anyone has checked, you scored 3" are different claims, and only one of them is true. It is
also the cheapest routing signal there is — a submission with unmarked criteria is the one
that most needs a human.

### `needsReview` gates grading, not review

`Rubric.needsReview` and `Rubric.reviewNotes[]` live on the rubric because the contract's
safety rule reads at grading time:

> Nothing is ever painted red on a rubric flagged `needsReview`. An unchecked conversion
> may accuse a student of writing nothing of value, which is the one mistake with no
> recovery.

A grader that cannot see the flag cannot obey the rule. Such a rubric awards green and
orange as normal; a miss becomes `UNMARKED` with `RUBRIC_NEEDS_REVIEW`. Most seeded rubrics
carry the flag today, which makes this the common path rather than an edge case — and it
means `unmarkedCount` will usually be non-zero until rubrics are signed off, which the UI
copy has to be written for.

`@@index([needsReview])` exists so "which rubrics are blocking honest grading?" is a cheap
question for whoever works through the sign-off queue.

### `keywords` is concepts, not strings

This one was a genuine misreading on the first pass, and it would have graded answers
wrongly. `RubricConcept` is now a child table; the old flat `keywords String[]` is gone.

The JSON is a list of **concepts**, each a set of accepted phrasings:

```jsonc
"keywords": [ { "any": ["4 ohm", "4 Ω", "4Ω"] }, { "any": ["stomata", "stomatal pore"] } ]
```

That means *one of the first set* **and** *one of the second*. Flattened into one array of
six strings, the AND between concepts collapses into a bag, and a step needing two distinct
ideas scores on one of them written two ways. `match` (`ALL` | `ANY`) then says whether
every concept is needed or only one — `ANY` being right for a free-recall step where the
scheme itself only wants the idea.

Per-concept phrasing sets are also where "or equivalent wording" actually lives, rather
than as `acceptEquivalentWording` blanketing the whole rubric.

### `partial` rules, and `requireTags`

`PartialCreditRule` is what makes orange possible at all, and it was missing entirely.
`reason` comes from the contract's closed list of eight — closed because orange has to mean
something a student can act on, and free text would drift into a synonym per author.
`CriterionResult.partialRuleId` records which rule fired, so the student is told *why* it
is orange and not merely that it is.

`RubricTagRequirement` is the second half of "any two of the following": Q16 wants "at
least one climate and one economic", Q38B "ANY 5, at least 2 positive and 2 negative". One
row per tag with its minimum count, matched against `RubricCriterion.tags` on the `OPTION`
children. A table rather than a JSON map on the group, so the grader joins instead of
parsing, and so `rubric:check`'s "a `requireTags` demand no set of scoring options could
satisfy" is a query rather than a walk.

### `variant`, and the identity of a rubric

CBSE questions carry internal choice — "attempt either A or B" — and each option is a
separate rubric with the same `questionNo`, a different `variant`, each summing to
`maxMarks` on its own. `rubric:check` rejects two rubrics sharing `paper` + `questionNo` +
`variant`, and `@@unique([paperSlug, questionNumber, variant, version])` is that same
identity plus our versioning.

`variant` defaults to the **empty string**, not NULL, for a question with no choice — the
same reasoning as `scopeId` on `User`. Postgres treats NULLs as distinct in a unique index,
so a nullable `variant` would happily hold two rubrics for the same un-varianted question:
exactly the duplicate the validator rejects, waved through by the database.

Two related corrections fell out of the same re-read:

- **`bookCode` and `chapter` are now `NOT NULL`.** The contract calls them the load-bearing
  pair and rejects a rubric without a recognisable `bookCode` outright, because a rubric
  with no chapter has nowhere to send its result — no `/revise` card, no `/progress` row.
- **`subject` and `classNum` are advisory, and no longer part of any identity.** The
  manifest knows `jesc1` is Class 10 Science, and the book decides; a rubric whose stated
  class the manifest contradicts is rejected at import, so a disagreement never reaches
  this table. They stay as denormalised columns for routing and indexing, but keying on
  them would have made an advisory field load-bearing.

### `marks` vs `marksEach`

The contract uses `marks` on a `step` or `diagram`, and `marksEach` on a `choose` group. I
kept both names rather than collapsing them, because the meanings differ in a way that
matters: a group's contribution is `chooseAtLeast × marksEach`, not `marksEach`. Under one
column called `marks`, `SUM(marks)` over a rubric's top-level steps is quietly wrong for
every rubric containing a choose group — and "the steps must sum to `maxMarks`" is the
contract's most damaging error to get wrong, because it grades every attempt at that
question out of the wrong denominator.

Both columns are nullable and exactly one is set per kind, enforced by CHECK:

| `kind` | `marks` | `marksEach` | `chooseAtLeast` | contributes |
| --- | --- | --- | --- | --- |
| `STEP` | set | NULL | NULL | `marks` |
| `DIAGRAM` | set | NULL | NULL | `marks` |
| `CHOOSE` | NULL | set | set | `chooseAtLeast × marksEach` |
| `OPTION` | NULL | NULL | NULL | nothing on its own |

`awardFor` is likewise named for the contract rather than as a generic `label`: a reviewer
reads that column against the PDF, and it should say the same word the PDF's converter
wrote.

### Field-name mapping

Everything else is spelled as the JSON spells it. The exceptions, all deliberate:

| `data/rubrics.json` | Here | Why |
| --- | --- | --- |
| `paper` | `paperSlug` | Matches `Attempt.paperSlug` and `Submission.paperSlug`; a tolerated spelling in the contract |
| `questionNo` | `questionNumber` | Matches `AttemptQuestion.questionNumber` and `Answer.questionNumber` |
| `id` | `externalId` | `id` is the surrogate UUID primary key |
| `steps[].id` | `stepId` | Same |
| `keywords[].any` | `RubricConcept.phrasings` | It is a child row, and `any` names a matcher rule rather than the data |
| `partial[].when` | `PartialCreditRule.reason` | `when` is a reserved word in enough dialects to be a nuisance |
| `scheme.file` / `.page` | `schemeFile` / `schemePage` | Flattened; a two-key object earns no table |

The contract's tolerated input spellings (`book`, `ch`, `qNo`, `totalMarks`, `slug`) are an
importer's problem, not a schema one. Normalise on the way in; store the canonical name.

## Constraints Prisma cannot express

Add these by hand to the generated migration. Prisma's schema language has no `CHECK`, and
these are the invariants worth having the database enforce rather than the application.

```sql
ALTER TABLE voice_notes
  ADD CONSTRAINT voice_note_max_90s CHECK (duration_ms > 0 AND duration_ms <= 90000);

ALTER TABLE grading_results
  ADD CONSTRAINT grade_within_max CHECK (awarded_marks >= 0 AND awarded_marks <= max_marks),
  ADD CONSTRAINT grade_revision_positive CHECK (revision >= 1),
  -- An AI grade has no evaluator; a human grade has one.
  ADD CONSTRAINT grade_source_consistent CHECK (
    (source = 'AI'::"GradeSource"    AND evaluator_id IS NULL) OR
    (source = 'HUMAN'::"GradeSource" AND evaluator_id IS NOT NULL)
  );

ALTER TABLE highlight_spans
  ADD CONSTRAINT highlight_box_normalised CHECK (
    x >= 0 AND y >= 0 AND width > 0 AND height > 0 AND
    x + width <= 1 AND y + height <= 1
  );

ALTER TABLE attempt_questions
  ADD CONSTRAINT self_score_within_max CHECK (self_score IS NULL OR (self_score >= 0 AND self_score <= max_marks));

ALTER TABLE student_profiles
  ADD CONSTRAINT class_supported CHECK (class_num IN (9, 10));

ALTER TABLE criterion_results
  -- UNMARKED and MISS both award zero and mean opposite things; only UNMARKED
  -- carries a reason, and only PARTIAL names a rule.
  ADD CONSTRAINT criterion_verdict_consistent CHECK (
    (verdict = 'UNMARKED'::"CriterionVerdict"
       AND awarded = 0 AND unmarked_reason IS NOT NULL AND partial_rule_id IS NULL) OR
    (verdict = 'MISS'::"CriterionVerdict"
       AND awarded = 0 AND unmarked_reason IS NULL AND partial_rule_id IS NULL) OR
    (verdict = 'PARTIAL'::"CriterionVerdict"
       AND awarded > 0 AND unmarked_reason IS NULL) OR
    (verdict = 'HIT'::"CriterionVerdict"
       AND awarded > 0 AND unmarked_reason IS NULL AND partial_rule_id IS NULL)
  );

ALTER TABLE rubric_criteria
  -- Exactly one of marks / marks_each is set, and only a CHOOSE group counts.
  -- This is the table in "marks vs marksEach", expressed once, in the database.
  ADD CONSTRAINT criterion_marks_by_kind CHECK (
    (kind IN ('step'::"CriterionKind", 'diagram'::"CriterionKind")
       AND marks IS NOT NULL AND marks_each IS NULL AND choose_at_least IS NULL) OR
    (kind = 'choose'::"CriterionKind"
       AND marks IS NULL AND marks_each IS NOT NULL AND choose_at_least >= 1) OR
    (kind = 'option'::"CriterionKind"
       AND marks IS NULL AND marks_each IS NULL AND choose_at_least IS NULL)
  ),
  -- Every award is a positive multiple of 0.5 — the finest grain CBSE uses.
  ADD CONSTRAINT criterion_marks_half CHECK (
    (marks      IS NULL OR (marks      > 0 AND (marks      * 2) = trunc(marks      * 2))) AND
    (marks_each IS NULL OR (marks_each > 0 AND (marks_each * 2) = trunc(marks_each * 2)))
  ),
  -- An OPTION has a parent; nothing else does. Options are order-free, so
  -- `ordered` is meaningless on one.
  ADD CONSTRAINT option_has_parent CHECK (
    (kind = 'option'::"CriterionKind") = (parent_id IS NOT NULL)
  ),
  ADD CONSTRAINT option_not_ordered CHECK (
    kind <> 'option'::"CriterionKind" OR ordered IS NULL
  ),
  -- A diagram step may not claim to be auto-gradable. The contract forces this
  -- and it is worth the database refusing it: the whole point is that a matcher
  -- cannot judge a photograph of a triangle.
  ADD CONSTRAINT diagram_not_auto_gradable CHECK (
    kind <> 'diagram'::"CriterionKind" OR auto_gradable = FALSE
  );

ALTER TABLE rubric_concepts
  -- "a keywords concept with an empty any" is a rejection in rubric:check.
  ADD CONSTRAINT concept_has_phrasings CHECK (cardinality(phrasings) > 0);

ALTER TABLE partial_credit_rules
  ADD CONSTRAINT partial_award_half CHECK (award > 0 AND (award * 2) = trunc(award * 2));

ALTER TABLE rubric_tag_requirements
  ADD CONSTRAINT tag_min_count_positive CHECK (min_count >= 1);
```

`class_supported` will need relaxing the day Class 11 ships, which is the point: it fails
loudly at insert rather than quietly filling `/progress` with a class the app has no books
for.

Four of the contract's rules are counts or sums across rows, so they stay in
`npm run rubric:check` rather than becoming constraints. Postgres cannot express any of
them without a trigger, and a trigger on the authoring path is worse than a validator that
runs before import:

- the steps of a rubric must sum to `maxMarks` (`chooseAtLeast × marksEach` for a group);
- a `choose` group must hold at least `chooseAtLeast` options;
- a `requireTags` demand must be satisfiable by *some* set of scoring options;
- `partial.award` must be strictly less than its step's `marks` — which is also what makes
  a `partial` on a half-mark step an authoring error rather than a rounding problem, since
  there is no positive multiple of 0.5 below 0.5.

The last one is expressible as a constraint only because `award` and `marks` sit in
different tables; a `CHECK` cannot reach across the foreign key.

## Retrofitting tenancy

`User.scopeId` is a UUID column, present from the first migration, with every row set to
the nil UUID. When tenancy lands:

```sql
CREATE TABLE tenants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(255) NOT NULL,
  tier       VARCHAR(50)  NOT NULL DEFAULT 'b2c_free',
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

INSERT INTO tenants (id, name, tier)
VALUES ('00000000-0000-0000-0000-000000000000', 'Public', 'b2c_free');

ALTER TABLE users RENAME COLUMN scope_id TO tenant_id;
ALTER TABLE users ADD CONSTRAINT users_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
```

No column is added, no unique index is rebuilt, no row is rewritten, and no existing query
returns a different answer. A rename is a catalogue update in Postgres, and the composite
uniques `(scope_id, phone)` and `(scope_id, email)` become `(tenant_id, phone)` and
`(tenant_id, email)` — the shape they always were.

Everything else reaches its tenant through `User`. Deliberately: putting a `tenant_id` on
`submissions`, `answers` and `grading_results` now would be six denormalised columns
maintained for a feature that does not exist, and each is a chance to write the wrong one.
When row-level security arrives it can join, or those columns can be added then with the
tenant known — which is the cheap direction to migrate in.

## Working on this

There is no database yet, and no migration has been generated. When there is one:

```bash
npx prisma format                       # canonical formatting
npx prisma validate                     # schema is well-formed
npx prisma migrate dev --name <what>    # generate + apply, then hand-add the CHECKs above
npx prisma generate                     # regenerate the client after any schema change
```

`src/lib/db.ts` will not typecheck until `npx prisma generate` has run at least once —
`@prisma/client` has no types before then. That failure is expected on a fresh clone.

Note that the app itself is still a **static export** (`next.config.ts`), so nothing under
`src/app/` can import `src/lib/db.ts` yet. It is server-only, and pulling it into a
`"use client"` module fails the build — which is the correct failure, and the reason the
existing Dexie stores are untouched by any of this.

## What still looks wrong in the spec

Beyond the seven above, and worth deciding on before Phase 5:

- **`platform_configs.feature_key VARCHAR(100) UNIQUE NOT NULL`** is globally unique but
  the table also has a `tenant_id`. As written, exactly one tenant in the entire system can
  override any given flag. It wants `UNIQUE(tenant_id, feature_key)`.
- **The RLS policy compares a UUID to `current_setting(...)`, which returns `text`.** It
  needs `tenant_id = current_setting('app.current_tenant_id', true)::uuid`, and the
  `OR tenant_id IS NULL` clause makes every public row visible to every tenant — probably
  intended, but it means RLS provides no isolation at all for B2C data.
- **`tutor_workforce_profiles.shift_start_time TIME`** with no timezone, compared in the
  routing code against `new Date()`. India is one timezone today; this breaks the first
  time an evaluator sits outside it, and `TIME` cannot represent a night shift that crosses
  midnight either.
- **The routing controller writes tickets outside a transaction** and does a
  `findFirst`-then-`create`, which double-books a fixed-hourly tutor under any concurrency.
  It also never checks `max_concurrent_fixed_tickets`, which it went to the trouble of
  storing.
- **`wallet_transactions` is described as an immutable double-entry ledger but is neither.**
  It is updated in place by the settlement controller (`payout_status`, `marked_paid_at`),
  and single-entry — one row, one wallet, no counter-account. Out of scope here; worth
  fixing before money moves.
- **`evaluation_tickets` has no unique on `submission_payload_url`** or anything else, so
  the retry that motivated the idempotency key above creates duplicate tickets and pays two
  tutors to grade the same script.
