# Ground truth for the grading gate — collection protocol

Nobody has ever measured whether this product can mark a handwritten answer as
well as a teacher. Everything downstream assumes it can. This document is how
that assumption gets tested, once, properly.

**The gate, in full.** Three conditions, all of which must hold:

1. The machine is **within 1 mark of the teacher on at least 80%** of 3- and
   5-mark answers.
2. The machine **never gives more than 2 marks more** than the teacher, on any
   answer at all.
3. **Every answer collected has exactly one machine verdict** — nothing is
   quietly dropped.

The asymmetry in (2) is on purpose. Over-marking tells a student they are ready
when they are not, and the first teacher who sees it stops trusting the product.
Under-marking merely annoys a student, who appeals. The measurement therefore
reports the two directions separately and never averages them into one
"accuracy" number.

The instrument that computes this is `scripts/spike-score.mjs`. It does pure
arithmetic over two files and touches no network, so the number it prints can be
checked by hand.

---

## Read this before collecting anything

Two facts about the current state of the marking sheets change what this
collection is worth. Both are counted from the files, not assumed.

### Warning 1 — 37 of the 41 gate-sized questions are not signed off

There are **41** questions in the corpus worth 3 or 5 marks. **Four** have been
reviewed by a person. The other **37** have not.

While a marking sheet is unreviewed, the grader is forbidden from marking
anything on it **wrong**. It may award a mark; it may award half a mark; it may
not say a step is absent. So on those 37 questions it can only ever be generous.

That is the exact direction the gate is most sensitive to. Condition (2) — never
over-award by more than 2 — would be measured against a grader that is
structurally prevented from under-awarding on 90% of the set. A pass would mean
nothing, and a fail would be catastrophic rather than informative.

**So: `docs/teacher-review.md` Parts A and B must be signed off before a single
photograph is taken.** That is 41 rubric decisions, about four and a half hours,
and it is the same afternoon's work as this collection. It is not optional
tidying; without it there is no measurement.

If sign-off does not happen, the only usable questions are the four already
signed (all Mathematics Basic 2025-26: Q28, Q31, Q33 option B, Q34 option A).
Four questions cannot support a gate.

### Warning 2 — 7 of the 41 have a mark on a drawing

A machine never marks a drawing. It cannot honestly judge a ray diagram from a
photograph, so it awards nothing for the figure and leaves that mark for a
human. On these seven questions the machine's ceiling is therefore below full
marks, whatever the student wrote:

| Question | Marks | On the drawing | Machine's ceiling |
|---|---|---|---|
| Science 2015-16, Q24 | 5 | 1 | 4 of 5 |
| Science 2016-17, Q11 | 3 | 1 | 2 of 3 |
| Science 2016-17, Q23 | 5 | 2 | 3 of 5 |
| Science 2017-18, Q16 | 5 | 2 | 3 of 5 |
| Science 2025-26, Q13 | 3 | 1 | 2 of 3 |
| Science 2025-26, Q37 | 3 | 1 | 2 of 3 |
| Mathematics (Basic) 2025-26, Q34 option A | 5 | 1 | 4 of 5 |

Include these unchanged and they read as a systematic under-award — the machine
looking harsh for a reason that has nothing to do with how it marks. Two of them
(2016-17 Q23 and 2017-18 Q16) would show a −2 gap on a perfect script.

Choose one of these, in `docs/teacher-review.md`, before collecting:

- **A human marks the drawing** and adds it to the machine's total before
  scoring. Correct, and it is one extra number on the tally sheet.
- **Move the figure mark into the written explanation** at sign-off. Then the
  question is fully machine-markable.
- **Leave all seven out.** Honest, but the set drops from 41 questions to 34, and
  the confidence interval widens (see below).

Whichever you choose, apply it to all seven and write it down. Do not decide it
per question after seeing the results.

---

## Which questions to photograph

All 41 questions in the corpus worth 3 or 5 marks. Only these sizes count
towards the gate; 1-, 2- and 4-mark answers contribute nothing to it.

The question paper and its marking scheme are both mirrored under
`public/papers/`, named after the paper — `class10-science-2015-16-sqp.pdf` and
`class10-science-2015-16-ms.pdf`, for example.

