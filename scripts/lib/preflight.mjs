/**
 * Preflight: prove the target URL is a live build of *this* app before a suite
 * runs a single check.
 *
 * Why this exists. The smoke suites take a base URL and start testing; none of
 * them ever asked whether anything at that URL was NCERT Quick. Twice now a
 * stale `npx serve` from an earlier run has kept hold of the port, the
 * `next start` that was meant to replace it died with EADDRINUSE, a curl
 * readiness check saw a response — a 404, but a response — and called the
 * server up. All four suites then ran against the corpse and produced four
 * suites of confident, entirely fictitious failures: "service worker registers
 * and activates: FAIL", "web app manifest: missing", "home offers a way into a
 * class: FAIL". The app was fine the whole time.
 *
 * A harness that cannot tell "the application is broken" from "I am talking to
 * the wrong server" will eventually cost someone a day. So: three HTTP
 * requests, no browser, before anything else.
 *
 * Exit code 3 is reserved for a preflight failure, so CI can tell it apart from
 * an ordinary test failure (1). Nothing else in these scripts exits 3.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Exit code meaning "I never ran the tests; the target is wrong." */
export const PREFLIGHT_EXIT = 3;

const TIMEOUT_MS = 5000;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

/** Identity markers. These are what make the target *this* app and not merely a server. */
const EXPECTED_SHORT_NAME = "NCERT Quick";
const SW_MARKERS = ["ncert-shell-v1", "ncert-pdfs-v1"];

/** A GET that never hangs and never throws — the failure is the return value. */
async function probe(url) {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { ok: true, status: res.status, body: await res.text() };
  } catch (err) {
    const cause = err?.cause?.code ?? err?.code ?? err?.name ?? "unknown";
    return { ok: false, transport: cause, message: err?.message ?? String(err) };
  }
}

