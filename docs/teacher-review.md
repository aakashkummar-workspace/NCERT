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
| **A** | The marking sheet is wrong today — a correct answer earns nothing | 14 | ~40 m |
| **B** | 3- and 5-mark questions: the ones the accuracy test is scored on | 27 | ~2 h 40 m |
| **C** | Longer answers where somebody invented a number CBSE did not print | 26 | ~1 h 45 m |
| **D** | One-mark objective questions | 275 | ~40 m (one ruling, then spot checks) |

Part A used to be an hour and fifty minutes, because it asked you to *write*
fourteen marking decisions from the schemes. Each of them now arrives as a
concrete breakdown to approve or amend, so what is left is reading — about forty
minutes of it. Parts A and B together are about **3 hours 20 minutes** and are
the whole of what is blocking the project. C and D can wait for another sitting.

Every number on this page was counted from the files themselves by
`scripts/build-teacher-queue.mjs`, which writes the full working list to
`data/teacher-review-queue.json`. Re-run it after the rubrics change and the order
below changes with them.

---

# Part A — the marking sheet is wrong today

Fourteen questions. On each of these, a student can write an answer the official
scheme credits and be given nothing. These are not opinions about wording; they
are marks going missing.

**Each one now comes with a proposal.** Somebody has since sat with every one of
these marking schemes and drafted the breakdown they think it should have —
written out in full, in the same shape the marking sheets use, so that adopting
one is a copy rather than an afternoon. The drafts live in
`data/rubric-proposals.json`; you do not have to open it, because each of them is
written out below in words.

**None of them is live.** Not one byte of the marking sheets has changed. A
proposal becomes marking when you say so and somebody copies it across, and not
before. Where a draft rests on a guess, the guess is named. Where CBSE printed a
number, that number was left alone.

So the question in front of you has changed shape. It is no longer *what should
this be worth?* It is *is this right?* — usually a yes, a no, or one number.

Four of these fourteen share one shape: **the question has two or three parts,
and only one part was written up.** Those four took the most care, and they come
first.

---

### A1 · Science, 2024-25 sample paper, Q34 option A — 5 marks
*Marking scheme page 6.*

**The question.** "Keerthi thinks substitution reaction occurs in saturated
hydrocarbons, Krishi thinks it occurs in unsaturated hydrocarbons." Justify whose
thinking is correct; then a part about methane and propane, an electron dot
structure and any two characteristics; then a part about ethyne.

**What the marking sheet does now.** It contains one thing only: *any two
characteristics*, worth 2½ marks each. A student who answers everything else
correctly and runs out of time before the characteristics scores **zero out of
five**.

**What CBSE actually printed.** Five separate 1s down the margin, and I read
every one of them off the page rather than off a summary. One for the Keerthi
justification. One for methane and propane burning in oxygen and giving out a lot
of energy. One for the electron dot structure of ethane. One for the two
characteristics. One for the ethyne answer. **The split of this question is
entirely CBSE's.** There was never anything here to invent.

**The proposal.**

| Worth | For |
|---|---|
| 1 | Keerthi is right — substitution replaces hydrogen in a saturated hydrocarbon; an unsaturated one adds across the double or triple bond |
| 1 | methane and propane burn in oxygen and release a large amount of energy |
| 1 | the electron dot structure of ethane — **a drawing** |
| ½ + ½ | any two characteristics of a homologous series, from CBSE's four |
| 1 | ethyne with enough oxygen burns clean and blue; with air it burns sooty |

**What is inferred, and what it rests on.** Two things only. CBSE prints one mark
against "any two characteristics" and asks for two of them, so half a mark each
is the only division its own half-mark grain allows. And the electron dot
structure is treated as a drawing rather than as words — which means that mark
can never be awarded by the machine, and waits for you. See the note on drawings.

**Your decision.** Two yes/nos. Half a mark a characteristic — yes? And is the
electron dot structure a drawing you want to mark yourself, or would you rather
the machine accepted the written word "ethane" for it?

**What changes for a student.** Someone who answers the first, second and last
parts and lists no characteristics goes from **zero out of five to four out of
five**. Someone who lists two characteristics and nothing else goes from five to
one. Because of the drawing, the machine's own ceiling here becomes four out of
five.