| # | Subject | Paper | Q | Marks | Signed off? | Drawing |
|---|---|---|---|---|---|---|
| G01 | Mathematics | 2018-19 sample | 21 option A | 3 | no | |
| G02 | Mathematics | 2022-23 practice | 26 | 3 | no | |
| G03 | Mathematics (Basic) | 2023-24 sample | 29 | 3 | no | |
| G04 | Mathematics (Basic) | 2024-25 sample | 26 | 3 | no | |
| G05 | Mathematics (Basic) | 2025-26 sample | 27 option B | 3 | no | |
| G06 | Mathematics (Basic) | 2025-26 sample | 28 | 3 | **yes** | |
| G07 | Mathematics (Basic) | 2025-26 sample | 31 | 3 | **yes** | |
| G08 | Mathematics (Basic) | 2025-26 sample | 33 option B | 5 | **yes** | |
| G09 | Mathematics (Basic) | 2025-26 sample | 34 option A | 5 | **yes** | 1 mark |
| G10 | Mathematics (Standard) | 2022-23 sample | 30 option A | 3 | no | |
| G11 | Science | 2015-16 sample | 8 | 3 | no | |
| G12 | Science | 2015-16 sample | 10 | 3 | no | |
| G13 | Science | 2015-16 sample | 11 | 3 | no | |
| G14 | Science | 2015-16 sample | 13 | 3 | no | |
| G15 | Science | 2015-16 sample | 17 | 3 | no | |
| G16 | Science | 2015-16 sample | 21 | 5 | no | |
| G17 | Science | 2015-16 sample | 22 | 5 | no | |
| G18 | Science | 2015-16 sample | 24 | 5 | no | 1 mark |
| G19 | Science | 2016-17 sample | 11 | 3 | no | 1 mark |
| G20 | Science | 2016-17 sample | 14 | 3 | no | |
| G21 | Science | 2016-17 sample | 18 | 3 | no | |
| G22 | Science | 2016-17 sample | 21 | 5 | no | |
| G23 | Science | 2016-17 sample | 22 | 5 | no | |
| G24 | Science | 2016-17 sample | 23 | 5 | no | 2 marks |
| G25 | Science | 2017-18 sample | 8 | 3 | no | |
| G26 | Science | 2017-18 sample | 16 | 5 | no | 2 marks |
| G27 | Science | 2022-23 practice | 33 | 3 | no | |
| G28 | Science | 2024-25 sample | 34 option A | 5 | no | |
| G29 | Science | 2025-26 sample | 13 | 3 | no | 1 mark |
| G30 | Science | 2025-26 sample | 16 option A | 5 | no | |
| G31 | Science | 2025-26 sample | 36 | 3 | no | |
| G32 | Science | 2025-26 sample | 37 | 3 | no | 1 mark |
| G33 | Social Science | 2020-21 sample | 19 | 3 | no | |
| G34 | Social Science | 2020-21 sample | 29 | 5 | no | |
| G35 | Social Science | 2022-23 practice | 26 | 3 | no | |
| G36 | Social Science | 2023-24 sample | 27 | 3 | no | |
| G37 | Social Science | 2023-24 sample | 28 | 3 | no | |
| G38 | Social Science | 2023-24 practice set 2 | 37 | 5 | no | |
| G39 | Social Science | 2025-26 sample | 35 | 3 | no | |
| G40 | Social Science | 2025-26 sample | 37 | 3 | no | |
| G41 | Social Science | 2025-26 sample | 38 option B | 5 | no | |

Twenty-seven are 3-mark and fourteen are 5-mark. By subject: Science 22,
Social Science 9, Mathematics 10. That imbalance is inherited from what has been
converted so far; it is not a design choice, and it limits what the per-subject
breakdown can say.

Four of them — G01, G05, G10 and G28 — are one half of a printed either/or where
the other half has no marking sheet at all.
**Set the option that exists.** If a student answers the other option their script
is unusable, and you will have marked it for nothing.

---

## How many students per question

**Five per question. 41 × 5 = 205 answers.**

Here is what that buys and what it does not.

- The headline number — the share of answers within 1 mark — comes out of 205
  observations. If the true rate is around 80%, the 95% confidence interval is
  roughly **±5.5 percentage points**. So a measured 84% is consistent with a true
  78%: a pass by a small margin is not a pass you should trust. A measured 92% or
  a measured 68% is a real signal.
- Three per question (123 answers) widens that to about **±7 points**, which is
  wide enough that the measurement cannot distinguish "passes the gate" from
  "fails the gate" at all. Three is the floor, and it is a floor that produces an
  ambiguous answer.
