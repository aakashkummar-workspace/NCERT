Synthetic sample run for scripts/spike-grade.mjs.

  node scripts/spike-grade.mjs --show-prompt    what the model is told, per rubric
  node scripts/spike-grade.mjs --dry-run        what a real run would cost

answers.json points at real rubrics in data/rubrics.json, chosen to cover what
the grader has to handle: a plain ordered Maths chain with partial-credit rules,
a Maths answer carrying a diagram step (never auto-graded, so it comes back as
unmarkedMarks), an unordered Science recall answer, and an unreviewed Social
Science "any 5, at least 2 positive and 2 negative" choose group.

The PNGs are blank pages at real phone-photo dimensions. They exist so the dry
run can read true image sizes out of the file headers and price a run honestly,
offline, with no SDK and no API key. They are NOT handwriting, and sending them
to the model would produce nothing useful.

To produce a real verdict, replace answers.json and these images with
photographed answers, and supply a teacher-marked truth.json for
scripts/spike-score.mjs. The rubrics themselves are already real.
