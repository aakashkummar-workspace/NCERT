# `data/rubrics.json` — the marking rubric contract

A rubric says how one exam question is marked: what earns each mark, which
wording counts, which unit is mandatory, and what a partly-right answer is
worth. The grader reads a photograph of a handwritten answer and paints the
student's own words green, orange or red against **this** file. Run
`npm run rubric:check` before committing.

This is the sibling of [`questions.schema.md`](./questions.schema.md) and it
inherits both of that file's rules:

1. **A rubric that does not validate is not used.** A malformed question is
   dropped; a malformed rubric is worse, because it would not go missing — it
   would silently mark a correct answer wrong, in red, in the student's own
   handwriting. Better to leave the page ungraded than to grade it from a
   rubric nobody has checked.
2. **Class and subject come from `bookCode`, not from the rubric.** The
   manifest already knows `jesc1` is Class 10 Science. `class` and `subject`
   may be written down, but they are advisory: the book decides. A rubric
   mis-filed by class would grade an answer against another class's scheme,
   and nothing in the UI could reveal it.

   Where `questions.json` only *warns* about the disagreement — a mis-tagged
   question is still a usable question once the book has overruled it — a
   rubric that names the wrong class is a **rejection**. It means the author
   was reading the wrong book, and the keywords underneath may be off another
   syllabus entirely.

Like `questions.json`, and unlike `manifest.json`, **this file is authored,
not generated.** CBSE's marking schemes are prose written for a human
examiner — "any two of the following", "or any other relevant point", "1½".
Turning that into steps a machine can apply is a judgment, so every rubric
carries the provenance of the scheme it came from and, where the conversion
required a decision, a `needsReview` flag naming it.

## File

```jsonc
{
  "generatedAt": "2026-08-31",
  "source": "where these came from",
  "rubrics": [ /* … */ ]
}
```

A bare top-level array is also accepted, as is `{ "items": [...] }`. Anything
else is a hard error.

## One rubric

```jsonc
{
  "id": "class10-science-2025-26-q10",   // required, unique across the file
  "paper": "class10-science-2025-26",    // slug in data/papers.json
  "session": "2025-26",
  "questionNo": 10,                      // as printed on the paper
  "variant": "A",                        // omit unless the paper offers A / OR B
  "type": "vsa",                         // mcq | assertion-reason | vsa | sa | la | case-study
  "maxMarks": 2,
  "bookCode": "jesc1",                   // NCERT book code from data/manifest.json
  "chapter": 5,                          // must exist in that book
  "class": 10,                           // advisory — the book decides
  "subject": "Science",                  // advisory — the book decides
  "prompt": "…",                         // the stem, abbreviated; for the reviewer, not the grader
  "ordering": "unordered",               // ordered | unordered — the default for every step
  "acceptEquivalentWording": true,
  "scheme": { "file": "class10-science-2025-26-ms.pdf", "page": 1 },
  "steps": [ /* … */ ],
  "needsReview": true,
  "reviewNotes": ["the scheme prints one total, not a per-step split"]
}
```

`bookCode` + `chapter` are the load-bearing pair, exactly as in
`questions.json`: they are what ties a graded answer back to a chapter, and so
into `/revise` and `/progress`. A rubric with no recognisable `bookCode` is
rejected outright — unlike a quiz question, a rubric with no chapter has
nowhere to send the result.

`paper`, `questionNo` and `scheme` are the provenance. They are what a teacher
follows back to the PDF on disk to check the conversion, and what lets a
reviewer find every rubric derived from a scheme when CBSE reissues it.

`variant` exists because CBSE questions carry internal choice — "Students to
attempt either option A or B". Each option is a **separate rubric with the
same `questionNo` and a different `variant`**, and each one must sum to
`maxMarks` on its own. A student attempts one; the grader picks the variant
whose steps the answer actually matches.

`acceptEquivalentWording` records CBSE's own "or equivalent wording" licence.
When true the grader may accept a semantic match, not only a listed phrase.
Set it false where the answer *is* a specific term or a number — "Anthracite",
"25 km/hr" — and a near-miss should not be green.