**The other half of the choice.** Option B — the soap and micelle question — had
nothing written up at all, so everyone who chose it came back ungraded. It is
drafted now, and it needed no judgment whatever: CBSE prints 1, then "labelled
figure 1 + 2", then "0.5 + 0.5". Your question there is only whether it is
accurate enough to use. Note that CBSE itself puts a mark on the micelle diagram,
so that option tops out at four of five for the machine.

---

### A2 · Science, 2015-16 sample paper, Q21 — 5 marks
### A3 · Science, 2016-17 sample paper, Q21 — 5 marks
*Marking scheme page 4 in both. These are the same question, printed in two
years. I compared the two pages line by line — the answer text and the mark
column are identical, down to the position of every number. Decide once.*

**The question.** How does speciation take place? Define the term *gene*. Then
the hair-colour cross: red is recessive to black, the child inherits red from the
mother and black from the father.

**What the marking sheet does now.** A single "any two of" group at 2½ each — and
the two things it will accept are the *definition of the gene* and the *cross*.
So the speciation part, which is what the group is named after, earns nothing at
all; and a student who does the genetics without mentioning speciation scores a
full five.

**What CBSE actually printed.** Six numbers down the margin: 1, 1, ½, ½, 1, 1.
An earlier version of this page said the scheme prints only a total. It does not —
it prints all six, and reading them off by line position rather than by text
order is what makes them usable:

| Aligned with | Mark |
|---|---|
| "A. Speciation may take place by" | 1 |
| the end of the gene definition | 1 |
| "Red hair – Mother – Recessive, bb" | ½ |
| "Black hair – father Dominant, BB" | ½ |
| the row of the parents' cross | 1 |
| the F1 row, Bb, black | 1 |

**The proposal.** Exactly those six: half a mark for each of two speciation
mechanisms, making one; 1 for the gene as a functional segment of DNA; ½ for the
mother's contribution and ½ for the father's; 1 for setting out the cross; 1 for
reaching Bb and saying the hair is black.

**What is inferred.** Only the half-and-half inside the speciation part — CBSE
prints one mark there and asks for two mechanisms, and one divides into two
halves and nothing else. And the closing line, "the child will have black hair",
is treated as part of the F1 mark rather than as a seventh line, because the
margin prints nothing beside it and no mark is left over.

**Your decision.** One number and one sanity check. Is part A really worth one
mark for two mechanisms — half a mark each? And does my reading of that mark
column match yours? If it does not, write the six numbers you would use.

**What changes for a student.** Someone who names two mechanisms and stops goes
from **zero out of five to one**. Someone who defines the gene and works the cross
and skips speciation goes from five to four. Scoring stops depending on which two
of the three parts they happened to reach — in both years' papers.

---

### A4 · Science, 2022-23 practice paper, Q33 — 3 marks
*Marking scheme page 5.*

**The question.** Explain how the Sun's energy forms ozone in the stratosphere;
why ozone at ground level is a pollutant; and two health consequences of ozone
depletion.

**What the marking sheet does now.** Only the health consequences, at 1½ each —
and one of the three things it accepts is the scheme's own instruction line, so
writing the bare word "consequences" scores 1½. Parts (a) and (b) earn nothing,
although CBSE printed marks against both.

**What CBSE actually printed.** All three marks, in words: half a mark for each
of two points about the ozone forming, one mark for ozone at lower levels being
deadly, half a mark each for two health consequences. Nothing here was ever a
judgment.

**The proposal.** ½ — high-energy ultraviolet from the Sun breaks molecular
oxygen into free oxygen. ½ — that free oxygen combines with more oxygen to make
ozone. 1 — at ground level ozone is deadly to humans, which is why it counts as a
pollutant there. ½ + ½ — any two health consequences.

**What is inferred.** Only which consequences to accept. CBSE lists skin cancer
and cataract and adds "accept any other valid answer"; the draft also allows a
weakened immune system, and sunburn or premature ageing of the skin.

**Your decision.** Not really the marks — they are printed. Just: are those two
extra consequences acceptable? If not, strike them.

**What changes for a student.** Someone who explains the formation and the
ground-level pollutant and names no consequence goes from **zero out of three to
two**. Someone who writes the bare word "consequences" goes from 1½ to nothing.

---

### A5 · Mathematics (Standard), 2022-23 sample paper, Q30 option A — 3 marks
*Marking scheme page 5.*

**The question.** Prove that a parallelogram circumscribing a circle is a rhombus.

**What the marking sheet does now.** The marks are right. The words are not: the
step for adding the four tangent equalities is satisfied by the single word
"adding", and the opening step by the word "circle". A student who writes "adding
the circle" collects two of the three.

