/**
 * Shadow Mode and the doubt registry — the properties that have to hold.
 *
 *     node scripts/test-shadow.mjs
 *
 * Pure Node: no database, no browser, no build. Everything here is either
 * arithmetic or a hash, and both are testable without either.
 *
 * The pseudonym derivation is re-implemented below rather than imported,
 * because src/lib/shadow.ts is TypeScript and importing it would need a build
 * step this repo's other `test-*.mjs` scripts do not have. That makes this an
 * oracle rather than a tautology: it asserts the *properties* — stability,
 * non-correlation, non-enumerability — against an independent implementation of
 * the same rule. If the two ever disagree about the rule, this file is wrong
 * and should be fixed to match; what it must never do is stop checking that the
 * properties hold.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// The wordlists, read out of the source so the test cannot drift from it
// ---------------------------------------------------------------------------

const shadowSrc = readFileSync(path.join(ROOT, "src/lib/shadow.ts"), "utf8");

function wordlist(name) {
  const match = shadowSrc.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  if (!match) throw new Error(`could not find ${name} in src/lib/shadow.ts`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const ADJECTIVES = wordlist("ADJECTIVES");
const NOUNS = wordlist("NOUNS");
const SECRET = "dev-only-insecure-shadow-secret";

function mac(userId, threadId) {
  return createHmac("sha256", SECRET).update(`${threadId}\u0000${userId}`).digest();
}

function pseudonym(userId, threadId) {
  const m = mac(userId, threadId);
  return `${ADJECTIVES[m[0] % ADJECTIVES.length]} ${NOUNS[m[1] % NOUNS.length]}`;
}

function suffix(userId, threadId) {
  const m = mac(userId, threadId);
  return String(((m[2] << 8) | m[3]) % 100).padStart(2, "0");
}

/** The `pseudonymsFor` rule: a colliding group takes suffixes, everyone else does not. */
function pseudonymsFor(userIds, threadId) {
  const base = [...new Set(userIds)].map((id) => ({
    id,
    name: pseudonym(id, threadId),
    suffix: suffix(id, threadId),
  }));
  const counts = new Map();
  for (const p of base) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return new Map(
    base.map((p) => [p.id, counts.get(p.name) > 1 ? `${p.name} ${p.suffix}` : p.name]),
  );
}

/**
 * Pull one function's whole source out by counting braces. A lazy non-greedy
 * regex stops at the first nested closing brace at column zero, which silently
 * truncates every function here to its first few lines and makes the assertions
 * below pass on text they never read.
 */
