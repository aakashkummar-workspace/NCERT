# Rubric sign-off — one teacher, one day

You are being asked to settle 342 marking decisions that nobody has been qualified
to settle. Almost all of them are trivial. Fourteen of them are not, and until
those fourteen are decided, a correct answer scores zero.

This page is ordered so that if you stop after one hour, you will have done the
hour that mattered. Work top to bottom. Do not skip ahead.

**What you need:** the CBSE marking scheme PDF for each paper. They are all
mirrored under `public/papers/`, named after the paper — for example
`class10-science-2025-26-ms.pdf`. Each entry below names the paper, the question
number, and the page the answer is on.

**How to answer:** write your decision next to the entry, in words. "Yes, 1 mark
for the figure, take it from the second explanation step." "No, leave it." If you
disagree with how a question has been broken up, write the breakdown you would
use. There is no form to fill in and no vocabulary to learn.

**What your signature does.** Right now every one of these 342 questions is marked
in a deliberately lopsided way: the machine may award a mark, and may award a half
mark, but it is forbidden to say a student got something *wrong*. It cannot put a
single red stroke on an answer until a teacher has read the marking sheet for that
question. That rule exists so that no student is ever wrongly accused of writing
nothing of value. It also means that, until you sign these off, the machine can
only be generous — so nothing measured against it means anything.

---

## Where the day goes

| Part | What is in it | Questions | Time |
|---|---|---|---|
| **A** | The marking sheet is wrong today — a correct answer earns nothing | 14 | ~1 h 50 m |
| **B** | 3- and 5-mark questions: the ones the accuracy test is scored on | 27 | ~2 h 40 m |
| **C** | Longer answers where somebody invented a number CBSE did not print | 26 | ~1 h 45 m |
| **D** | One-mark objective questions | 275 | ~40 m (one ruling, then spot checks) |

Parts A and B together are about **4 hours 35 minutes** and are the whole of what
is blocking the project. C and D can wait for another sitting.

Every number on this page was counted from the files themselves by
`scripts/build-teacher-queue.mjs`, which writes the full working list to
`data/teacher-review-queue.json`. Re-run it after the rubrics change and the order
below changes with them.

---

# Part A — the marking sheet is wrong today

Fourteen questions. On each of these, a student can write an answer the official
scheme credits and be given nothing. These are not opinions about wording; they
are marks going missing.

Four of them share one shape: **the question has two or three parts, and only one
part was written up.** Everything the student wrote for the other parts earns
nothing at all.

---

### A1 · Science, 2024-25 sample paper, Q34 option A — 5 marks
*Marking scheme page 6.*

**The question.** "Keerthi thinks substitution reaction occurs in saturated
hydrocarbons, Krishi thinks it occurs in unsaturated hydrocarbons." Justify whose
thinking is correct; then a part about methane and propane; then any two
characteristics.

**What the scheme says.** Three things, in order: (i) Keerthi is correct, with the
reason — CBSE prints **1 mark** against it; (ii) the methane and propane part;
(iii) any two characteristics.

**What the marking sheet does now.** It contains one thing only: *any two
characteristics*, worth 2½ marks each, five marks in total. Parts (i) and (ii) are
not in it. A student who justifies Keerthi correctly and answers the methane part
correctly, and then runs out of time, scores **zero out of five**.

**Your decision.** How should the five marks be split across the three parts?
CBSE prints 1 for part (i); the rest is not printed anywhere.

- *If you split them properly:* the question marks correctly, and 2½-mark chunks
  disappear (CBSE does not award in 2½s anywhere else on this paper).
- *If you leave it:* every student who answered the first two parts and not the
  third is marked at zero.

**Second problem on the same question.** The paper says "attempt either option A or
option B", and only option A has been written up. Every student who chose option B
has nothing to be marked against at all. Does option B need writing up, or is it
acceptable to only ever set option A?

---

### A2 · Science, 2015-16 sample paper, Q21 — 5 marks
### A3 · Science, 2016-17 sample paper, Q21 — 5 marks
*Marking scheme page 4 in both. These are the same question, printed in two years —
decide once, apply to both.*

**The question.** How does speciation take place? Define the term *gene*. Then a
hair-colour cross: red is recessive to black, the child inherits red from the
mother and black from the father — what colour is the hair, and what does it show?