**What CBSE actually printed.** 1, 1, ½, ½ — against naming the tangent points
and writing the four equal-tangent pairs; against reaching AB + CD = AD + BC;
against using that opposite sides of a parallelogram are equal; against the
conclusion. And **no figure mark anywhere in the column** — although the scheme's
own page sets its text around a drawn figure. CBSE plainly had a diagram in mind
and still paid nothing for it.

**The proposal.** CBSE's four numbers unchanged, with each step given the ideas it
actually needs rather than a bag of words: the equal-tangent property *and* the
four pairs; the addition *and* the equation it lands on; the opposite-sides fact;
the conclusion that all four sides are equal, so it is a rhombus.

**Your decision.** One yes/no, and it is the real one. The paper supplies no
figure here, so the candidate has to draw and label one to write this proof at
all. Does that drawing carry **half a mark, taken out of the first step**? If yes,
the replacement steps are already drafted and adopting them is a tick.

- *If yes:* a student who draws a correct labelled figure and writes a short proof
  gains half a mark — and the machine's ceiling on the question drops to 2½ of 3,
  because a drawing waits for a person.
- *If no:* CBSE's column stands exactly as printed.

**What changes for a student.** As drafted, nobody's total moves; what stops is
single loose words earning whole marks.

**The other half of the choice.** Only the first option was written up. The
tangent-angle option is drafted now, straight off CBSE's column on page 6: 1,
then ½, ½, ½, ½. Its figure is printed on the question paper, so no drawing mark
arises and the whole option is machine-markable.

---

### A6 · Science, 2025-26 sample paper, Q13 — 3 marks
*Marking scheme page 2.*

**The question.** "Draw and explain how the nerve cells help in transmission of
impulses."

**What the marking sheet does now.** It reserves 1 of the 3 marks for a correct
labelled neuron and leaves 2 for the explanation. That mark was *not* CBSE's — it
was put there by whoever wrote the file, on the grounds that the stem says "Draw".

**What CBSE actually printed.** One number: 3, against the whole answer. Nothing
per step, and no figure mark. The scheme's body is three prose bullets, and it
mentions "(Fig. a)" and "(Fig. b)" inside its own sentences without paying for
either.

**The proposal.** One mark per bullet, following the scheme's own three bullets:
1 for detecting information at the dendritic tip and the chemical reaction that
creates the impulse; 1 for the impulse travelling to the cell body and along the
axon, and the chemicals released at its end; 1 for those chemicals crossing the
synapse and starting the impulse again in the next neuron. **No figure mark.**

**What is inferred.** All of it — CBSE printed only a 3. What it rests on is that
the scheme's own answer is three bullets and the question is worth three marks.

**Your decision, and this is the one to be most sceptical of.** This is the only
proposal in the whole set that **takes a mark away** rather than restoring one.
Do you follow the scheme — 1 + 1 + 1, fully machine-markable — or does "Draw" in
the stem earn a mark you will mark by hand?

- *If you follow the scheme:* a student who writes all three stages goes from a
  capped **two out of three to three**, and the question stops dragging the
  accuracy test down. A student who draws beautifully and writes nothing loses out.
- *If you keep the figure mark:* leave the marking sheet exactly as it is today
  and strike this proposal. Every student's total here stays capped at two of
  three until a human looks at the page.

---

### A7 · Science, 2016-17 sample paper, Q22 — 5 marks
*Marking scheme page 4.*

**The question.** Explain the formation of a rainbow **with the help of a
diagram**; list the three phenomena of light involved; which colour is at the
top; and why the Sun looks different at sunrise and at noon.

**What the marking sheet does now.** The four marks are right and the words are
wrong. Two different steps are both satisfied by the single word "dispersion", so
writing it twice collects two of the five — and **"Red", CBSE's own half-mark
answer, is not checked for at all**: that step's words were copied from the line
above it.

**What CBSE actually printed.** 1 against the water-droplets-as-prisms paragraph;
1½ against naming the three phenomena; ½ against "Red"; 2 against the sunrise,
sunset and noon paragraph.  No figure mark, though the question asks for a
diagram in so many words.

**The proposal.** CBSE's four numbers, with each step given its real ideas: the
droplet acting as a prism *and* refraction *and* internal reflection; all three
phenomena named, with two of three worth 1; "Red" on its own, and not satisfied
by a near miss; and the long path and scattering at sunrise *and* the short path
and white Sun at noon, with either half alone worth 1.

