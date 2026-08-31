/**
 * Validate data/prerequisites.json against the manifest, and print the bridge
 * graph the app will actually be able to offer.
 *
 *   npm run bridge:check
 *
 * The sibling of check-questions.mjs and check-rubrics.mjs, and it exists for
 * the same reason: src/lib/bridge.ts silently drops anything it cannot trust,
 * which is right for a student and useless for whoever is authoring the file.
 * Every rejection rule below mirrors one in that module; when one changes,
 * both change.
 *
 * Two checks here are not about shape at all, and they are the ones that
 * matter.
 *
 *   - **A prerequisite must be earlier.** Lower class, or an earlier chapter in
 *     the same book. Same class across two books is rejected outright, because
 *     nothing in the corpus orders `jemh1` against `jesc1`, so such a link is a
 *     claim the data cannot support.
 *   - **No cycles.** A student bounced A -> B -> A has been given a treadmill
 *     instead of help, and would never work out why. The ordering rule above
 *     already makes that impossible; this runs the search anyway, because the
 *     day the ordering rule is loosened is the day it stops being impossible.
 *
 * Exit code 1 on any error. Warnings (a gap-only bridge, a questionId the bank
 * has not caught up with, an over-long recap line) do not fail the run: the
 * bridge is still correct, it is just worth someone's attention.
 */
import { readFile } from "node:fs/promises";

const PREREQS = "data/prerequisites.json";
const MANIFEST = "data/manifest.json";
const QUESTIONS = "data/questions.json";

/** The promise the UI makes. Mirrors MAX_BRIDGE_MINUTES in src/lib/bridge.ts. */
const MAX_BRIDGE_MINUTES = 3;
const MAX_RECAP_CHARS = 200;
const GRADES = new Set([6, 7, 8]);

const errors = [];
const warnings = [];

function err(id, msg) {
  errors.push(`${id}: ${msg}`);
}
function warn(id, msg) {
  warnings.push(`${id}: ${msg}`);
}

const asString = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const asNumber = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

function rowsOf(file) {
  if (Array.isArray(file)) return file;
  for (const key of ["bridges", "items"]) {
    if (Array.isArray(file?.[key])) return file[key];
  }
  return null;
}

/** Mirrors isEarlier() in src/lib/bridge.ts. */
function isEarlier(target, prereq) {
  if (prereq.class < target.class) return true;
  if (prereq.class > target.class) return false;
  return prereq.code === target.code && prereq.chapter < target.chapter;
}

function why(target, prereq) {
  if (prereq.class > target.class) {
    return `is Class ${prereq.class}, which is after Class ${target.class}`;
  }
  if (prereq.code !== target.code) {
    return `is ${prereq.code}, a different Class ${prereq.class} book; nothing in the corpus says which of two books in a class comes first`;
  }
  if (prereq.chapter === target.chapter) return "is the chapter itself";
  return `is chapter ${prereq.chapter} of ${prereq.code}, which comes after chapter ${target.chapter}`;
}

