# Mapping NCERT Exemplar units onto the current textbooks

`data/exemplar-chapter-map.json` is the bridge between the NCERT Exemplar
Problems books in `public/exemplar/` and the textbooks a student actually has.
This file is why each row says what it says.

Nothing here is generated. `scripts/extract-exemplar-questions.ts` reads the map
and refuses to file a question anywhere the map does not send it.

Sixty-seven rows: thirty-three for Class 9 (`ieep1`, `ieep2`), thirty-four for
Class 10 (`jeep1`, `jeep2`).

## Why a map is needed at all

Three separate problems stack up.

**The book codes do not match.** The Class 9 Science Exemplar is `ieep1` and the
Maths Exemplar is `ieep2`; Class 10 has `jeep1` and `jeep2`. None of those codes
exists in `data/manifest.json`, and `scripts/check-questions.mjs` rejects a
question whose `bookCode` the manifest does not know — correctly, because the app
derives class and subject from the book. The textbooks are `iesc1`/`iemh1` for
Class 9 and `jesc1`/`jemh1` for Class 10.

**The syllabus does not match.** The Exemplars were written for the
pre-rationalisation syllabus. Class 9 is now on the new NCF books, in which
chapters were re-cut, merged, dropped and re-ordered. Class 10 kept the same
books but the 2023 rationalisation cut whole chapters out of them: `jeep1` has 16
content units where `jesc1` now has 13 chapters, and `jeep2` has 13 where
`jemh1` has 14 (one Exemplar unit having been split in two, and another chapter
deleted).

**The titles mislead — badly in Class 9, quietly in Class 10.** The NCF Class 9
books are titled thematically: `iemh1` chapter 5 is *"I'm Up and Down, and Round
and Round"* and is the circles chapter; `iesc1` chapter 9 is *"Atomic Foundations
of Matter"* and is the laws of chemical combination, while chapter 8, *"Journey
Inside the Atom"*, is atomic structure. Class 10 looks safer, because the titles
still match — and that is exactly its trap. `jesc1` chapter 8 is called
*"Heredity"*, one word shorter than the Exemplar's *"Heredity and Evolution"*,
and the missing word is half the unit. Every Class 10 chapter from Life Processes
onward is also renumbered, because the chapter before it was deleted.

## How each row was decided

The same way `data/prerequisites.json` was built: by reading the current books
rather than their titles.

Every chapter PDF in `public/ncert/` was passed through `pdfjs-dist` and its
numbered section headings (`4.2 Graphical Representation of Motion`, `6.8.1
Heron's formula`, `12.2.2 Right-Hand Thumb Rule`) pulled out, then the whole text
searched for the terms that define each Exemplar unit — *latent*, *universal
law*, *free fall*, *transversal*, *histogram*, *cylinder*, *husbandry*,
*Mendeleev*, *Darwin*, *biogas*, *Chipko*, *frustum*, *completing the square*.
A unit was mapped only where the sections cover it; the `evidence` array in each
row names the headings or the search that settled it.

The rule when the evidence ran out is the one `CLAUDE.md` already states for
chapter titles: **prefer an honest gap to a wrong label.** A question filed under
the wrong chapter poisons the SM-2 revision schedule and the weak-area dashboard,
and nothing in the UI could reveal it to student, parent or teacher.

## Class 9 — 17 of 31 content units mapped

**Science (`ieep1`): 11 of 15.**

| Exemplar unit | `iesc1` chapter | Confidence |
|---|---|---|
| 2 Is Matter Around Us Pure | 5 Exploring Mixtures and their Separation | high |
| 3 Atoms and Molecules | 9 Atomic Foundations of Matter | high |
| 4 Structure of the Atom | 8 Journey Inside the Atom | high |
| 5 The Fundamental Unit of Life | 2 Cell: The Building Block of Life | high |
| 6 Tissues | 3 Tissues in Action | high |
| 7 Diversity in Living Organisms | 12 Patterns in Life: Diversity and Classification | high |
| 8 Motion | 4 Describing Motion Around Us | high |
| 9 Force and Laws of Motion | 6 How Forces Affect Motion | high |
| 11 Work and Energy | 7 Work, Energy, and Simple Machines | high |
| 12 Sound | 10 Sound Waves : Characteristics and Applications | high |
| 14 Natural Resources | 13 Earth as a System: Energy, Matter, and Life | medium |

**Mathematics (`ieep2`): 6 of 14.**

