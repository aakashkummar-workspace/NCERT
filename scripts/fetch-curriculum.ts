/**
 * Phase 1, step 1 — mirror the CBSE curriculum PDFs.
 *
 * These are the documents that say how many marks each syllabus unit is worth.
 * They are downloaded rather than parsed from the web at build time for the
 * same reason the textbooks are: cbseacademic.nic.in is a government server
 * with no CORS headers and no API, so the only reliable copy is a local one.
 *
 * Unlike the textbook mirror these files are *not* served to the browser —
 * `data/curriculum/` is gitignored working material for `build-syllabus.ts`,
 * which extracts the weightage tables into `data/syllabus.json`.
 *
 * Safe to re-run: a file that already exists and still starts with the PDF
 * magic bytes is skipped, so an interrupted run resumes where it stopped.
 * Requests are sequential with a delay — this is a government server.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fetchWithRetry, sleep } from "./lib/ncert";

const OUT_DIR = "data/curriculum";
const BASE = "https://cbseacademic.nic.in/web_material/CurriculumMain26/Sec";

/** Roughly one request per second; CBSE throttles harder than NCERT does. */
const DELAY_MS = 1000;

/**
 * The secondary-stage curriculum documents we need, by their basename on
 * cbseacademic.nic.in. Every file covers both Class IX and Class X — CBSE
 * publishes one syllabus per subject for the whole secondary stage.
 *
 * The full list of what is available is at
 * https://cbseacademic.nic.in/curriculum_2026.html — add a basename here to
 * pull another subject in. `build-syllabus.ts` holds the matching parser
 * configuration; a file downloaded without one is simply ignored.
 *
 * The two `..._RM` documents are CBSE's "Reading Material": NCERT text for
 * topics the syllabus keeps but assesses only formatively. They carry no
 * weightage table, and are mirrored only so the set is complete.
 */
const CURRICULUM = [
  "Science_Sec_2025-26",
  "Maths_Sec_2025-26",
  "Social_Science_Sec_2025-26",
  "English_LL_2025-26",
  "Science_SecIX_2025-26_RM",
  "Maths_SecIX_2025-26RM",
];

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const [i, name] of CURRICULUM.entries()) {
    const path = `${OUT_DIR}/${name}.pdf`;
    const url = `${BASE}/${name}.pdf`;
    const prefix = `  ${String(i + 1).padStart(2)}/${CURRICULUM.length} ${name}.pdf`;

    // A previous run already got this one. Re-validate the magic bytes rather
    // than trusting the filename: a truncated or error-page download would
    // otherwise be treated as done forever.
    if (existsSync(path)) {
      const buf = await readFile(path);
      if (buf.subarray(0, 5).toString("latin1") === "%PDF-") {
        skipped++;
        console.log(`${prefix}  skip (${kb(buf.byteLength)})`);
        continue;
      }
      console.log(`${prefix}  re-fetching (cached file is not a PDF)`);
    }

    try {
      const res = await fetchWithRetry(url);
      if (res.status === 404) {
        failed++;
        console.log(`${prefix}  MISSING (404) ${url}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());

      // CBSE serves an HTML error page with a 200 for a mistyped basename.
      if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
        failed++;
        console.log(`${prefix}  NOT A PDF (${buf.byteLength} bytes)`);
        continue;
      }

      await writeFile(path, buf);
      downloaded++;
      console.log(`${prefix}  ok (${kb(buf.byteLength)})`);
    } catch (err) {
      failed++;
      console.log(`${prefix}  FAILED ${(err as Error).message}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n=== done ===`);
  console.log(`downloaded: ${downloaded}`);
  console.log(`skipped:    ${skipped}`);
  console.log(`failed:     ${failed}`);
  if (failed > 0) console.log(`\nRe-run to retry the ${failed} failed document(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
