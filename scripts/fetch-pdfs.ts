/**
 * Phase 0, step 3 — mirror the chapter PDFs onto our own origin.
 *
 * This mirror is not an optimisation: ncert.nic.in serves the PDFs with no
 * Access-Control-Allow-Origin header and X-Frame-Options: SAMEORIGIN, so a
 * browser cannot fetch them into pdf.js or iframe them cross-origin. Serving
 * them from our own origin is the only way an in-app reader can work.
 *
 * Safe to re-run: a chapter whose file already matches its recorded sha256 is
 * skipped, so an interrupted run resumes where it stopped. Requests are
 * sequential with a delay — this is a government server, not a CDN.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chapterUrl, fetchWithRetry, sleep, type Manifest } from "./lib/ncert";

const OUT_ROOT = "public/ncert";
const DELAY_MS = 800;

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  const manifest = JSON.parse(await readFile("data/manifest.json", "utf8")) as Manifest;

  const total = manifest.books.reduce((n, b) => n + b.chapters.length, 0);
  let done = 0;
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let bytesTotal = 0;

  // Persist progress regularly so an interrupted run loses at most a few entries.
  const save = () => writeFile("data/manifest.json", JSON.stringify(manifest, null, 2));

  for (const book of manifest.books) {
    const dir = `${OUT_ROOT}/${book.code}`;
    await mkdir(dir, { recursive: true });
    console.log(`\n[${book.code}] ${book.title} (${book.chapters.length} chapters)`);

    for (const ch of book.chapters) {
      done++;
      const path = `${dir}/${ch.file}`;
      const prefix = `  ${String(done).padStart(3)}/${total} ${ch.file}`;

      // Already have it, and it matches what we recorded -> nothing to do.
      if (existsSync(path) && ch.sha256) {
        const buf = await readFile(path);
        if (sha256(buf) === ch.sha256) {
          bytesTotal += buf.byteLength;
          skipped++;
          console.log(`${prefix}  skip (${mb(buf.byteLength)})`);
          continue;
        }
      }

      // File present but unrecorded (e.g. manifest rebuilt): adopt it.
      if (existsSync(path) && !ch.sha256) {
        const buf = await readFile(path);
        ch.sha256 = sha256(buf);
        ch.bytes = buf.byteLength;
        ch.originalBytes = buf.byteLength;
        bytesTotal += buf.byteLength;
        skipped++;
        console.log(`${prefix}  adopt (${mb(buf.byteLength)})`);
        continue;
      }

      const url = chapterUrl(book.code, ch.n);
      try {
        const res = await fetchWithRetry(url);
        if (res.status === 404) {
          failed++;
          console.log(`${prefix}  MISSING (404) ${url}`);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());

        // NCERT returns an HTML error page with a 200 for some bad codes.
        if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
          failed++;
          console.log(`${prefix}  NOT A PDF (${buf.byteLength} bytes)`);
          continue;
        }

        await writeFile(path, buf);
        ch.bytes = buf.byteLength;
        ch.originalBytes = buf.byteLength;
        ch.sha256 = sha256(buf);
        bytesTotal += buf.byteLength;
        downloaded++;
        console.log(`${prefix}  ok (${mb(buf.byteLength)})`);
      } catch (err) {
        failed++;
        console.log(`${prefix}  FAILED ${(err as Error).message}`);
      }

      if (downloaded % 10 === 0) await save();
      await sleep(DELAY_MS);
    }
    await save();
  }

  await save();
  console.log(`\n=== done ===`);
  console.log(`downloaded: ${downloaded}`);
  console.log(`skipped:    ${skipped}`);
  console.log(`failed:     ${failed}`);
  console.log(`total size: ${mb(bytesTotal)}`);
  if (failed > 0) console.log(`\nRe-run to retry the ${failed} failed chapter(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