**What the scheme says.** Part A, speciation — migration, natural selection,
mutation, genetic drift, "any two". Part B, the definition of a gene. Part C, the
worked cross with the Punnett square.

**What the marking sheet does now.** Only part A, "any two", at 2½ marks each. The
definition of a gene earns nothing. The Punnett square earns nothing.

**Your decision.** Split the five marks across A, B and C. A conventional reading
is 2 for the two speciation points, 1 for the definition, 2 for the cross and its
conclusion — but that is a guess, and it is your guess that should stand, not ours.

- *If you split it:* a student who does the genetics and skips the recall is marked
  on the genetics.
- *If you leave it:* they score zero, in both years' papers.

---

### A4 · Science, 2022-23 practice paper, Q33 — 3 marks
*Marking scheme page 5.*

**The question.** Explain how the Sun's energy forms ozone in the stratosphere; why
ozone at ground level is a pollutant; and two health consequences of ozone
depletion.

**What the scheme says, printing its own marks.** (a) ½ mark each for two points
about UV radiation splitting oxygen and free oxygen recombining. (b) **1 mark** for
ozone being deadly at lower levels. (c) ½ mark each for any two health
consequences.

**What the marking sheet does now.** Only part (c) — any two consequences, at 1½
marks each. Parts (a) and (b) earn nothing, although CBSE printed marks against
both of them.

**Your decision.** This one is not really a judgment: the scheme prints ½ + ½ + 1 +
½ + ½. Confirm that reading and the question marks itself.

---

### A5 · Mathematics (Standard), 2022-23 sample paper, Q30 option A — 3 marks
*Marking scheme page 5.*

**The question.** Prove that a parallelogram circumscribing a circle is a rhombus.

**What the scheme says.** The proof, in four steps: name the tangent points, write
the four equal-tangent pairs, add them, conclude. No figure mark is printed in the
margin.

**What the marking sheet does now.** The four proof steps, and nothing for the
figure — even though a candidate cannot write this proof without labelling a
diagram, and every examiner expects one.

**Your decision.** Does the diagram carry a mark here? If yes, which of the four
written steps gives it up?

- *If yes:* a student who draws a correct labelled figure and writes a short proof
  is credited for the drawing.
- *If no:* it is marked purely on the written proof, which is what CBSE's margin
  literally says.

**Second problem.** This question is an "OR" and only the first option is written
up. Students who did the tangent-angle option have nothing to be marked against.

---

### A6 · Science, 2025-26 sample paper, Q13 — 3 marks
*Marking scheme page 2.*

**The question.** "Draw and explain how the nerve cells help in transmission of
impulses."

**What the scheme says.** Prose only — the dendritic tip detects, a chemical
reaction creates an impulse, it travels along the axon, and so on. It refers to
"(Fig. a)" and "(Fig. b)" inside its own sentences but prints **no separate figure
mark**.

**What the marking sheet does now.** It reserves 1 of the 3 marks for a correct
labelled neuron, leaving 2 for the explanation. That mark was *not* CBSE's — it was
put there by whoever wrote this file, on the grounds that the stem says "Draw".

**Your decision.** Keep the figure mark at 1, or move it back into the explanation?

- *If you keep it:* a student who draws a correct labelled neuron and writes little
  is credited for the drawing. But that mark can never be awarded by the machine —
  see the note on drawings below — so every student's total on this question is
  capped at 2 out of 3 until a human looks at the page.
- *If you move it back:* the question becomes fully machine-markable, and a student
  who draws beautifully and writes nothing scores zero.

---

### A7 · Science, 2016-17 sample paper, Q22 — 5 marks
*Marking scheme page 4.*

**The question.** Explain the formation of a rainbow **with the help of a diagram**;
list the three phenomena of light involved; which colour is at the top; and why the
Sun looks different at sunrise and at noon.

**What the scheme says.** Prose for all four parts. No figure mark in the margin.

**What the marking sheet does now.** Four written steps (1, 1½, ½, 2) and nothing
for the diagram the question explicitly asks for.

**Your decision.** Does the ray diagram carry a mark? If yes, take it from where?

---

### A8 · Science, 2025-26 sample paper, Q10 — 2 marks
*Marking scheme page 1.*

**The question.** "Unlike animals, plants do not have any excretory products as they
do not eat food." Comment with justification.