const main = async () => {
  const raw = JSON.parse(await readFile(PREREQS, "utf8"));
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));

  let questionIds = new Set();
  try {
    const q = JSON.parse(await readFile(QUESTIONS, "utf8"));
    const list = Array.isArray(q) ? q : (q.questions ?? q.items ?? []);
    questionIds = new Set(list.map((r) => r?.id).filter(Boolean));
  } catch {
    // The bank is optional here; questionIds checks simply downgrade to silence.
  }

  const books = new Map(manifest.books.map((b) => [b.code, b]));

  const rows = rowsOf(raw);
  if (rows === null) {
    console.error(
      `${PREREQS}: expected an array, or an object with a "bridges" array. See data/prerequisites.schema.md.`,
    );
    process.exit(1);
  }

  const seenIds = new Set();
  const seenTargets = new Map();
  const accepted = [];
  /** `code:chapter` -> Set of `code:chapter`, for the cycle search. */
  const graph = new Map();

  rows.forEach((row, i) => {
    const id = asString(row.id) ?? `#${i} (no id)`;

    if (!asString(row.id)) err(id, "has no id");
    else if (seenIds.has(id)) err(id, "duplicate id");
    else seenIds.add(id);

    const code = asString(row.bookCode);
    const book = code ? books.get(code) : undefined;
    if (!code) {
      err(id, "names no bookCode, so there is no chapter to bridge to");
      return;
    }
    if (!book) {
      err(id, `bookCode "${code}" is not in ${MANIFEST}`);
      return;
    }

    const chapter = asNumber(row.chapter);
    if (chapter === undefined) {
      err(id, `names no chapter in ${code}`);
      return;
    }
    if (!book.chapters.some((c) => c.n === chapter)) {
      err(id, `chapter ${chapter} does not exist in ${code} (it has 1-${book.chapters.length})`);
      return;
    }

    const concept = asString(row.concept);
    const targetKey = `${code}:${chapter}:${concept ?? ""}`;
    if (seenTargets.has(targetKey)) {
      err(
        id,
        `targets ${code} chapter ${chapter}${concept ? ` / "${concept}"` : ""}, which ${seenTargets.get(targetKey)} already covers`,
      );
    } else {
      seenTargets.set(targetKey, id);
    }

    const declaredClass = asNumber(row.class);
    if (declaredClass !== undefined && declaredClass !== book.class) {
      warn(id, `says class ${declaredClass} but ${code} is Class ${book.class}; the book wins`);
    }

    for (const qid of Array.isArray(row.questionIds) ? row.questionIds : []) {
      if (questionIds.size && !questionIds.has(qid)) {
        warn(id, `names question "${qid}", which is not in ${QUESTIONS}`);
      }
    }

    const prerequisites = Array.isArray(row.prerequisites) ? row.prerequisites : [];
    if (prerequisites.length === 0) {
      err(id, "lists no prerequisites; a bridge with nothing on the far side is not a bridge");
      return;
    }

    const target = { class: book.class, code, chapter };
    const steps = [];
    const gaps = [];
    const seenSteps = new Set();

    prerequisites.forEach((p, j) => {
      const where = `${id} prerequisite ${j + 1}`;
      const kind = asString(p?.kind) ?? "chapter";

      if (kind === "out-of-corpus") {
        const grade = asNumber(p.grade);
        const topic = asString(p.topic);
        const reason = asString(p.why);
        if (grade === undefined || !GRADES.has(grade)) {
          err(where, `is out of corpus but names grade ${JSON.stringify(p.grade)}; use 6, 7 or 8`);
        }
        if (!topic) err(where, "is out of corpus but names no topic; say what the student is missing");
        if (!reason) {
          err(
            where,
            "is out of corpus and gives no reason; an admitted gap with no explanation is just a blank",
          );
        }
        if (p.recap !== undefined || p.minutes !== undefined) {
          err(
            where,
            "is out of corpus but carries a recap or minutes; there is nothing here to open, and pretending otherwise is the wrong link this file exists to avoid",
          );
        }
        if (topic && reason) gaps.push({ grade, topic });
        return;
      }

      if (kind !== "chapter") {
        err(where, `has kind "${kind}"; expected "chapter" or "out-of-corpus"`);
        return;
      }

      const pCode = asString(p.bookCode);
      const pBook = pCode ? books.get(pCode) : undefined;
      if (!pCode) {
        err(where, "names no bookCode");
        return;
      }
      if (!pBook) {
        err(where, `bookCode "${pCode}" is not in ${MANIFEST}`);
        return;
      }
      const pChapter = asNumber(p.chapter);
      if (pChapter === undefined) {
        err(where, `names no chapter in ${pCode}`);
        return;
      }
      if (!pBook.chapters.some((c) => c.n === pChapter)) {
        err(
          where,
          `chapter ${pChapter} does not exist in ${pCode} (it has 1-${pBook.chapters.length})`,
        );
        return;
      }

      const prereq = { class: pBook.class, code: pCode, chapter: pChapter };
      if (!isEarlier(target, prereq)) {
        err(
          where,
          `${why(target, prereq)} — a prerequisite must be a lower class, or an earlier chapter of the same book`,
        );
        return;
      }

      const stepKey = `${pCode}:${pChapter}`;
      if (seenSteps.has(stepKey)) {
        err(where, `repeats ${pCode} chapter ${pChapter}, already listed in this bridge`);
        return;
      }
      seenSteps.add(stepKey);

      const reason = asString(p.why);
      if (!reason) {
        err(where, "gives no reason; a student needs one line saying what this unlocks");
      }

      const recap = Array.isArray(p.recap) ? p.recap.map(asString).filter(Boolean) : [];
      if (recap.length === 0) {
        err(where, "has no recap, so there is nothing for the student to read");
      }
      if (recap.length > 4) {
        warn(where, `has ${recap.length} recap lines; more than 4 is no longer a micro-bridge`);
      }
      for (const line of recap) {
        if (line.length > MAX_RECAP_CHARS) {
          warn(
            where,
            `has a ${line.length}-character recap line; over ${MAX_RECAP_CHARS} is too long to read standing up`,
          );
        }
      }

      const minutes = asNumber(p.minutes);
      if (minutes === undefined) {
        err(where, "states no minutes; the UI has to tell the student the cost before they agree");
      } else if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_BRIDGE_MINUTES) {
        err(where, `claims ${minutes} minutes; use a whole number from 1 to ${MAX_BRIDGE_MINUTES}`);
      }

      steps.push({ code: pCode, chapter: pChapter, minutes: minutes ?? 0, class: pBook.class });

      const from = `${code}:${chapter}`;
      const to = `${pCode}:${pChapter}`;
      const edges = graph.get(from) ?? new Set();
      edges.add(to);
      graph.set(from, edges);
    });

    const total = steps.reduce((n, s) => n + s.minutes, 0);
    if (total > MAX_BRIDGE_MINUTES) {
      err(
        id,
        `adds up to ${total} minutes; a micro-bridge is capped at ${MAX_BRIDGE_MINUTES}, and a student told "2 minutes" and given ${total} will not accept the next offer`,
      );
    }

    if (steps.length === 0 && gaps.length > 0) {
      warn(
        id,
        `has only out-of-corpus prerequisites (${gaps.map((g) => `Class ${g.grade} ${g.topic}`).join("; ")}), so it is never offered — correct, and worth keeping on record`,
      );
    }

    accepted.push({ id, code, chapter, concept, class: book.class, subject: book.subject, steps, gaps, minutes: total });
  });

  // --- cycles ------------------------------------------------------------

  const colour = new Map();
  const stack = [];
  const cycles = [];

  function visit(node) {
    colour.set(node, "grey");
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const seen = colour.get(next);
      if (seen === "grey") {
        cycles.push([...stack.slice(stack.indexOf(next)), next]);
      } else if (seen === undefined) {
        visit(next);
      }
    }
    stack.pop();
    colour.set(node, "black");
  }

  for (const node of graph.keys()) {
    if (!colour.has(node)) visit(node);
  }

  for (const cycle of cycles) {
    errors.push(
      `cycle: ${cycle.join(" -> ")} — a student sent round this loop would never get out of it`,
    );
  }

  // --- report ------------------------------------------------------------

  const offerable = accepted.filter((b) => b.steps.length > 0);
  const gapOnly = accepted.filter((b) => b.steps.length === 0);
  const links = accepted.reduce((n, b) => n + b.steps.length, 0);
  const gapCount = accepted.reduce((n, b) => n + b.gaps.length, 0);

  console.log(
    `${PREREQS}: ${rows.length} bridges, ${offerable.length} offerable, ${links} in-corpus links, ${gapCount} honest gaps\n`,
  );

  const bySubject = new Map();
  for (const b of accepted) {
    const key = `Class ${b.class} ${b.subject}`;
    const list = bySubject.get(key) ?? [];
    list.push(b);
    bySubject.set(key, list);
  }
  for (const [key, list] of [...bySubject].sort()) {
    console.log(`${key} — ${list.length} bridge(s)`);
    for (const b of [...list].sort((a, c) => a.chapter - c.chapter)) {
      const label = `ch ${b.chapter}${b.concept ? ` / ${b.concept}` : ""}`;
      const to =
        b.steps.length === 0
          ? `no in-corpus prerequisite (${b.gaps.map((g) => `Class ${g.grade} ${g.topic}`).join("; ")})`
          : `${b.steps.map((s) => `${s.code} ch ${s.chapter}`).join(" + ")}  ${b.minutes} min`;
      console.log(`  ${label.padEnd(34)} <- ${to}`);
    }
  }

  if (gapOnly.length) {
    console.log(
      `\n${gapOnly.length} bridge(s) admit a Class 6-8 gap and offer nothing. That is the intended behaviour: an honest gap beats a wrong link.`,
    );
  }

  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  if (errors.length) {
    console.log(`\n${errors.length} error(s) — these bridges will NOT be offered:`);
    for (const e of errors) console.log(`  x ${e}`);
    console.log("\nSee data/prerequisites.schema.md for the expected shape.");
    process.exit(1);
  }

  console.log("\nAll bridges validate.");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