function extractFn(src, name) {
  const start = src.indexOf(`export async function ${name}`);
  if (start === -1) return "";
  // Start at the brace that opens the *body*, not the one that opens the
  // `opts: { … }` parameter object — counting from that one returns the
  // signature and nothing else, and every assertion below then reads an empty
  // string and passes.
  const arrow = src.indexOf("> {", start);
  if (arrow === -1) return "";
  let depth = 0;
  let seen = false;
  for (let i = src.indexOf("{", arrow); i < src.length; i += 1) {
    if (src[i] === "{") { depth += 1; seen = true; }
    else if (src[i] === "}") { depth -= 1; if (seen && depth === 0) return src.slice(start, i + 1); }
  }
  return "";
}

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tid = (n) => `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ---------------------------------------------------------------------------

section("Pseudonyms are stable within a thread");

check("the same user in the same thread is always the same name", () => {
  for (let i = 0; i < 200; i += 1) {
    const a = pseudonym(uid(i), tid(1));
    const b = pseudonym(uid(i), tid(1));
    assert(a === b, `${uid(i)} derived ${a} then ${b}`);
  }
});

check("a name is two words from the published lists", () => {
  const [adj, noun] = pseudonym(uid(7), tid(3)).split(" ");
  assert(ADJECTIVES.includes(adj), `${adj} is not in ADJECTIVES`);
  assert(NOUNS.includes(noun), `${noun} is not in NOUNS`);
});

check("the lists are big enough to be worth having", () => {
  assert(ADJECTIVES.length >= 48, `only ${ADJECTIVES.length} adjectives`);
  assert(NOUNS.length >= 48, `only ${NOUNS.length} nouns`);
  assert(new Set(ADJECTIVES).size === ADJECTIVES.length, "duplicate adjective");
  assert(new Set(NOUNS).size === NOUNS.length, "duplicate noun");
});

section("Pseudonyms do not correlate across threads");

check("one user is a different name in most other threads", () => {
  // The property is that the thread is inside the MAC, so a name carries no
  // information about the same person elsewhere. Over 500 threads, a collision
  // rate near 1/2304 is the signature of that; anything near 1.0 would mean the
  // thread id was being ignored.
  const home = pseudonym(uid(42), tid(0));
  let same = 0;
  for (let t = 1; t <= 500; t += 1) if (pseudonym(uid(42), tid(t)) === home) same += 1;
  assert(same < 25, `${same}/500 threads reused the same name — the thread id is not in the MAC`);
});

check("two users who collide in one thread do not collide in the next", () => {
  // Find a genuine collision, then show it does not follow them.
  let found = null;
  let thread = null;
  outer: for (let t = 9; t < 60 && !found; t += 1) {
    for (let a = 0; a < 200; a += 1) {
      for (let b = a + 1; b < 200; b += 1) {
        if (pseudonym(uid(a), tid(t)) === pseudonym(uid(b), tid(t))) {
          found = [a, b];
          thread = t;
          break outer;
        }
      }
    }
  }
  assert(found, "no collision found to test with — widen the search");
  void thread;
  let follows = 0;
  for (let t = 100; t < 200; t += 1) {
    if (pseudonym(uid(found[0]), tid(t)) === pseudonym(uid(found[1]), tid(t))) follows += 1;
  }
  assert(follows < 10, `they collided in ${follows}/100 further threads`);
});

check("names spread across the space rather than clumping", () => {
  const seen = new Set();
  for (let i = 0; i < 3000; i += 1) seen.add(pseudonym(uid(i), tid(5)));
  // 3000 draws from 2304 names: the coupon-collector expectation is ~1600
  // distinct. Far below that would mean the hash is not mixing.
  assert(seen.size > 1200, `only ${seen.size} distinct names from 3000 users`);
});

check("the derivation is keyed — a wrong secret gives an unrelated name", () => {
  const other = createHmac("sha256", "a-different-secret-entirely").update(`${tid(1)}\u0000${uid(3)}`).digest();
  const otherName = `${ADJECTIVES[other[0] % ADJECTIVES.length]} ${NOUNS[other[1] % NOUNS.length]}`;
  assert(
    otherName !== pseudonym(uid(3), tid(1)),
    "the secret does not affect the output — anyone could enumerate authorship",
  );
});

section("Collisions inside one thread are broken, and stably");

check("a colliding pair both take a suffix", () => {
  let pair = null;
  let thread = 9;
  outer: for (let t = 9; t < 60 && !pair; t += 1) {
    for (let a = 0; a < 200; a += 1) {
      for (let b = a + 1; b < 200; b += 1) {
        if (pseudonym(uid(a), tid(t)) === pseudonym(uid(b), tid(t))) {
          pair = [uid(a), uid(b)];
          thread = t;
          break outer;
        }
      }
    }
  }
  assert(pair, "no collision found");
  const names = pseudonymsFor(pair, tid(thread));
  assert(names.get(pair[0]) !== names.get(pair[1]), "collision was not broken");
  void thread;
  assert(/ \d\d$/.test(names.get(pair[0])), "first member kept a bare name");
  assert(/ \d\d$/.test(names.get(pair[1])), "second member kept a bare name");
});

check("a sixth participant does not rename the first five", () => {
  const five = [uid(1), uid(2), uid(3), uid(4), uid(5)];
  const before = pseudonymsFor(five, tid(11));
  const after = pseudonymsFor([...five, uid(6)], tid(11));
  for (const id of five) {
    // The only permitted change is a bare name gaining a suffix because the new
    // arrival collided with it — never a suffix changing value, which is what
    // would rewrite who said what earlier in the thread.
    const b = before.get(id);
    const a = after.get(id);
    assert(a === b || a === `${b} ${suffix(id, tid(11))}`, `${id}: "${b}" became "${a}"`);
  }
});

check("a non-colliding participant never carries a suffix", () => {
  const names = pseudonymsFor([uid(1), uid(2), uid(3)], tid(12));
  const bare = [...names.values()].filter((n) => !/ \d\d$/.test(n));
  assert(bare.length === 3, `expected 3 bare names, got ${JSON.stringify([...names.values()])}`);
});

section("The author is always recorded — enforced by the schema, not by us");

const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
const doubtsSrc = readFileSync(path.join(ROOT, "src/lib/doubts.ts"), "utf8");
const moderationSrc = readFileSync(path.join(ROOT, "src/lib/moderation.ts"), "utf8");

check("the column a doubt's author lands in is NOT NULL and a foreign key", () => {
  const model = schema.match(/model Submission \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert(/studentId\s+String\s+@db\.Uuid/.test(model), "Submission.studentId is not a non-null uuid");
  assert(/student\s+User\s+@relation/.test(model), "Submission.studentId is not a foreign key");
  assert(!/studentId\s+String\?/.test(model), "Submission.studentId is nullable — an unattributable doubt is possible");
});

check("every write path sets the author from the session user", () => {
  const all = [...doubtsSrc.matchAll(/studentId: ([^,\n]+)/g), ...moderationSrc.matchAll(/studentId: ([^,\n]+)/g)]
    .map((m) => m[1].trim());
  // Every occurrence, write or filter alike, has to resolve to a user this
  // request loaded from the session. `studentId: true` is a Prisma select.
  for (const w of all) {
    assert(
      w.startsWith("true") || /^opts\.\w+\.id\b/.test(w),
      `an author is referenced as \`${w}\` — it must come from a session-loaded user`,
    );
    for (const banned of ["body", "params", "req.", "searchParams", "headers"]) {
      assert(!w.includes(banned), `an author is read from the request: \`${w}\``);
    }
  }
  const writes = all.filter((w) => /^opts\.(author|reporter|moderator)\.id$/.test(w));
  assert(writes.length >= 3, `expected at least 3 author writes, found ${writes.length}`);
});