**The scheme's model answer opens** "It is completely wrong to say that plants do
not produce any excretory products", and then lists four strategies with "(any
two)" against them.

**What the marking sheet does now.** Two marks for any two strategies, at 1 each.
The opening rebuttal — which is the direct answer to "comment on the statement" —
earns nothing. Whoever wrote this checked the scheme and concluded CBSE really is
that harsh, because "(any two)" is the only quantity printed and it attaches to the
four strategies.

**Your decision.** Confirm that reading, or pay the rebuttal.

- *If you confirm:* a student who correctly rebuts the statement and lists nothing
  scores zero out of two. Harsh, but it is what the scheme prints.
- *If you pay it ½ and drop the strategies to ½ each:* CBSE does not credit
  quarter-marks, so a half-mark step is all-or-nothing — a student who names a
  strategy without explaining it would then get nothing for it rather than half.
  That may be a bigger wrong than the one it fixes.

---

### A9 · Social Science, 2023-24 practice paper set 2, Q37 — 5 marks
*Marking scheme page 17.*

**The question.** A map question: identify two marked places and write their names,
then locate and label further items on the same outline map of India.

**What the marking sheet does now.** Two written steps, worth 2 and 3, and nothing
identified as map work. The whole answer *is* map work.

**Your decision.** How many of the five marks are for correct locating and
labelling on the map, rather than for writing names? Anything you assign to the map
becomes work a human has to mark, because a machine cannot check a pencil cross on
an outline of India.

---

### A10 · Mathematics (Standard), 2022-23 sample paper, Q23 — 2 marks
*Marking scheme page 2.*

**The question.** "In the given figure, O is the centre of the circle. Find ∠AQB,
given PA and PB are tangents and ∠APB = 75°."

**What the marking sheet does now.** Three steps: the two right angles at the
radius, ∠AOB = 105°, then ∠AQB = 52.5°.

**Your decision.** The figure is printed on the question paper here, so the student
is not drawing it. Confirm that — and if you think a candidate is expected to
redraw and mark the figure, say what it is worth.

*(This is the same warning as A5 and A7 but almost certainly a false alarm: the
paper supplies the diagram. One line from you closes it.)*

---

### A11–A14 · Four questions where only half the choice is written up

The paper prints "either / or" and only one side exists in the file. **Every student
who attempted the other side has nothing to be marked against — they would come
back ungraded, not wrong.**

| | Paper | Question | Marks | The option that exists | The option that does not |
|---|---|---|---|---|---|
| A11 | Mathematics, 2018-19 sample paper, page 5 | Q21 | 3 | A — water flowing through a pipe into a tank | B — a solid sphere melted and recast |
| A12 | Mathematics (Basic), 2025-26 sample paper, page 5 | Q27 | 3 | B — the assumed-mean table, finding *p* | A |
| A13 | Mathematics (Standard), 2019-20 sample paper, page 6 | Q35 | 4 | B — constructing a pair of tangents | A — constructing a triangle and a similar triangle |
| A14 | Mathematics, 2018-19 sample paper, page 1 | Q7 | 2 | B — show 7 − √5 is irrational | A — HCF and LCM, find the other number |

**Your decision, once, for all four.** Is it acceptable to only ever set the option
that exists, or must the missing option be written up before this question is used?
If the second, that is four more marking sheets to author — not your work, but your
ruling decides whether it happens.

A13 has a second wrinkle: it is a **construction**. All four of its marks are for
drawing. A machine will never award them, so every attempt reads as zero until a
human marks the page. Confirm whether construction questions should be used at all
in an automatically marked set.

---

# Part B — the 27 questions the accuracy test is scored on

Every question here is worth **3 or 5 marks**. That matters because the accuracy
test — "does the machine mark like a teacher?" — is measured *only* on 3- and
5-mark answers. One-mark objectives are not counted, and neither are 2- and 4-mark
answers. So these 27 marking sheets set the number the whole project is judged on.

There are 41 such questions in total. Four are already signed off. The other **37**
are unreviewed — 10 of them appear in Part A above, and the remaining 27 are here.

Three kinds of decision, grouped so you can stay in one marking scheme at a time.

## B-i · CBSE printed one total; the split below it is a guess (8 questions)

For each of these the scheme prints a single number for the whole answer and no
per-part marks. Someone divided it up. Confirm the division or write your own.