| Exemplar unit | `iemh1` chapter | Confidence |
|---|---|---|
| 1 Number Systems | 3 The World of Numbers | high |
| 3 Coordinate Geometry | 1 Orienting Yourself: The Use of Coordinates | high |
| 4 Linear Equations in Two Variables | 2 Introduction to Linear Polynomials | medium |
| 9 Areas of Parallelograms and Triangles | 6 Measuring Space: Perimeter and Area | medium |
| 10 Circles | 5 I'm Up and Down, and Round and Round | high |
| 12 Heron's Formula | 6 Measuring Space: Perimeter and Area | high |

**The twelve Class 9 gaps.** Dropped from Class 9 entirely — nothing in the
current book teaches them, so there is no chapter to revise from: Science 1
*Matter in Our Surroundings* ("latent" appears nowhere in `iesc1`), 10
*Gravitation* (no universal law, no free fall, no thrust, no Archimedes — only
buoyancy, as a paragraph inside ch6), 13 *Why Do We Fall Ill* (no
health-and-disease chapter at all), 15 *Improvement in Food Resources*; Maths 5
*Euclid's Geometry*, 6 *Lines and Angles*, 7 *Triangles*, 8 *Quadrilaterals*, 11
*Constructions*, 13 *Surface Areas and Volumes*. Re-cut across chapters, with no
single owner: Maths 2 *Polynomials* (linear part in ch2, identities in ch4,
remainder and factor theorems gone) and Maths 14 *Statistics and Probability*
(probability is ch7, statistics has no chapter). Four further rows are the
Science sample papers and the Maths question-paper designs, which are not
chapters at all.

## Class 10 — 25 of 29 content units mapped

Class 10 is on the same books the Exemplar was written for, so the mapping is
mostly one to one — and the interesting part is what rationalisation took away.

**Science (`jeep1`): 13 of 16.**

| Exemplar unit | `jesc1` chapter | Confidence |
|---|---|---|
| 1 Chemical Reactions and Equations | 1 (same) | high |
| 2 Acids, Bases and Salts | 2 (same) | high |
| 3 Metals and Non-metals | 3 (same) | high |
| 4 Carbon and its Compounds | 4 (same) | high |
| 6 Life Processes | 5 | high |
| 7 Control and Coordination | 6 | high |
| 8 How do Organisms Reproduce? | 7 | high |
| 9 Heredity and Evolution | 8 Heredity | **medium** |
| 10 Light – Reflection and Refraction | 9 | high |
| 11 The Human Eye and the Colourful World | 10 | high |
| 12 Electricity | 11 | high |
| 13 Magnetic Effects of Electric Current | 12 | high |
| 15 Our Environment | 13 | high |

**Mathematics (`jeep2`): 12 of 13.**

| Exemplar unit | `jemh1` chapter | Confidence |
|---|---|---|
| 1 Real Numbers | 1 (same) | high |
| 2 Polynomials | 2 (same) | high |
| 3 Pair of Linear Equations in Two Variables | 3 (same) | high |
| 4 Quadratic Equations | 4 (same) | high |
| 5 Arithmetic Progressions | 5 (same) | high |
| 6 Triangles | 6 (same) | medium |
| 7 Coordinate Geometry | 7 (same) | high |
| 8 Introduction to Trigonometry and its Applications | 8, and Q15 → 9 | high |
| 9 Circles | 10 | high |
| 11 Area Related to Circles | 11 | medium |
| 12 Surface Areas and Volumes | 12 | medium |
| 13 Statistics and Probability | 13, and Q12–Q26 → 14 | high |

### The four Class 10 gaps — all four are rationalisation

Unlike Class 9, no Class 10 unit is a gap because the book was re-cut. Every one
is a chapter the 2023 rationalisation deleted outright:

- **Science 5 *Periodic Classification of Elements*.** `jesc1` runs Chemical
  Reactions, Acids Bases and Salts, Metals and Non-metals, Carbon and its
  Compounds, then straight to Life Processes. `periodic table`, `Mendeleev`,
  `Dobereiner` and `modern periodic` get zero hits across all thirteen chapters.
- **Science 14 *Sources of Energy*.** `biogas`, `solar cooker` and `nuclear
  energy`: zero hits.
- **Science 16 *Management of Natural Resources*.** `Chipko`, `watershed`,
  `coliform` and `Ganga`: zero hits. *Our Environment* is the topical near-miss
  and is not the same chapter — it stops at ecosystems, the ozone layer and
  waste.