## Steps

`steps` is an ordered list. Every entry has a `kind`; there are three.

### `kind: "step"` — one award, one description

```jsonc
{
  "id": "s1",
  "kind": "step",                     // may be omitted; this is the default
  "marks": 1,                         // a positive multiple of 0.5
  "awardFor": "names the correct combined resistance, 4 Ω",
  "keywords": [                       // each entry is one concept …
    { "any": ["4 ohm", "4 Ω", "4Ω"] } // … and any listed phrasing satisfies it
  ],
  "match": "all",                     // all | any — must every concept appear? default all
  "unit": { "required": true, "accepted": ["Ω", "ohm", "ohms"] },
  "ordered": true,                    // must follow the steps before it; defaults to `ordering`
  "partial": [
    { "when": "unit-missing", "award": 0.5, "note": "value right, unit absent" }
  ]
}
```

`keywords` is a list of **concepts**, not a list of strings. Each concept is a
set of accepted phrasings, any one of which satisfies it — that is where "or
equivalent wording" lives, per concept, rather than as a blanket. With the
default `match: "all"` a step needs every concept; `match: "any"` needs one,
which is the right setting for a free-recall step where the scheme itself only
wants the idea.

### `kind: "choose"` — CBSE's "any two of the following"

```jsonc
{
  "id": "g1",
  "kind": "choose",
  "chooseAtLeast": 2,
  "marksEach": 1,                     // so this group is worth 2
  "awardFor": "any two ways plants get rid of waste",
  "requireTags": { "climate": 1, "economic": 1 },   // optional
  "options": [
    { "id": "o1", "awardFor": "oxygen leaves through stomata",
      "keywords": [ { "any": ["stomata", "stomatal pore"] }, { "any": ["oxygen", "O2"] } ],
      "tags": ["climate"] }
    /* … at least `chooseAtLeast` of them … */
  ]
}
```

A `choose` group is worth `chooseAtLeast × marksEach`, and that is the number
that counts towards `maxMarks`. Listing more options than are needed is the
point: the scheme lists five, the student writes two, and the two that match
are the two that score. Options are always order-free.

`requireTags` is the awkward second half of the convention. The Social Science
scheme does not stop at "any 2" — Q16 wants "at least one related to climate
and one economic", and Q38B wants "ANY 5 points, at least 2 positive and 2
negative". Each entry is a tag and the minimum number of *scoring* options
that must carry it. A group that meets the count but not the tags is not full
marks.

### `kind: "diagram"` — a mark for a drawing

```jsonc
{
  "id": "s1",
  "kind": "diagram",
  "marks": 1,
  "awardFor": "correct labelled figure of the chimney and the tower",
  "labels": ["chimney", "tower", "60°", "30°", "40 m"],
  "autoGradable": false               // forced; a diagram step may not claim true
}
```

CBSE hands out marks for figures — "1 (for correct figure)" appears four times
in the Maths scheme alone — and a keyword matcher run over a photograph cannot
honestly say whether a triangle was drawn correctly. So a diagram step is
never graded automatically. `labels` is there for the human reviewing the
page, not for the matcher.

## Green, orange, red — and the fourth case

Each step resolves to exactly one outcome, and the colour follows the outcome.

| Outcome | Awarded | Colour | When |
|---|---|---|---|
| hit | `marks` | **green** | every required concept present, unit present if required, ordering respected |
| partial | a `partial` rule's `award` | **orange** | the step is there but flawed — see below |
| miss | 0 | **red** | the step is not there, and the span written in its place earns nothing |
| unmarked | — | none | `autoGradable: false` — a diagram, or a step nobody has agreed how to check |

Text the student wrote that matches no step and no option is red. That is the
filler case, and it is grader behaviour, not something a rubric declares.

**Nothing is ever painted red on a rubric flagged `needsReview`.** An unchecked
conversion may accuse a student of writing nothing of value, which is the one
mistake with no recovery. Such a rubric may award green and orange; a miss is
left unmarked until a teacher signs the rubric off.