| | Paper | Q | Marks | Split now in use | The judgment |
|---|---|---|---|---|---|
| B1 | Social Science 2022-23 practice, p10 | 26 | 3 | any 3 points at 1 each | is 1 mark a point right? |
| B2 | Social Science 2023-24 sample, p11 | 27 | 3 | any 3 points at 1 each | same |
| B3 | Social Science 2023-24 sample, p12 | 28 | 3 | any 3 at 1 each | but the question has three *different* asks — two union-list subjects, which list Education is in, and why. Is that really three equal points? |
| B4 | Science 2025-26 sample, p3 | 16 A | 5 | 1+1+1+1+1 across five steps | the last is "any one way variation can be bad" |
| B5 | Science 2025-26 sample, p10 | 37 | 3 | 1 explanation + 1 conclusion + 1 redrawn diagram | see the note on drawings |
| B6 | Social Science 2020-21 sample, p4 | 19 | 3 | any 3 ways at 1 each | the question says "suggest **and explain**" — does a named way with no explanation score the full mark? |
| B7 | Social Science 2020-21 sample, p10 | 29 | 5 | any 5 ways at 1 each | same question about "explain" |
| B8 | Science 2025-26 sample, p9 | 36 | 3 | 1½ for the area, 1½ for the length | a two-part numerical; is an even split right, or is the second part harder? |

B1, B2 and B3 carry a second, smaller note: the scheme reprints the question before
answering it, and the marking sheet pays nothing for that text. That is correct —
copying the question out earns nothing — but glance at it and say so.

## B-ii · "Any so many of the following", where the scheme did not say how many marks each (3 questions)

| | Paper | Q | Marks | Now |
|---|---|---|---|---|
| B9 | Social Science 2025-26 sample, p10 | 38 B | 5 | any five effects of privatisation, **at least two positive and two negative** |
| B10 | Social Science 2025-26 sample, p9 | 35 | 3 | any two public facilities, each explained |
| B11 | Social Science 2025-26 sample, p10 | 37 | 3 | any three factors enabling globalisation |

**Your decisions here.**

1. B9: the scheme says "at least 2 positive and 2 negative". The fifth point may
   come from either side — is that what CBSE intends?
2. B10: three marks for two facilities means 1½ each. **A named facility with no
   explanation currently scores the full 1½ or nothing at all** — there is no
   in-between, because CBSE has no ¾ mark. Should a named-but-unexplained facility
   score 1, with the explanation worth ½? That changes the shape of the question.
3. B11: the scheme says "any three well explained" but then lists the five factors
   as bare phrases with no explanation of its own. As it stands the marking only
   checks that the factor is **named**, not that it is explained — which is more
   generous than you would be. Tighten it or accept it.

## B-iii · A mark sits on a drawing (4 questions)

| | Paper | Q | Marks | Marks on the drawing |
|---|---|---|---|---|
| B12 | Science 2015-16 sample, p5 | 24 | 5 | 1 (the prism ray diagram) |
| B13 | Science 2016-17 sample, p2 | 11 | 3 | 1 (regeneration in Planaria) |
| B14 | Science 2016-17 sample, p5 | 23 | 5 | 2 (glass slab, and prism) |
| B15 | Science 2017-18 sample, p4 | 16 | 5 | 2 (the circuit diagram for the activity) |

**Read the note on drawings below before answering.** Confirm the number in the
last column, or move marks between the drawing and the writing.

## B-iv · The wording is loose (12 questions)

These twelve are conversions of the scheme's own sentences, with the marks straight
off CBSE's margin. Nothing is invented. The only thing wrong with them is that
**all the distinctive words of a step were dumped into one list, and writing any one
of them earns the whole mark.** So a student who writes "prism" earns the mark for a
sentence about prisms refracting, dispersing and internally reflecting.