- **Maths 10 *Constructions*.** The chapter is gone; `jemh1` now runs
  … 10 Circles, 11 Areas Related to Circles, 12 Surface Areas and Volumes,
  13 Statistics, 14 Probability.

### Two Class 10 units that straddle two chapters

`jemh1` splits what the Exemplar treats as one unit. Rather than throw either
unit away, the map carries an `exceptions` block naming the question numbers that
belong to the other chapter — a break read off the exercise, not inferred question
by question:

- **Maths 8** — EXERCISE 8.1 runs fifteen questions. Q1–Q14 are trigonometric
  ratios and identities (ch8 *Introduction to Trigonometry*); Q15 is a pole and
  its shadow (ch9 *Some Applications of Trigonometry*).
- **Maths 13** — EXERCISE 13.1 runs twenty-six. Q1–Q11 are grouped data, class
  marks, mean, median and ogives (ch13 *Statistics*); Q12 is *"If an event cannot
  occur, then its probability is"* and everything from there is probability
  (ch14).

An exception can only mis-route a question if the numbering itself is wrong, and
the extractor already refuses a unit whose printed numbers do not match their
positions and the published answer key's 1..N.

## Where a mapped chapter still teaches something different

`high` means the current chapter's sections cover the unit, in recognisably the
same order. It does not mean every question in the unit is in syllabus. The
`caveat` field records each place where a correctly-filed question is asking
about something the chapter no longer contains — a teacher should read these
before setting a quiz from them.

**The big one — Class 10 Science 9 → `jesc1` ch8.** The chapter is *Heredity*,
and *Evolution* was removed: natural selection, speciation, fossils as evidence,
homologous and analogous organs, human evolution. `Darwin`, `speciation`,
`natural selection` and `vestigial` all get zero hits across `jesc1`. The
Exemplar unit is roughly half evolution, and those questions are filed under a
chapter that does not answer them. This is the Class 10 counterpart of the Class
9 mole note below, and much larger; it is why the row is `medium`.

Class 10 Maths keeps its chapters but not all of their sections. Every one of
these is a documented caveat on an otherwise `high` row:

| Unit → chapter | Cut by rationalisation, still tested by the Exemplar |
|---|---|
| 1 → ch1 Real Numbers | Euclid's division algorithm; the terminating-decimal criterion. Both still promised by the chapter's own introduction, delivered by no section. |
| 2 → ch2 Polynomials | The division algorithm for polynomials — likewise promised in the introduction, gone from the body. |
| 3 → ch3 Pair of Linear Equations | Cross-multiplication; equations reducible to a linear pair. |
| 4 → ch4 Quadratic Equations | Solving by completing the square. |
| 6 → ch6 Triangles | Areas of similar triangles; the Pythagoras theorem and its converse — the introduction still offers "a simple proof of Pythagoras Theorem", and there is no such section. |
| 7 → ch7 Coordinate Geometry | Area of a triangle from the coordinates of its vertices. |
| 11 → ch11 Areas Related to Circles | Circumference and area of a circle; areas of combinations of plane figures. The chapter is now one section. |
| 12 → ch12 Surface Areas and Volumes | The frustum of a cone; conversion of a solid from one shape to another. |

And the three Class 9 `medium` rows, for completeness:

- Science 14 → ch13: the Exemplar also carries soil formation and erosion, which
  the NCF chapter treats far more lightly.
- Maths 4 → ch2: the NCF chapter comes at this through linear polynomials and
  their graphs, not through `ax + by + c = 0` formalism.
- Maths 9 → ch6: the Exemplar states formal theorems about figures on the same
  base and between the same parallels; the NCF chapter gets the same facts by
  dissection rather than proof.

One Class 9 `high` row carries a caveat too: Science 3 → `iesc1` ch9 is the right
chapter by topic, but the mole concept and Avogadro's number are in the Exemplar
unit and not in the NCF chapter.

## What a human could still recover

Two gaps are recoverable by someone willing to read the questions; the extractor
will not do it, because doing it automatically means guessing about each question
rather than knowing something about the book:

- Class 9 Maths 14 — the probability tail of Exercise 14.1 (Q28–Q30) into
  `iemh1` ch7. The `exceptions` mechanism added for Class 10 would express it,
  but the Class 9 rows are deliberately left as they were.
- Class 9 Maths 2 — the identity and factorisation questions of Exercise 2.1
  into `iemh1` ch4.
