/**
 * Phase 2, step 2 — mirror the NCERT per-book extras.
 *
 * Alongside the numbered chapter PDFs, NCERT publishes a few unnumbered files
 * per book under the same code scheme:
 *
 *   <code>an.pdf   answers to the back exercises   (jesc1an.pdf)
 *   <code>a1.pdf   appendix 1                      (jess1a1.pdf)
 *   <code>a2.pdf   appendix 2                      (jemh1a2.pdf)
 *
 * The answer keys are what Phase 3 lets a Class 9 student self-check against,
 * since CBSE publishes no Class 9 sample papers. They are not optional.
 *
 * Nothing announces which extras a book has — the catalogue lists only the
 * chapter count — so each is probed and only the ones that come back as a real
 * PDF are recorded. NCERT answers a bad code with an HTML error page under a
 * 200 status, so the %PDF- magic bytes are the actual test, not the status.
 *
 * The prelims file (<code>ps.pdf) is deliberately not fetched here: the title
 * extractor already caches it under data/prelims for its Contents page, and it
 * is not student-facing content.
 *
 * Same mirroring constraint as everything else in this pipeline — ncert.nic.in
 * sends no Access-Control-Allow-Origin and X-Frame-Options: SAMEORIGIN, so the
 * browser cannot fetch or iframe these cross-origin.
 *
 * Safe to re-run: a file already matching its recorded sha256 is skipped, and
 * a code recorded as absent is re-probed (NCERT does add files over time).
 *
 * Output: public/ncert/<code>/<code>{an,a1,a2}.pdf and data/extras.json
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { BASE, fetchWithRetry, sleep, type Manifest } from "./lib/ncert";

const OUT_ROOT = "public/ncert";
const EXTRAS_JSON = "data/extras.json";
const DELAY_MS = 1000;

/** Suffix -> what the file actually is, for the UI to label it. */
const KINDS = [
  { suffix: "an", kind: "answers", label: "Answers to exercises" },
  { suffix: "a1", kind: "appendix1", label: "Appendix 1" },
  { suffix: "a2", kind: "appendix2", label: "Appendix 2" },
] as const;

export type ExtraKind = (typeof KINDS)[number]["kind"];

export interface Extra {
  kind: ExtraKind;
  label: string;
  /** Basename of the PDF, e.g. "jesc1an.pdf". */
  file: string;
  bytes: number;
  sha256: string;
}

export interface BookExtras {
  code: string;
  class: 9 | 10;
  subject: string;
  title: string;
  extras: Extra[];
  /** Suffixes probed and confirmed absent, so a re-run can report the gap. */
  absent: string[];
}

export interface ExtrasManifest {
  generatedAt: string;
  source: string;
  books: BookExtras[];
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function kb(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  const manifest = JSON.parse(await readFile("data/manifest.json", "utf8")) as Manifest;

  // Previous run's hashes, keyed by basename, so re-runs skip what is unchanged.
  const known = new Map<string, string>();
  if (existsSync(EXTRAS_JSON)) {
    const prev = JSON.parse(await readFile(EXTRAS_JSON, "utf8")) as ExtrasManifest;
    for (const b of prev.books) for (const e of b.extras) known.set(e.file, e.sha256);
  }

  const books: BookExtras[] = [];
  let downloaded = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;
  let bytesTotal = 0;

  const save = () =>
    writeFile(
      EXTRAS_JSON,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          source: `${BASE}/textbook/pdf/`,
          books,
        } satisfies ExtrasManifest,
        null,
        2,
      ),
    );

  for (const book of manifest.books) {
    const dir = `${OUT_ROOT}/${book.code}`;
    await mkdir(dir, { recursive: true });
    const entry: BookExtras = {
      code: book.code,
      class: book.class,
      subject: book.subject,
      title: book.title,
      extras: [],
      absent: [],
    };
    books.push(entry);
    console.log(`\n[${book.code}] ${book.title}`);

    for (const { suffix, kind, label } of KINDS) {
      const file = `${book.code}${suffix}.pdf`;
      const path = `${dir}/${file}`;
      const prefix = `  ${file.padEnd(14)}`;

      if (existsSync(path)) {
        const buf = await readFile(path);
        const hash = sha256(buf);
        // Recorded and unchanged, or present but unrecorded (extras rebuilt).
        if (!known.has(file) || known.get(file) === hash) {
          entry.extras.push({ kind, label, file, bytes: buf.byteLength, sha256: hash });
          bytesTotal += buf.byteLength;
          skipped++;
          console.log(`${prefix} ${known.has(file) ? "skip " : "adopt"} (${kb(buf.byteLength)})`);
          continue;
        }
      }

      const url = `${BASE}/textbook/pdf/${file}`;
      try {
        const res = await fetchWithRetry(url);
        if (res.status === 404) {
          entry.absent.push(suffix);
          missing++;
          console.log(`${prefix} absent (404)`);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());

        // A 200 carrying HTML is NCERT's way of saying the code does not exist.
        if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
          entry.absent.push(suffix);
          missing++;
          console.log(`${prefix} absent (${buf.byteLength}-byte non-PDF under HTTP 200)`);
          continue;
        }

        await writeFile(path, buf);
        entry.extras.push({ kind, label, file, bytes: buf.byteLength, sha256: sha256(buf) });
        bytesTotal += buf.byteLength;
        downloaded++;
        console.log(`${prefix} ok    (${kb(buf.byteLength)})`);
      } catch (err) {
        failed++;
        console.log(`${prefix} FAILED ${(err as Error).message}`);
      }

      await sleep(DELAY_MS);
    }
    await save();
  }

  await save();

  const withAnswers = books.filter((b) => b.extras.some((e) => e.kind === "answers"));
  console.log(`\n=== done ===`);
  console.log(`books probed:    ${books.length}`);
  console.log(`downloaded:      ${downloaded}`);
  console.log(`skipped:         ${skipped}`);
  console.log(`absent:          ${missing}`);
  console.log(`failed:          ${failed}`);
  console.log(`total size:      ${kb(bytesTotal)}`);
  console.log(`\nBooks with an answer key: ${withAnswers.length}/${books.length}`);
  for (const b of withAnswers) console.log(`  [${b.class}] ${b.code.padEnd(6)} ${b.subject} — ${b.title}`);
  const none = books.filter((b) => b.extras.length === 0);
  console.log(`\nBooks with no extras at all: ${none.length}`);
  for (const b of none) console.log(`  [${b.class}] ${b.code.padEnd(6)} ${b.subject} — ${b.title}`);
  console.log(`\nWrote ${EXTRAS_JSON}`);
  if (failed > 0) console.log(`Re-run to retry the ${failed} failed probe(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