| | Paper | Q | Marks |
|---|---|---|---|
| B16 | Mathematics 2022-23 practice, p3 | 26 | 3 |
| B17 | Mathematics (Basic) 2023-24 sample, p5 | 29 | 3 |
| B18 | Mathematics (Basic) 2024-25 sample, p3 | 26 | 3 |
| B19 | Science 2015-16 sample, p1 | 8 | 3 |
| B20 | Science 2015-16 sample, p2 | 10 | 3 |
| B21 | Science 2015-16 sample, p2 | 11 | 3 |
| B22 | Science 2015-16 sample, p2 | 13 | 3 |
| B23 | Science 2015-16 sample, p3 | 17 | 3 |
| B24 | Science 2015-16 sample, p4 | 22 | 5 |
| B25 | Science 2016-17 sample, p2 | 14 | 3 |
| B26 | Science 2016-17 sample, p3 | 18 | 3 |
| B27 | Science 2017-18 sample, p1 | 8 | 3 |

**Your decision for each** — and you can go fast here, a minute apiece: for each
step, is there a word or an idea an answer **must** contain, or is any of the listed
words genuinely enough? Underline the must-haves. Where the answer is a specific
term or number — *Propanal*, *Ethanoic acid*, *plumule*, *radicle* — say so, because
those should not be satisfied by a near miss.

B21 (future shoot, future root, cotyledon) and B19 (naming members of the aldehyde
and carboxylic series) are the clearest examples: those are exact names, and near
misses should not pass.

---

# Part C — 26 longer answers, 2 and 4 marks

Same three kinds of decision as Part B, on questions that do not count towards the
accuracy test. Worth doing, not worth doing first. The full list is in
`data/teacher-review-queue.json`, entries 42 to 67. Seven of them have an invented
mark split, two put a mark on a drawing, one carries an "at least one climate and
one economic" requirement, and the remaining sixteen are the loose-wording case
from B-iv.

The climate-and-economic one is worth a look even out of order — Social Science
2025-26 Q16. The scheme demands "at least one related to climate and one economic".
One of the listed points is about farming practices, and it has been filed as
*economic* so that it can partner the climate point. If you think farming practices
are a third category, then an answer built from two particular points would stop
being full marks.

---

# Part D — 275 one-mark objective questions, one ruling

Every one of these is an MCQ or an assertion-reason. The marking accepts either the
bare option letter — "C" — or the wording of that option.

**One question decides all 275: is writing the letter alone a full answer?**

In a board exam it is. Say so once and the whole part is settled, and spend ten
minutes spot-checking one in ten to see the right letter was recorded.

Twenty-four of them carry a second, automatic warning that says a student who draws
a figure would score nothing. In every one of the twenty-four the figure is
**printed on the question paper** — "in the figure below", "shown below is a circle"
— and the student draws nothing. Confirm that in one line and those close too.

---

# The note on drawings

There are seven 3- and 5-mark questions where a mark sits on a figure, and three
more among the 2- and 4-mark ones — one of them is A13, the construction, where
every mark is a drawing. **A machine never marks a drawing.** It cannot
honestly say whether a ray diagram is right from a photograph, so it awards nothing
and leaves that mark blank for a person.

This matters more than it sounds. On Science 2016-17 Q23, two of the five marks are
on drawings, so **the highest score a machine can give is 3 out of 5** — for a
perfect script. If those questions go into the accuracy test unaltered, the machine
will look systematically harsh on them, and the harshness will be an artefact of
the test rather than anything about its marking.

So for each of the seven, choose one:

1. **Keep the figure mark, and a human marks that mark** — correct, but the question
   is then only partly automatic.
2. **Move the mark into the written explanation** — fully automatic, but a student
   who draws well and writes little loses out.
3. **Keep the question out of the accuracy test** — honest, but it thins an already
   thin set of measurements.

The seven are: Science 2015-16 Q24 (1 of 5), Science 2016-17 Q11 (1 of 3), Science
2016-17 Q23 (2 of 5), Science 2017-18 Q16 (2 of 5), Science 2025-26 Q13 (1 of 3),
Science 2025-26 Q37 (1 of 3), and Mathematics (Basic) 2025-26 Q34 option A (1 of 5,
already signed off — worth a second look now that the consequence is clear).

---

# If you only have an hour

Do A1 to A6. That is six questions, roughly fifty minutes, and it stops the six
worst cases of a correct answer being marked at zero.

# If you have a day

Parts A and B — 41 questions, about four and a half hours — and then read
`docs/teacher-ground-truth.md`, which asks you for something different: a set of
real student answers, marked by you, against which the machine can finally be
measured. It will not take the rest of the day, but it needs to be started on the
same day, because the answers it asks you to collect are the answers to the very
questions you have just signed off.
