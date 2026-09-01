# `data/rubric-proposals.json` — drafts, not marking

This file holds proposed answers to the fourteen questions in
[`docs/teacher-review.md`](../docs/teacher-review.md) Part A — the fourteen
questions where a correct answer currently scores zero.

**Nothing in it marks anybody.** It is not read by the grader, not read by
`src/`, and not read by `rubric:check`. `data/rubrics.json` and
`data/rubrics.draft.json` are the only files that decide how a real script is
marked, and neither of them changes because of anything written here. A
proposal becomes marking only when a human copies it across, deliberately, after
reading it.

That separation is the whole point. The `needsReview` machinery exists so that
an unchecked conversion can never accuse a student of writing nothing of value.
A file of unreviewed proposals sitting inside `rubrics.json` would defeat it
quietly, so the proposals sit here instead.

## What changed for the teacher

Part A used to ask for fourteen marking decisions to be **authored** from a
marking-scheme PDF — about an hour and fifty minutes. Each one now arrives as a
concrete breakdown to **approve or amend**, with the remaining judgment narrowed
to a yes/no or a single number wherever it would narrow. The reading is still
real; the drafting is done.

## One entry

Each proposal carries, in this order:

| Field | What it holds |
|---|---|
| `ref` | which Part A entry it answers — `A1`, `A2`, … |
| `kind` | `replace-steps`, `new-rubric`, or `confirm-as-is` |
| `targets.rubricId` | the rubric it is about — for a new rubric, the id it would take |
| `todayAStudentLoses` | who is mis-marked before the proposal |
| `cbsePrinted` | what is in CBSE's margin. **Not this file's to move.** |
| `iInferred` | everything else, and what it rests on |
| `teacherQuestion` | what is still yours to settle |
| `ifAdopted` | who scores differently, and by how much |
| `proposed` | the breakdown itself, in the shape `rubrics.schema.md` defines |

`cbsePrinted` and `iInferred` are the pair that matters. Where CBSE printed a
number in its margin, the proposal uses that number and says so, and it is not
open for negotiation. Where CBSE printed only a total, the split below it is
this file's judgment, and `iInferred` says what the judgment rests on so that a
teacher can disagree with the reasoning rather than only with the answer.

`proposed` is written in the live rubric's own shape on purpose: approving a
proposal should be a copy, not a translation.

## Two entries carry an amendment written out

`A5` and `A7` both turn on the same yes/no — does a drawing the question asks
for carry a mark CBSE never printed? Each carries an `ifYouWantAFigureMark`
block: the exact steps that would replace the ones above them if the answer is
yes. It is not part of the proposal and is not counted in its total. It is there
so that saying yes costs a tick rather than an afternoon.

## Diagram marks

Several proposals reserve a mark for a drawing. Per
[`rubrics.schema.md`](./rubrics.schema.md) a diagram step is **never**
auto-graded: it resolves to `unmarked`, paints no colour, and waits for a
person. So agreeing to a diagram mark is not agreeing that the machine will
judge a drawing — it is reserving that mark for yourself, and lowering the
machine's top score on that question by exactly that much. Each affected
proposal says so in its own words, because it changes what is being agreed to.

## Checking it

```bash
node scripts/check-proposals.mjs
```

It fails, loudly, if:

- a proposal's steps do not sum to the question's `maxMarks`, in half-mark units;
- a proposal names a rubric that does not exist, or a new rubric whose id
  collides with one that does, or a paper not in `data/papers.json`;
- a proposal's steps have **already been copied into the live rubrics** — which
  means the proposal has been adopted and should be deleted from here, rather
  than left looking like an open question;
- a proposal is missing the prose a reviewer would need to check its reasoning;
- a step's marks are not a positive multiple of ½, a ½-mark step carries a
  partial rule (CBSE has no quarter mark), a `choose` group lists fewer options
  than it asks for, or a diagram step claims to be auto-gradable;
- a proposal infers its split without saying so, or does not set `needsReview`.

## After a proposal is approved

1. Copy `proposed` into `data/rubrics.json` by hand, keeping `needsReview` until
   the sign-off is recorded the way the rest of the file records it.
2. Delete the proposal from `data/rubric-proposals.json`.
3. Run `node scripts/check-rubrics.mjs`, then
   `node scripts/check-proposals.mjs`, then
   `node scripts/build-teacher-queue.mjs` so the queue and Part A reorder around
   what is left.

Step 2 is not tidiness. `check-proposals.mjs` fails if you skip it, because a
settled decision that still reads as an open one is how a teacher's afternoon
gets spent twice.