`partial` is what makes orange possible, and every entry names its reason from
a closed list:

| `when` | Means |
|---|---|
| `unit-missing` | the value is right, no unit was written |
| `unit-wrong` | a unit was written and it is the wrong one |
| `order-broken` | the step is present but out of sequence on an `ordered` step |
| `keywords-partial` | some of the concepts appeared, not all |
| `arithmetic-slip` | the method is right, the number that comes out is not |
| `formula-only` | the formula is quoted and never substituted into |
| `sign-error` | magnitude right, sign wrong |
| `unrounded` | right to more or fewer figures than the scheme asks |

`award` must be a positive multiple of 0.5 and strictly less than the step's
`marks`. CBSE does not award quarter marks, so **a ½-mark step cannot be
partially credited** — it is green or it is red. A `partial` on a 0.5-mark
step is an error, not a rounding problem to solve at grading time.

## Order dependence

`ordering` on the rubric sets the default; `ordered` on a step overrides it.

Maths working is ordered: the discriminant is computed before the roots are
read off it, and an answer that states the roots first has not shown the
method the scheme is paying for. Science and Social Science recall is not: the
three ways a nation-state expressed itself are worth the same in any sequence.

`ordered` is deliberately not the same as "appears later in the list".
Everything in `steps` has a position; `ordered` says whether that position is
*load-bearing*. A five-mark Maths answer typically has an ordered spine with
an unordered figure mark hanging off it, which is why the flag is per step.

## Half marks

`marks`, `marksEach` and `award` are all positive multiples of 0.5, because
that is the finest grain CBSE uses. Sums are compared in half-mark units
rather than in floating point — `1.5 + 1.5 + 1.5 + 0.5` must equal 5 exactly,
and it does not if you add doubles and hope.

The steps of a rubric must sum to `maxMarks`. Not to less, not to more. A
rubric that does not is the single most damaging error in this file, because
it grades every attempt at that question out of the wrong denominator, and it
is the first thing `rubric:check` looks at.

## Tolerated spellings

Only for the fields that tie a rubric to the manifest and to the paper, and
only because `questions.json` tolerates them too:

| Canonical | Also accepted |
|---|---|
| `bookCode` | `book`, `code` |
| `chapter` | `chapterNo`, `chapterNumber`, `ch` |
| `questionNo` | `qNo`, `number` |
| `maxMarks` | `marks`, `totalMarks` |
| `paper` | `paperSlug`, `slug` |

Everything else must be spelled as documented. A rubric is read by a teacher
before it is read by a machine, and a field that can be spelled four ways is
one a reviewer cannot scan.

## Rejected, with the reason `rubric:check` gives

- duplicate `id`
- steps that do not sum to `maxMarks`
- `bookCode` absent, or not in the manifest
- `chapter` absent, or outside that book's chapter range
- a `class` or `subject` the manifest contradicts
- `marks`, `marksEach` or `award` that is not a positive multiple of 0.5
- a step with no `keywords`, or a `keywords` concept with an empty `any`
- a `choose` group with fewer `options` than `chooseAtLeast`
- a `requireTags` demand no set of scoring options could satisfy
- `partial.award` not strictly between 0 and the step's `marks`
- `partial.when` outside the closed list
- a `diagram` step claiming `autoGradable: true`
- `paper` not in `data/papers.json`, or `questionNo` outside that paper's range
- two rubrics for the same `paper` + `questionNo` + `variant`

Warned, but not rejected — the rubric is still usable:

- `type` disagreeing with the section `data/papers.json` puts that question in
- `needsReview` with no `reviewNotes` saying what needs reviewing
- a rubric with no `prompt`, which leaves a reviewer nothing to check against

## Adding rubrics incrementally

Append to `rubrics`; nothing is positional. Nothing here is baked into the
static export yet — no `src/` module reads this file — so `rubric:check` is
currently the only consumer, and it is the whole gate.