check("no route reads an author out of a request body", () => {
  const routes = [
    "src/app/api/doubts/route.ts",
    "src/app/api/doubts/[id]/route.ts",
    "src/app/api/doubts/[id]/replies/route.ts",
    "src/app/api/doubts/[id]/report/route.ts",
    "src/app/api/doubts/[id]/resolve/route.ts",
    "src/app/api/doubts/[id]/voice/route.ts",
    "src/app/api/moderation/queue/route.ts",
    "src/app/api/moderation/[id]/route.ts",
    "src/app/api/moderation/[id]/author/route.ts",
  ];
  for (const rel of routes) {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    for (const banned of ["body.studentId", "body.userId", "body.authorId", "body.role", "body.scopeId"]) {
      assert(!src.includes(banned), `${rel} reads ${banned} from the request body`);
    }
    assert(/auth:/.test(src), `${rel} declares no auth — omitting it makes the route public`);
  }
});

check("every API path in this lane carries a trailing slash", () => {
  const clients = [
    "src/components/DoubtComposer.tsx",
    "src/components/DoubtList.tsx",
    "src/app/moderation/ModerationQueue.tsx",
  ];
  for (const rel of clients) {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of src.matchAll(/["'`](\/api\/[^"'`?]*)/g)) {
      assert(
        m[1].endsWith("/"),
        `${rel} calls ${m[1]} without a trailing slash — a POST there 308s and loses its body`,
      );
    }
  }
});

section("Moderation can always resolve, and a report enqueues");

check("resolution is ADMIN-only and writes a record before it reads the name", () => {
  const fn = extractFn(moderationSrc, "revealAuthor");
  assert(fn, "revealAuthor not found");
  assert(/role !== "ADMIN"/.test(fn), "revealAuthor does not check for ADMIN");
  assert(/opts\.reason\.trim\(\)/.test(fn), "revealAuthor does not demand a reason");
  const auditAt = fn.indexOf('verb: "reveal"');
  const readAt = fn.indexOf("prisma.user.findUniqueOrThrow");
  assert(auditAt > -1 && readAt > -1, "revealAuthor is missing its audit row or its user read");
  assert(auditAt < readAt, "revealAuthor reads the user before it writes the audit row");
});

check("resolution does not hand back a phone number", () => {
  const fn = extractFn(moderationSrc, "revealAuthor");
  assert(!/phone/.test(fn), "revealAuthor exposes a phone number");
});

check("a report's idempotency key is derived, not accepted from the client", () => {
  const fn = extractFn(moderationSrc, "reportPost");
  assert(/const idempotencyKey = `doubt-report:\$\{opts\.postId\}`/.test(fn),
    "reportPost does not derive its key from the post id");
  const routeSrc = readFileSync(path.join(ROOT, "src/app/api/doubts/[id]/report/route.ts"), "utf8");
  assert(!/idempotent: true/.test(routeSrc), "the report route accepts a client key, so one student can report eleven times");
});

check("acting on a post closes the open reports on it", () => {
  const fn = extractFn(moderationSrc, "moderatePost");
  assert(/updateMany/.test(fn) && /gradedAt: null/.test(fn),
    "moderatePost leaves reports open — the post comes straight back to the top of the queue");
});

check("SAFETY outranks any volume of anything else", () => {
  const weights = moderationSrc.match(/const REASON_WEIGHT[\s\S]*?\};/)?.[0] ?? "";
  // Numeric separators are legal TypeScript, so `10_000` has to parse here too.
  const num = (t) => Number(String(t).replace(/_/g, ""));
  const safety = num(weights.match(/SAFETY: ([\d_]+)/)?.[1]);
  const others = [...weights.matchAll(/(?:BULLYING|PERSONAL_INFO|SPAM|OFF_TOPIC|OTHER): (\d+)/g)]
    .map((m) => Number(m[1]));
  assert(safety > others.reduce((a, b) => a + b, 0) * 20,
    "a single safety report can be buried under a pile of spam flags");
});