**Your decision.** One yes/no: does the ray diagram carry **half a mark, taken out
of the three-phenomena step**, leaving it at 1? The replacement is already drafted
either way.

**What changes for a student.** As drafted, nobody's total moves, but "Red"
finally earns its half mark and one repeated word stops earning two. If you take
the figure mark too, the machine's ceiling here becomes 4½ of 5.

*One caveat that applies here and to several others.* The marking sheets carry
"or equivalent wording" as a single setting for a whole question, not for one
step of it. So where a draft says an answer must be exact — "Red", 52.5, 1000,
72, "saponification" — that is recorded as an instruction to whoever builds the
marking, not as a switch that has been flipped. If you want those enforced, say
so, because it may mean turning the setting off for the whole question and
tightening the prose steps with it.

---

### A8 · Science, 2025-26 sample paper, Q10 — 2 marks
*Marking scheme page 1.*

**The question.** "Unlike animals, plants do not have any excretory products as
they do not eat food." Comment with justification.

**What the marking sheet does now.** Two marks for any two strategies, at 1 each.
The opening rebuttal — the direct answer to "comment on the statement" — earns
nothing.

**The proposal is: no change.** I read the page myself rather than the summary,
and CBSE really is that harsh. The only quantity printed is "(any two)", and it
attaches to the four strategies. The one alternative the half-mark grain allows
is 1 for the rebuttal and half a mark per strategy — which would drop a student
who lists two strategies without an explicit rebuttal, *which is the scheme's own
model answer*, from two out of two to one. That is a bigger wrong than the one it
fixes.

**Your decision.** Confirm the reading, in one line, or overrule it.

**What changes for a student.** Nothing in the scoring. What changes is that the
marking sheet stops being unreviewed, so the machine is finally allowed to mark a
genuinely empty answer wrong on it.

---

### A9 · Social Science, 2023-24 practice paper set 2, Q37 — 5 marks
*Marking scheme page 17.*

**The question.** Identify two places marked on an outline map of India and write
their names; then locate and label any three of four further items on the same
map.

**What the marking sheet does now.** Two steps that match on the words of the
*question* rather than on any answer — one is satisfied by the word "India", the
other by "Jallianwala Bagh". A student who names both places correctly and marks
all three symbols may match neither.

**What CBSE actually printed.** The section heading itself says it: "MAP SKILL
BASED QUESTION (2+3=5)", and 2 and 3 again in the margin. Two marks for naming
the two marked places, three for locating and labelling any three items with
suitable symbols.

**The proposal.** 1 for the first place, 1 for the second, and 3 for the map work
— held as a single piece of **drawing**, because a machine cannot see where a
pencil cross was put on an outline of India.

**And now the problem I could not settle.** *The marking scheme answers a
different question paper.* This paper's Q37 asks for the place associated with
the peasant satyagraha in Gujarat, and for the Congress session of December 1920.
The scheme on page 17 answers "Madras — Congress session 1927" and "Amritsar —
the Jallianwala Bagh". CBSE appears to have printed another set's answers on that
page. The draft therefore uses **Kheda** and **Nagpur** — the answers to the
questions actually asked — and those two names are mine, not CBSE's. This is the
single place in the whole set where a proposal contradicts the printed scheme,
and it must not be signed off without you agreeing to that.

**Your decision.** Two. Are Kheda and Nagpur right for A and B? And do you accept
that the three map marks are yours to award by hand — or should a name written
beside the symbol be enough? CBSE prints exactly that name-only version on the
same page, for visually impaired candidates, so the wording already exists if you
want it.

**What changes for a student.** Students stop being scored on whether they
happened to write the word "India". Two of the five become markable; the other
three wait for you, and honestly so.

---

### A10 · Mathematics (Standard), 2022-23 sample paper, Q23 — 2 marks
*Marking scheme page 2.*

**The question.** "In the given figure, O is the centre of the circle. Find ∠AQB,
given PA and PB are tangents and ∠APB = 75°."

**The figure warning is a false alarm.** The paper prints the figure, the stem
opens "in the given figure", and the student draws nothing. One line from you
closes it.

**The real problem.** All three steps accept the bare word "angle". Writing
"angle" three times scores **two out of two**, and none of the three numbers —
90, 105, 52.5 — is checked for at all.