- If the seven drawing questions are excluded, 34 × 5 = 170 answers and the
  interval widens to about **±6 points**.

**The per-subject table will be weak, and you should expect that.** Science
contributes 22 questions (110 answers, ±7.5 points), Social Science 9 (45
answers, ±12 points), Mathematics 10 (50 answers, ±11 points). Maths and Science
fail in different ways — Maths on arithmetic and method order, Science on
wording — and this set can suggest a difference between them but cannot
establish one. Read those rows as a hint about where to look next, never as a
result.

**Condition 2 is the weakest of the three, and the most important.** "Never
over-awards by more than 2" is a maximum over the whole set. With 205 answers,
a fault that over-awards by 3 marks on one answer in five hundred will very
likely not appear at all. Passing condition 2 on this set means "no such fault
was seen", not "no such fault exists". Say it that way in any write-up.

### Which five students

**Not the best five, and not five at random from one class.** A set where every
answer deserves full marks measures nothing: the machine agrees trivially, and
the over-award condition is never exercised, because there is nothing above full
marks to over-award to.

For each question, pick five answers that between them cover the range:

- **one that deserves full marks or nearly** — checks the machine can recognise a
  complete answer;
- **two middling** — partly right, a step missing, a unit dropped, a slip in
  arithmetic. These are where the ±1 band is actually decided;
- **one weak** — one step right, the rest wrong or absent;
- **one that is nearly worthless** — off-topic, or a page of confident writing
  that answers a different question. This is the single most valuable answer in
  the whole set, because it is the one an over-generous keyword matcher fails on.
  Do not omit it because it feels unkind.

If a question has fewer than five attempts to choose from, take what exists and
write down how many you got. A missing answer is fine; a missing answer that
nobody recorded is not, because it makes the denominator wrong.

Include a **blank or abandoned** answer for at least three questions across the
set. A blank page should score zero, and a grader that finds marks in one is
broken in a way nothing else will reveal.

---

## How to photograph

The whole point of this measurement is that it survives contact with a real
classroom. Clean flatbed scans would flatter the model and make the number a
lie — students photograph their own work on a phone, at night, under a tube
light, and that is the input the product actually gets.

**Do:**

- Use an ordinary phone camera, in the ordinary camera app.
- Ordinary indoor light — tube light, ceiling fan shadow, evening lamp. Vary it
  across the set rather than standardising it.
- Let the page lie as it lies. A slight curl, a spiral binding at the edge, the
  shadow of your own hand — all of that is real and belongs in the set.
- **One answer per photograph.** Frame the whole answer including the question
  number, plus a couple of centimetres of margin all round.
- Hold the phone roughly square to the page. A few degrees of tilt is fine; a
  45° angle is not — that is a different problem and not the one being measured.
- Save as JPEG or PNG. Anything from about 1500 pixels on the long edge upwards
  is enough; the grader reduces to about 1568 pixels anyway, so a 12-megapixel
  photo is not better, only slower.
- If the writing is genuinely unreadable to you at arm's length, retake it. The
  measurement is about marking, not about whether a camera can focus.

**Do not:**

- Do not use a scanner, a flatbed, or a scanner app's "document" mode. The
  contrast-boosting, deskewing and shadow-removal in those apps produce an image
  no student's phone will ever produce.
- Do not use flash if it puts a white blowout across the writing.
- Do not crop to the ink or straighten the page afterwards.
- Do not convert to black and white.
- Do not photograph two answers in one frame and plan to crop later.

**Two rules about the script itself, which matter more than any of the above:**

- **Do not mark on the script where the marking would be visible in the
  photograph.** No ticks, no crosses, no circled marks, no red pen, no marks
  total in the margin. The machine is being asked to mark the answer, and an
  answer with a teacher's tick beside it is no longer a test — the machine can
  simply read the tick. Photograph first, mark afterwards on the tally sheet, or
  use unmarked copies.
- **Do not correct a student's spelling, units or notation before photographing.**
  A misspelt "phenolphthalein", a missing Ω, an unbalanced equation — these are
  exactly what the marking has to cope with. Silently fixing them removes the
  hardest cases and leaves a set the machine passes for the wrong reason.

Also: do not photograph a script with the student's name visible. Cover it, or
crop the header before the answer begins.

---

## What you record for each answer

One line per photographed answer, on the tally sheet at the end of this
document. Five things:

| Column | What goes in it | Rules |
|---|---|---|
| **Answer ID** | `g07-s03` — the question's G-number from the table above, then the student number 01–05 within that question | Must be unique across the whole collection, and must match the photograph's filename exactly |
| **Question** | The marking sheet's name, e.g. `class10-science-2025-26-q13` | If you do not have it to hand, write the G-number and it will be filled in from the roster above |
| **Subject** | `Science`, `Mathematics` or `Social Science` | Exactly one of those three spellings, every time. This is what the per-subject table groups on, and `Maths` and `Science ` with a trailing space become separate subjects |
| **Out of** | 3 or 5 | Must match the question's marks in the roster. A mismatch here is rejected as corrupt input, not scored |
| **Your mark** | What you would award, in halves | Between 0 and the "out of" value. Halves only — CBSE's own grain. Never a range, never "2 or 3" |

Optionally a **note** — one line, free text. Use it when the answer is unusual:
"illegible last two lines", "answered the other option", "blank", "correct method,
arithmetic slip in the last step". These do not affect the score; they are what
makes a disagreement understandable afterwards.

**Name the photograph after the Answer ID:** `g07-s03.jpg`. Put all the
photographs in one folder. That folder plus the tally sheet is the entire
deliverable.

### Two rules that will otherwise cost a re-run

- **Every photographed answer needs a row, and every row needs a photograph.**
  The scorer fails the whole run if a row has no verdict or a verdict has no row.
  This is deliberate — a harness that silently drops answers reports 100% on the
  eight answers it happened to like.
- **Mark from the marking scheme, not from memory, and mark before you see any
  machine output.** If the machine's marks are visible first, they anchor yours,
  and the measurement becomes a measurement of nothing.

### What this turns into

Someone will transcribe the tally sheet into a file of records, one per answer,
each carrying: the answer ID, the question name, the subject, the marks out of,
and your mark. That is precisely the five columns above, which is why the columns
are what they are. A sixth field carries your note if you wrote one. The
photographs are listed alongside in a second, matching file: answer ID, question
name, photograph filename.

Nothing else is needed from you. If those two files line up, `spike-score.mjs`
prints the gate verdict.

---

## After the run — how to read the result

The report prints, in this order: any input problems; the spread of
disagreements; the within-1 rate by question size; the two failure directions
counted separately; the five worst over-marks and the five worst under-marks; a
per-subject table; and the three gate conditions.

Read the two failure directions first, before the pass/fail line.

- **A mean gap near zero with a wide spread** is a machine that is right on
  average and unreliable on any single answer. Bad, and not fixable by tuning
  a threshold.
- **A mean gap clearly above zero** is a machine that runs generous. Expect this
  if any unreviewed marking sheets got into the run.
- **A mean gap clearly below zero, concentrated in G18, G19, G24, G26, G29, G32
  and G09**, is the drawings problem in Warning 2, not a marking problem.

And the worst over-marks list is worth reading answer by answer even on a pass.
One answer over-marked by 2 that a teacher would have given zero is a more useful
finding than the headline percentage.

---
---

# Tally sheet

*Print one page per question. Photograph the answers first, then fill this in
with the marking scheme beside you.*

**Question G______**  Subject: ☐ Science ☐ Mathematics ☐ Social Science

Paper ______________________________  Question no. ________  Out of: ☐ 3 ☐ 5

Marking sheet name ______________________________________________

Marks on a drawing (if any): ______  ☐ none

Date ____________  Marked by ____________________________________

| Answer ID | Intended level | My mark (halves) | Note |
|---|---|---|---|
| g___-s01 | full / near-full | ______ / ____ | |
| g___-s02 | middling | ______ / ____ | |
| g___-s03 | middling | ______ / ____ | |
| g___-s04 | weak | ______ / ____ | |
| g___-s05 | nearly worthless | ______ / ____ | |
| g___-s06 | (spare / blank) | ______ / ____ | |

Photographs taken: ______   Lighting: ☐ tube light ☐ daylight ☐ lamp ☐ mixed

Checks before you move on:

☐ No ticks, crosses or marks totals appear in any photograph
☐ No student names are visible
☐ Every answer ID above has a photograph with exactly that filename
☐ Every photograph in the folder has a row above
☐ Every mark is between 0 and the "out of", in whole or half marks
☐ Nothing was corrected on the script before it was photographed

Where I disagreed with the marking sheet, and why:

_________________________________________________________________

_________________________________________________________________

_________________________________________________________________