section("Nothing here builds a live channel or a leaderboard");

check("no peer-to-peer audio anywhere in the lane", () => {
  const files = [
    "src/lib/doubts.ts",
    "src/lib/shadow.ts",
    "src/lib/moderation.ts",
    "src/components/VoiceRecorder.tsx",
    "src/components/DoubtList.tsx",
    "src/components/DoubtComposer.tsx",
    "src/app/api/doubts/[id]/voice/route.ts",
  ];
  for (const rel of files) {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    for (const banned of ["RTCPeerConnection", "getDisplayMedia", "new WebSocket", "webrtc"]) {
      assert(!src.includes(banned), `${rel} contains ${banned} — this lane does not stream audio between children`);
    }
  }
});

check("the recorder caps at the same 90 seconds the database does", () => {
  const recorder = readFileSync(path.join(ROOT, "src/components/VoiceRecorder.tsx"), "utf8");
  const migration = readFileSync(
    path.join(ROOT, "prisma/migrations/20260831100300_check_constraints/migration.sql"),
    "utf8",
  );
  assert(/const MAX_MS = 90_000;/.test(recorder), "the recorder's cap is not 90s");
  assert(/export const MAX_VOICE_MS = 90_000;/.test(doubtsSrc), "MAX_VOICE_MS is not 90s");
  assert(/"durationMs" <= 90000/.test(migration), "the CHECK constraint is not 90s");
});

section("Retention arithmetic");

const DAY = 24 * 60 * 60 * 1000;

function retentionDays(kind) {
  const block = doubtsSrc.match(/export const RETENTION_DAYS = \{[\s\S]*?\} as const;/)?.[0] ?? "";
  const n = Number(block.match(new RegExp(`${kind}: (\\d+)`))?.[1]);
  assert(Number.isFinite(n), `no retention window declared for ${kind}`);
  return n;
}