/** `netstat`/`lsof` incantation for whichever machine the operator is on. */
function whoOwnsPort(port) {
  return process.platform === "win32"
    ? `netstat -ano | findstr :${port}`
    : `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

/**
 * How this suite's server is normally started, for the "do this" block.
 *
 * `npm start` is `next start -p 3222`. There is no `out/` any more — the app
 * dropped `output: "export"` when it grew a server half — so never suggest
 * `serve out` here: that is the dead command whose leftover process caused the
 * incident this preflight exists to catch.
 */
function startHint(base) {
  const port = new URL(base).port;
  return port === "3222" || port === ""
    ? "npm run build && npm start"
    : `npm run build && npx next start -p ${port}`;
}

/** One line of evidence, e.g. `GET /sw.js -> 200 (text/html body)`. */
function shape(body) {
  const head = body.slice(0, 80).replace(/\s+/g, " ").trim();
  if (/^<!doctype html|^<html/i.test(head)) return "an HTML page";
  if (/^\s*[{[]/.test(body)) return "JSON";
  return head ? `"${head}${body.length > 80 ? "…" : ""}"` : "an empty body";
}

function fail(base, suite, symptom, meaning, extraSteps = []) {
  const url = new URL(base);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const steps = [
    `1. Find who owns the port:  ${whoOwnsPort(port)}`,
    `2. Kill that PID, then:     ${startHint(base)}`,
    `3. Re-run:                  node ${suite} ${base}`,
    ...extraSteps,
  ];

  console.error("");
  console.error(`PREFLIGHT FAILED  —  ${base} is not a live build of NCERT Quick.`);
  console.error("");
  console.error(`  Suite:    ${suite}  (not run — 0 checks executed)`);
  console.error(`  Symptom:  ${symptom}`);
  for (const [i, line] of meaning.split("\n").entries()) {
    console.error(`  ${i === 0 ? "Meaning: " : "         "} ${line}`);
  }
  console.error("");
  for (const [i, line] of steps.entries()) {
    console.error(`  ${i === 0 ? "Do this: " : "         "} ${line}`);
  }
  console.error("");
  console.error(
    "  Nothing below this line ran. Had it run, every check would have failed,",
  );
  console.error(
    "  and every one of those failures would have been fiction — about the",
  );
  console.error(`  wrong server, not about the app. (exit ${PREFLIGHT_EXIT} = preflight;`);
  console.error("  an ordinary test failure exits 1.)");
  console.error("");
  process.exit(PREFLIGHT_EXIT);
}

/** Warn, but do not stop the run: a served asset no longer matches the repo. */
function driftWarning(name, servedBody) {
  let local;
  try {
    local = readFileSync(join(PUBLIC_DIR, name));
  } catch {
    return null; // Run from outside a checkout; nothing to compare against.
  }
  const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 12);
  const served = sha(Buffer.from(servedBody));
  return served === sha(local)
    ? null
    : `public/${name} on disk (${sha(local)}) differs from the one being served (${served})`;
}

/**
 * Assert the target is this application, or exit 3 with a message worth reading
 * at 2am. Three parallel GETs; typically ~30 ms against localhost.
 *
 * @param {string} baseUrl  e.g. "http://localhost:3222"
 * @param {string} suite    the calling script's path, for the failure message
 */
export async function preflight(baseUrl, suite) {
  const base = baseUrl.replace(/\/+$/, "");
  const [manifest, sw, root] = await Promise.all([
    probe(`${base}/manifest.webmanifest`),
    probe(`${base}/sw.js`),
    probe(`${base}/`),
  ]);

  // --- is anything there at all? -----------------------------------------
  if (!manifest.ok) {
    const refused = /ECONNREFUSED/.test(manifest.transport);
    fail(
      base,
      suite,
      `GET /manifest.webmanifest — ${manifest.transport} (${manifest.message})`,
      refused
        ? "Nothing is listening on this port. The server was never started, or\nit exited — check the build output for EADDRINUSE, a compile error,\nor a crash on boot."
        : "The host did not answer in time or could not be resolved. Check the\nhost name, and that the server is not wedged.",
    );
  }

  // --- is it this app? ----------------------------------------------------
  if (manifest.status !== 200) {
    fail(
      base,
      suite,
      `GET /manifest.webmanifest — ${manifest.status}`,
      "Something is listening on this port, but it is not this app. The\n" +
        "classic cause is a stale `npx serve` or `next start` from an earlier\n" +
        "run still holding the port — serving 404s out of a directory that no\n" +
        "longer exists — while the build you meant to test died of EADDRINUSE.",
    );
  }

  let name;
  try {
    name = JSON.parse(manifest.body).short_name;
  } catch {
    fail(
      base,
      suite,
      `GET /manifest.webmanifest — 200, but the body is not JSON: ${shape(manifest.body)}`,
      "This server answers every path with the same catch-all page, so a 200\n" +
        "here proves nothing. It is a different app, a dev-server error\n" +
        "overlay, or a proxy — not a build of NCERT Quick.",
    );
  }
  if (name !== EXPECTED_SHORT_NAME) {
    fail(
      base,
      suite,
      `GET /manifest.webmanifest — 200, short_name is ${JSON.stringify(name)}, expected ${JSON.stringify(EXPECTED_SHORT_NAME)}`,
      "A different application owns this port — another project's dev server,\n" +
        "most likely. Point the suite at the right URL, or free the port.",
    );
  }

  if (sw.status !== 200 || !SW_MARKERS.every((m) => sw.body.includes(m))) {
    fail(
      base,
      suite,
      sw.status === 200
        ? `GET /sw.js — 200, but the body is not the NCERT Quick service worker (${shape(sw.body)}; no ${SW_MARKERS.join("/")} markers)`
        : `GET /sw.js — ${sw.status}`,
      "public/sw.js is served verbatim by `next start`, so this is either not\n" +
        "a build of this app or an incomplete one. The PWA\n" +
        "checks would all fail against it, and none of those failures would be\n" +
        "about the service worker.",
    );
  }

  if (root.status !== 200) {
    fail(
      base,
      suite,
      `GET / — ${root.status}${root.status >= 300 && root.status < 400 ? " (redirect)" : ""}`,
      "The app's own assets are being served, but its home page is not. A\n" +
        "half-deployed build, or a static server rooted one directory off.",
    );
  }
  if (!/_next/.test(root.body)) {
    fail(
      base,
      suite,
      `GET / — 200, but the HTML references no /_next asset (${shape(root.body)})`,
      "This is not a Next.js build of the app — more likely a placeholder or\n" +
        "an index page left behind in the serve root.",
    );
  }

  // --- is the build current? (advisory only) ------------------------------
  // Catches the subtler version of the same failure: a server that *is* this
  // app, running a build older than the working tree. Only proves it for the
  // two public assets fetched above — a stale `src/` cannot be seen from here.
  const drift = [
    driftWarning("manifest.webmanifest", manifest.body),
    driftWarning("sw.js", sw.body),
  ].filter(Boolean);
  if (drift.length) {
    console.warn("");
    console.warn(`PREFLIGHT WARNING  —  ${base} may be serving a stale build.`);
    for (const d of drift) console.warn(`  ${d}`);
    console.warn(`  Rebuild before trusting a failure: ${startHint(base)}`);
    console.warn("");
  }

  console.log(`preflight OK  —  ${base} is serving NCERT Quick\n`);
}
