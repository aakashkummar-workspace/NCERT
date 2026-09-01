# `data/questions.socialscience9.json` — authoring notes

A draft Class 9 Social Science question bank for `iest1`
(*Understanding Society: India and Beyond, Part 1*), 148 questions across all 9 chapters.
**Not yet signed off by a teacher.** This file records how each chapter was grounded, what
misconception each distractor set targets, and every point I am unsure about.

## Why this was authored rather than extracted

CBSE runs no Class 9 board exam, so there are no Class 9 papers and no marking schemes.
NCERT's Exemplar Problems series covers only Science and Mathematics. Social Science is
therefore the one Class 9 subject with no official question source at all — nothing to
extract, so everything here is written from the textbook.

## How the chapters were read

The nine chapter PDFs in `public/ncert/iest1/` were extracted with
`pdfjs-dist/legacy/build/pdf.mjs` (the pattern in `scripts/extract-titles.ts`, with the same
cMap and standard-font options) and read end to end before any question was written. The
manifest's chapter titles for this book turned out to be accurate and descriptive, unlike the
oblique NCF titles in other Class 9 books — but they were still verified against the text.

The `origin` field on every row names the chapter, the section heading and the printed page,
so a reviewer can find the source in seconds. Page numbers are the **printed** page numbers
in the PDF (the number in the running footer), not PDF sheet numbers.

## Coverage and weighting

`data/syllabus.json` gives Class 9 Social Science 20 marks each to History, Geography,
Political Science and Economics, and records that no manifest book matches the four CBSE
titles — `iest1` is a single NCF volume covering all four. Its chapters map cleanly:

| Ch | Title | Discipline | Pages | Questions |
|----|-------|-----------|-------|-----------|
| 1 | Understanding Social Science | all four (introduction) | 12 | 12 |
| 2 | Shaping of the Earth's Surface | Geography | 26 | 18 |
| 3 | Atmosphere and Climate | Geography | 22 | 17 |
| 4 | Early Humans and Beginning of Civilisation | History | 34 | 19 |
| 5 | State and Society up to 1000 CE | History | 42 | 20 |
| 6 | Democracy | Political Science | 24 | 16 |
| 7 | Elections | Political Science | 22 | 16 |
| 8 | Building Blocks in Economics | Economics | 12 | 14 |
| 9 | The Price Puzzle | Economics | 26 | 16 |

Per discipline: Geography 35, History 39, Political Science 32, Economics 30, plus 12
introductory — close to the 20/20/20/20 weighting. Chapter 1 is a short, definitional
chapter with little that can be asked without ambiguity, so it is deliberately the thinnest.

Difficulty: 21 easy, 101 medium, 26 hard. All questions carry 1 mark, which is what CBSE
allots for an MCQ or an assertion-reason item; nothing here is a long-answer form.

### Sections each chapter was grounded in

- **Ch 1** — the definition on p.1; 'Understanding Society through Time and Traditions'
  (Panchamahabhutas, vasudhaiva kutumbakam, Arthashastra); 'Social Science as a Study of
  Disciplines'; the four discipline sections; the source-type margin notes on pp.6–8.
- **Ch 2** — 'Plate Tectonics' (pp.13–17: layers, convection, the three boundary types, Ring
  of Fire); 'Weathering'/'Erosion' (pp.19–21); 'Agents of Gradation' (pp.21–22); the landform
  sections for running water, waves, glaciers, wind and underground water (pp.22–32);
  'Landforms and Disasters' (pp.33–36).
- **Ch 3** — 'Composition of the Atmosphere' (Fig. 3.2); 'Structure of the Atmosphere'
  (all five layers, pp.41–43); 'Elements of Weather and Climate' (pp.43–46); 'Seasons in
  India' (p.47); 'Monsoon' (pp.49–52); the Punjab Floods 2025 case study (pp.54–56).
- **Ch 4** — the opening on scripts (p.61); 'Why Should We Study Early Human History?' and
  'Who Were Our Human Ancestors?' (pp.63–66); the Palaeolithic/Mesolithic/Neolithic sections
  (pp.68–73); 'Sindhu–Sarasvati Civilisation' (pp.74–76); 'Bronze Age Civilisations Outside
  India' — Mesopotamia, Egypt, China (pp.77–92).