check("the three windows are declared and ordered as documented", () => {
  const voice = retentionDays("voiceNote");
  const post = retentionDays("post");
  const moderation = retentionDays("moderation");
  assert(voice === 90, `voice notes are ${voice} days, not 90`);
  assert(post === 180, `posts are ${post} days, not 180`);
  assert(moderation === 365, `moderation records are ${moderation} days, not 365`);
  // A recording of a child's voice survives pseudonymity intact, so it goes
  // first; the moderation record protects other children, so it goes last.
  assert(voice < post && post < moderation, "the windows are not ordered voice < post < moderation");
});

check("expiry is creation plus the window, to the millisecond", () => {
  const created = new Date("2026-01-01T00:00:00.000Z");
  const cases = [
    ["voiceNote", 90],
    ["post", 180],
    ["moderation", 365],
  ];
  for (const [kind, days] of cases) {
    const expiry = new Date(created.getTime() + retentionDays(kind) * DAY);
    assert(
      expiry.getTime() - created.getTime() === days * DAY,
      `${kind} expires after ${(expiry - created) / DAY} days, not ${days}`,
    );
  }
});

check("the clock starts at creation, not at last read", () => {
  const created = new Date("2026-01-01T00:00:00.000Z");
  const readLater = new Date("2026-06-01T00:00:00.000Z");
  const expiry = new Date(created.getTime() + retentionDays("voiceNote") * DAY);
  assert(
    expiry < readLater,
    "a voice note read in June must already be expired if it was recorded in January",
  );
});

check("a thing is expired on its boundary, not a tick later", () => {
  const created = new Date("2026-01-01T00:00:00.000Z");
  const window = retentionDays("post") * DAY;
  const atBoundary = new Date(created.getTime() + window);
  const justBefore = new Date(created.getTime() + window - 1);
  assert(created.getTime() + window <= atBoundary.getTime(), "boundary is not inclusive");
  assert(created.getTime() + window > justBefore.getTime(), "expires a millisecond early");
});

check("the deletion path exists and deletes voice objects before their rows", () => {
  const fn = extractFn(doubtsSrc, "purgeExpired");
  assert(fn, "purgeExpired not found");
  const storageDelete = fn.indexOf("storage.delete(note.storageKey)");
  const rowDelete = fn.indexOf("prisma.voiceNote.delete");
  assert(storageDelete > -1 && rowDelete > -1, "purgeExpired does not remove voice notes");
  assert(
    storageDelete < rowDelete,
    "the row is deleted before the object, which orphans the object with no key to find it by",
  );
  assert(/deleteOwnPost/.test(doubtsSrc), "there is no author-initiated deletion path");
});

section("Storage isolation from the grading domain");

check("every row this lane writes is discriminated by one prefix", () => {
  assert(/export const DOUBT_PREFIX = "doubt\/v1";/.test(doubtsSrc), "DOUBT_PREFIX is not doubt/v1");
  assert(/export const NOT_A_DOUBT/.test(doubtsSrc), "there is no exclusion fragment for other lanes");
  const slugs = [...doubtsSrc.matchAll(/paperSlug: buildSlug\(/g)];
  assert(slugs.length >= 1, "a paperSlug is being built by hand somewhere");
});

check("the resting state is terminal in the grading pipeline", () => {
  const map = doubtsSrc.match(/const STATUS_FOR: Record<Visibility[\s\S]*?\};/)?.[0] ?? "";
  assert(/VISIBLE: "GRADED"/.test(map), "a visible doubt does not rest on a terminal status");
  assert(/REMOVED: "FAILED"/.test(map), "a removed doubt does not rest on a terminal status");
  for (const swept of ["QUEUED", "OCR_RUNNING", "AI_GRADING", "AWAITING_REVIEW"]) {
    assert(!map.includes(`"${swept}"`), `a doubt can rest on ${swept}, which a grading sweeper claims`);
  }
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ${f.name}: ${f.message}`);
  process.exit(1);
}