**What CBSE actually printed.** ½ against the two right angles between radius and
tangent; ½ against the 105° at the centre; 1 against 52.5°.

**The proposal.** CBSE's three numbers, with the numbers themselves required, and
a near miss not accepted on the final answer.

**What is inferred.** Two allowances on the last step, both mine: half a mark kept
for a candidate who quotes the centre-angle rule, halves 105 and slips in the
arithmetic; and half a mark kept for a right value written without a degree sign.

**Your decision.** Confirm the figure is the paper's, in one line. And: should an
arithmetic slip on the last step keep half a mark, or is 52.5 all or nothing?

**What changes for a student.** The numbers finally have to be right. Someone who
writes "angle" and no working goes from two out of two to nothing.

---

### A11–A14 · Four questions where only half the choice is written up

The paper prints "either / or" and only one side existed in the file. **Every
student who attempted the other side had nothing to be marked against — they came
back ungraded, not wrong.**

**All four missing options are drafted now**, and every one of them was easier
than it looked, because the Mathematics schemes print their marks in the margin
throughout. Nothing below required a judgment about how many marks anything is
worth.

| | Paper | Question | Marks | The option that was missing | What CBSE printed for it |
|---|---|---|---|---|---|
| A11 | Mathematics, 2018-19, page 5 | Q21 | 3 | a solid sphere melted and recast into balls | 1 for setting up "number of balls = big volume ÷ small volume", 1 for substituting, 1 for the answer 1000 |
| A12 | Mathematics (Basic), 2025-26, page 4 | Q27 | 3 | finding the modal agriculture holding | 1 for picking the modal class 5–7 and reading off its values, 2 for substituting into the mode formula and reaching 6.17 hectares |
| A13 | Mathematics (Standard), 2019-20, page 6 | Q35 | 4 | constructing a triangle and a similar triangle | 1 for the given triangle, 3 for the similar one at scale factor ¾ — CBSE's own words are "correct construction" for both |
| A14 | Mathematics, 2018-19, page 1 | Q7 | 2 | HCF and LCM, find the other number | 1 for "HCF × LCM = the product of the two numbers", 1 for reaching 72 |

**Your decisions.**

1. **Are the four drafts accurate enough to use?** Mostly a glance apiece. Two
   carry a small extra question. On A11, the scheme quietly uses a radius of 0.3
   where the paper gives a diameter of 0.6 — should a candidate who substitutes
   0.6 keep half the mark as a slip, or lose it as a misunderstanding? On A12, the
   scheme's own answer is 6.166 rounded to 6.17; the draft accepts both.
2. **A13 is the one to think about, and the draft may be the wrong thing to
   want.** All four of its marks are a construction, and so are all four of the
   option already in the file. A machine will award nothing on that question for
   any script, ever, including a perfect one. Writing up the missing option turns
   "no marking sheet" into "a page you mark entirely by hand" — which is better,
   but not by much. **Should construction questions be in an automatically marked
   set at all?** If not, withdraw Q35 rather than adopt the draft.

**What changes for a student.** On A11, A12 and A14, students who took the missing
option stop coming back ungraded and get a fully machine-marked answer. On A13
they stop coming back with nothing at all against their script, and get four marks
reserved for a person instead.

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

The same fault is in six of the Part A questions, and there the proposals above
already fix it — worth glancing at one of them (A7 is the clearest) before you
start here, because it shows the shape of the answer these twelve want.

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

This is worth holding on to while you read Part A, because several of the proposals
there turn on it. **Agreeing to a drawing mark is not agreeing that the machine will
judge the drawing.** It is reserving that mark for yourself, and lowering the
machine's top score on that question by exactly that much.

That matters more than it sounds. On Science 2016-17 Q23, two of the five marks are
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

Science 2025-26 Q13 is A6 above, where the proposal argues for option 2 and says
why. It is the one to disagree with if you are going to disagree with anything.

---

# If you only have an hour

Do A1 to A6. That is six questions, and with the proposals in front of you it is
now perhaps twenty minutes rather than fifty — which stops the six worst cases of a
correct answer being marked at zero and leaves you most of the hour for Part B.

# If you have a day

Parts A and B — 41 questions, about three and a half hours — and then read
`docs/teacher-ground-truth.md`, which asks you for something different: a set of
real student answers, marked by you, against which the machine can finally be
measured. It will not take the rest of the day, but it needs to be started on the
same day, because the answers it asks you to collect are the answers to the very
questions you have just signed off.