- **Ch 5** — 'The Four Vedas' (p.99); 'Political Institutions in the Vedic Period' and the
  assemblies (pp.100–101); 'Early Kingdoms and Republics' (pp.103–106); 'Council of
  Ministers' and the Saptanga panel (pp.108–109); 'How Were Empires Administered?'
  (pp.111–115); 'Varna and Jati' and 'Family and Society' (pp.118–122); 'Religious Life and
  the Emergence of Bhakti' (p.124); 'Economy' — land revenue, irrigation, trade, guilds
  (pp.128–133).
- **Ch 6** — the opening on the Constitution (p.137); 'Tracing Democratic Traditions'
  (pp.138–140); the six 'Principles of Democracy' sections (pp.140–143); Fig. 6.4 and the
  country comparison table (pp.146–148); 'Democracy in Practice' including PESA and ADCs
  (pp.149–152); 'Women and the Right to Vote' and the reservation box (p.153); 'Emergency'
  (pp.155–156).
- **Ch 7** — 'Why do Elections Matter?' (p.161); 'The Electoral System' and the FPTP/majority/PR
  comparison (pp.163–165); 'The Laws' (p.165); 'Delimitation Commission' (p.166); the ECI
  functions (pp.166–171) and Fig. 7.6's app ecosystem; 'Political Parties', defection and the
  recognition criteria (pp.172–176).
- **Ch 8** — the needs/wants opening (p.183); 'Choices and Limited Resources' and the PPC
  (pp.184–185); 'What does Economics Deal with?' and the Economic Survey box (pp.186–187);
  'Key Questions in Economics' (pp.188–190); the three economic systems (pp.191–193).
- **Ch 9** — 'Demand' and the demand schedule/curve (pp.196–198); 'Other Determinants of
  Demand' (pp.198–200); 'Supply' and its determinants (pp.200–202); 'Market Equilibrium'
  (pp.203–205); 'Role of Government in the Economy' — regulation, public goods, limitations
  (pp.206–208).

## Two structural decisions

**Answer positions are spread across all four options.** `src/components/QuizSubjectView.tsx`
shuffles the *questions* in a run but never the *options*, so a bank whose answer is always
first would teach students to pick A. After authoring, the options of every plain MCQ were
rotated deterministically so the correct answer lands at index 0/1/2/3 in a fixed cycle
(final distribution: 30 / 37 / 46 / 35). Assertion-reason rows were left in their
conventional A–D order, since that order is part of the question form; instead their
*answers* were varied — three are "both true and the reason explains", one is "both true but
unrelated", two are "assertion true, reason false".

**Every row has an explanation.** This is the main thing this bank offers over the 182
Exemplar rows already in the repo, which ship a bare answer letter. Each explanation says why
the right option is right and, where it earns its place, why the tempting wrong one is wrong.

## Distractors: which misconception each set targets

A representative sample, not the full list.

- `iest1-02-003` (what moves the plates) — the three wrong options are the Earth's rotation,
  the Moon's gravity and ocean currents. These are the everyday forces students already
  associate with large-scale motion; the point is that plate movement is driven by heat from
  *inside* the Earth, not by anything at or above the surface.
- `iest1-02-008` (weathering vs erosion) — "weathering is caused by water, erosion by wind"
  targets the belief that the two words name different *agents*; "weathering is slow, erosion
  is sudden" targets the belief that they differ in *speed*. Both miss the actual distinction,
  which is whether the broken material moves.
- `iest1-03-007` (which layer warms with height) — the distractors are the troposphere and
  mesosphere, the two layers where temperature genuinely *falls*. The misconception is
  over-generalising "it gets colder as you go up" to the whole atmosphere; the chapter's own
  "Don't Miss Out" box exists to stop exactly that.
- `iest1-03-010` (a westerly) — "blows towards the west" is the single most common error about
  wind names, and it reverses every wind arrow on a map.
- `iest1-03-014` (why the SW monsoon blows inland) — the mirrored option, "the ocean heats
  faster than the land", targets students who have memorised that pressure difference drives
  the monsoon but not which side heats first.
- `iest1-04-016` (order of the Mesopotamian powers) — Babylonia is placed first in two
  distractors, because Hammurabi is the name students know best and fame reads as antiquity.
- `iest1-04-010` (civilisation–river pairs) — every distractor keeps the four right rivers but
  attaches them to the wrong civilisations, so recognition of the names is not enough.
- `iest1-05-007` (Saptanga) — "the guilds (shrenis)" is the distractor because guilds are
  genuinely important in the same chapter's economy section; a student who is pattern-matching
  on "things that mattered to the state" will take it.
- `iest1-05-012` (Chalukya land grants) — "Brahmadeya villages" is the Pallava term for the
  same practice, described two paragraphs earlier. This tests whether the student attached the
  term to the right dynasty rather than to the idea.
- `iest1-06-012` (women's reservation in Panchayats) — "exactly 50 per cent" is the trap: 21
  states and 2 UTs do provide 50 per cent, but that is a state provision, not the
  constitutional floor of one-third under Article 243(d).
- `iest1-07-004` (FPTP) — "more than 50 per cent of the votes polled" is the majority-system
  rule, presented in the same table. Students routinely assume a winner must cross half.
- `iest1-08-004` (factors of production) — "opportunity cost" is offered alongside three real
  factors, targeting the habit of treating every bolded term in a chapter as belonging to the
  same list.
- `iest1-09-005` / `iest1-09-004` (substitutes and complements) — the substitute/complement
  pairs are drawn from the chapter's own end-of-chapter sorting exercise, so a student who did
  that exercise will recognise them and one who did not will guess.
- `iest1-09-012` (price below equilibrium) — "excess supply, that is, a surplus" is the exact
  inversion; shortage/surplus is the pairing students most often flip.

## Things a teacher must verify

1. **Chapter 3, the Punjab Floods 2025 case study** (`iest1-03-016`). This is a very recent
   case study and I have taken the causes purely from the printed text. Confirm the book's own
   natural/human-made split is what you want assessed.
2. **Chapter 7, all ECI facts** (`iest1-07-009` through `-016`). Election law and ECI practice
   change: the home-voting age threshold, the 40 per cent benchmark-disability criterion, the
   app list in Fig. 7.6 and the national-party recognition criteria are all as printed in this
   edition. Check them against the current edition before use.
3. **Chapter 6, the 50 per cent women's reservation counts** — "21 States and 2 Union
   Territories" and "17 States and 1 UT (as of 2023)" are printed figures I did not build a
   question on for that reason. If you add one, date it.
4. **Transliteration.** The textbook uses full diacritics (Ṛigveda, Kauṭilya, Śhūdra,
   Sindhu-Sarasvatī). I have written plain ASCII throughout (Rigveda, Kautilya, Shudra,
   Sindhu-Sarasvati) so the strings render identically on every device and so that a student
   typing a search does not have to match a diacritic. If the app should show the book's own
   spelling, this is a global find-and-replace, not a rewrite.
5. **Numbers quoted from the book** — 1,028 Rigvedic hymns; "2 years, 11 months and 18 days";
   96.8 crore voters (2024); one-sixth land tax; six bicameral states. All are as printed.
   Where the book itself hedges ("about", "generally"), the question keeps the hedge.

## Questions I am not fully confident about

- **`iest1-04-005` (microliths → Mesolithic).** The chapter assigns microlithic tools to the
  Mesolithic in Fig. 4.7 and in the Mesolithic section, but the Palaeolithic section also
  describes Upper Palaeolithic "parallel-sided blade and microblade tools", and the site map's
  legend reads "Palaeolithic Sites (Lower, Middle, and Upper + Microlithic)". I chose "Lower
  Palaeolithic" as the nearest distractor precisely because it is unambiguously wrong
  (handaxes and cleavers), and avoided offering "Upper Palaeolithic". A teacher who considers
  microblades and microliths the same thing may want this question dropped.
- **`iest1-04-016` (order of the four Mesopotamian powers).** The prose gives 2334 BCE for the
  Akkadians, 2154 BCE for the Assyrians and 1900 BCE for the Babylonians, and Fig. 4.22's
  timeline agrees. But the same figure shows the four overlapping rather than succeeding one
  another cleanly, so "the order the chapter presents them" is the honest framing rather than
  "the order in which they existed". Verify the framing reads clearly to you.
- **`iest1-04-018` (name 'China' from the Qin).** The book itself hedges — "probably comes
  from" — and the question keeps that word. If you want only unhedged facts assessed, drop it.
- **`iest1-05-001` (1,028 hymns).** The figure is printed in the Four Vedas panel. It is a
  bare-recall number and arguably not worth a mark; keep it only if you want that level of
  detail examined.
- **`iest1-05-009` (Pushyagupta and Sudarshana Lake).** Correct per the Irrigation section on
  p.129, but the fact sits 20 pages away from the Junagadh box on p.110 that introduces the
  same inscription. Students who read the chapter in one pass may not connect the two. Marked
  hard for that reason.
- **`iest1-06-013` (how Indian women got the vote).** The chapter's framing — no prolonged
  separate struggle in India, unlike Britain (1928) and the USA (1920) — is a comparative
  historical claim rather than a date, and the option wording had to carry that nuance. Read
  the option text and confirm it is a claim you want assessed as a single right answer.
- **`iest1-08-011` (why most economies are mixed).** This is a "why" question about a claim
  the chapter asserts rather than argues at length ("Almost all economies are mixed"). The
  answer is drawn from the definition of a mixed economy in the margin note. Defensible, but
  it is the most interpretive question in the Economics chapters.
- **`iest1-01-011` (sustainable growth).** The definition appears in the Economics discipline
  section of Chapter 1, not in the Economics chapters themselves. It is a Chapter 1 question
  by provenance; a teacher assessing chapter-wise may expect it under Economics instead.
- **Chapter 1 generally.** It is an orientation chapter with few hard facts. Several of its
  twelve questions test definitions and source-type vocabulary rather than content. If your
  scheme of work does not assess Chapter 1 at all, this whole block can be removed without
  affecting the other eight chapters.

## What was deliberately not asked

- The Varahamihira/Brihatsamhita boxes in Chapters 2 and 3, the Zabo system of Nagaland, the
  Baratang mud volcano, and similar "Don't Miss Out" enrichment items. They are memorable but
  peripheral, and I could not tell whether they are examinable in your scheme.
- Anything requiring a map, a graph or a diagram to answer — the quiz UI shows text options
  only, so Fig. 3.14's climate graphs, Table 3.3's station data and Fig. 9.8's equilibrium
  diagram cannot be assessed here.
- The chapters' own "Let's Explore" and "Think About It" prompts, which are open-ended by
  design and have no single right answer.

## Validation

Validated with the real `scripts/check-questions.mjs` against a scratch merge of
`data/questions.json` + this file (`data/questions.json` was not modified):

```
data/questions.json: 163 rows, 163 usable
Class 9 — 148 questions
  Social Science    148 questions  9 chapters
Class 10 — 15 questions
All questions validate.
```

Zero errors and zero warnings — no duplicate ids, no duplicate stems, no unresolvable answers,
no row missing an explanation, and no row whose `class` or `subject` disagrees with the
manifest. Every `bookCode`/`chapter` pair is `iest1` 1–9, which the manifest has.

## To publish

`data/questions.socialscience9.json` is not read by anything yet, so these questions reach no
student until `src/lib/quiz.ts` is taught to load them. The exemplar lane has already
established the pattern in that file — it added

```ts
import exemplarJson from "@data/questions.exemplar.json";
```

and widened the bank builder to `for (const row of [...rowsOf(questionsJson), ...rowsOf(exemplarJson)])`.
Publishing this file is the same two-line change with `@data/questions.socialscience9.json`
added to that spread. `src/lib/quiz.ts` is outside this lane's ownership, so it was not made
here. A rebuild (`npm run build`) is required either way, since the bank is baked into the
static export.

The `package.json` line this bank needs:

```json
"quiz:check:ss9": "node scripts/check-questions.mjs data/questions.socialscience9.json"
```

That requires `scripts/check-questions.mjs` to accept an optional path argument — it currently
hard-codes `const QUESTIONS = "data/questions.json"`, which is also why `npm run quiz:check`
does not today validate the exemplar file either. Both `package.json` and `scripts/**` are
outside this lane's ownership. Until that lands, validate by merging into a scratch copy:

```bash
node -e 'const fs=require("fs");const b=require("./data/questions.json"),m=require("./data/questions.socialscience9.json");fs.mkdirSync("/tmp/qc/data",{recursive:true});fs.copyFileSync("data/manifest.json","/tmp/qc/data/manifest.json");fs.writeFileSync("/tmp/qc/data/questions.json",JSON.stringify({questions:[...b.questions,...m.questions]}))'
cd /tmp/qc && node "$OLDPWD/scripts/check-questions.mjs"
```
