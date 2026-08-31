/**
 * The ledger's invariants, proved against a live server and a live database.
 *
 *   npx next dev -p 3325            # in one shell
 *   node scripts/test-ledger.mjs    # in another  (or: node scripts/test-ledger.mjs http://localhost:3325)
 *
 * Every check here is an assertion about money, which is why none of them is a
 * mock. The HTTP half drives the real routes with a real session cookie, so the
 * authorisation, the idempotency and the settlement race are the shipped ones.
 * The SQL half reads `ledger.*` directly, because "the entries sum to zero" and
 * "an earning cannot be mutated" are statements about the database, and the
 * only honest way to test whether an UPDATE is refused is to attempt one.
 *
 * The six defects in `CBSE_EdTech_Platform_Technical_Specification.md` §3 map
 * onto the checks like this:
 *
 *   1  actor from the body        → "an evaluator cannot open the portal",
 *                                   "an admin cannot touch another centre's wallet"
 *   2  updateMany over raw ids    → "settling a mixed list pays only what it claimed"
 *   3  read-then-write race       → "four concurrent settlements pay once"
 *   4  not double-entry           → "every transaction nets to zero", "a lone line is refused"
 *   5  mutable "immutable" ledger → "an earning cannot be updated or deleted"
 *   6  undefined balance          → "balance is the projection", "no wallet is negative"
 *
 * Exits 0 on success, 1 on a failed assertion, 3 when the environment is not
 * ready (no server, no database) — the same convention as scripts/smoke*.mjs,
 * so CI can tell "not run" from "broken".
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const BASE = (process.argv[2] ?? "http://localhost:3325").replace(/\/$/, "");

/** The seed's fixtures. Ids are derived from stable names, so these hold across reseeds. */
const ADMIN = { phone: "+919810000031", scopeId: "11111111-1111-1111-1111-111111111111" };
const EVALUATOR = { phone: "+919810000021", scopeId: "00000000-0000-0000-0000-000000000000" };

/** A subject nobody will have configured, for the unknown-rate check. */
const RUN = randomUUID().slice(0, 8);
const UNPRICED_SUBJECT = `Unpriced ${RUN}`;

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function bail(message) {
  console.error(`\n${message}\n`);
  process.exit(3);
}

// ---------------------------------------------------------------------------
// Money, in paise. The script does its own arithmetic rather than trusting the
// server's totals — a test that adds up the same way the code under test does
// would agree with it about a wrong answer.
// ---------------------------------------------------------------------------

function paise(decimal) {
  const s = String(decimal).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`not an amount: ${decimal}`);
  const negative = s.startsWith("-");
  const [whole, frac = ""] = (negative ? s.slice(1) : s).split(".");
  const value = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  return negative ? -value : value;
}

function rupees(value) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

function sum(values) {
  return values.reduce((total, v) => total + v, 0n);
}

/** The shipped formula, independently: (base + perPage × pages) × multiplier, half up. */
function expectedAmount(base, perPage, multiplier, pages) {
  const before = paise(base) + paise(perPage) * BigInt(pages);
  const scaled = before * paise(multiplier);
  return (scaled * 2n + 100n) / 200n;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function makeClient() {
  let cookie = "";
  return async function call(method, path, { body, key } = {}) {
    const headers = { accept: "application/json" };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (key) headers["idempotency-key"] = key;
    // The trailing slash is not optional: next.config.ts sets trailingSlash,
    // and a 308 on a POST loses the body of any client that does not re-send it.
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      if (c.startsWith("ncert_session=")) cookie = c.split(";")[0];
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* a 308 body, or an HTML error page */
    }
    return { status: res.status, body: json, text };
  };
}

async function signIn(who) {
  const call = makeClient();
  const res = await call("POST", "/api/dev/login/", { body: who });
  if (res.status !== 200) {
    bail(
      `Could not sign in as ${who.phone} (${res.status}). Run \`npx tsx prisma/seed.ts\` and make ` +
        `sure the dev server on ${BASE} is not NODE_ENV=production.`,
    );
  }
  return { call, user: res.body.user };
}

// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ log: ["warn", "error"] });

async function main() {
  try {
    process.loadEnvFile?.(".env");
  } catch {
    /* DATABASE_URL may already be in the environment */
  }

  try {
    const probe = await fetch(`${BASE}/api/auth/session/`, { redirect: "manual" });
    if (probe.status !== 200 && probe.status !== 401) {
      bail(`${BASE} answered ${probe.status} on /api/auth/session/. Is this the NCERT dev server?`);
    }
  } catch {
    bail(`No server at ${BASE}. Start one with \`npx next dev -p 3325\`.`);
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    bail(`No database: ${err.message}\nStart ncert-pg on port 5433 — see docs/PLATFORM.md §6.`);
  }

  const admin = await signIn(ADMIN);
  const evaluator = await signIn(EVALUATOR);

  // =========================================================================
  console.log("\nAuthorisation — the actor is the session, never the body");
  // =========================================================================

  {
    const res = await evaluator.call("GET", "/api/payouts/");
    check("an evaluator cannot open the clearance portal", res.status === 403, `got ${res.status}`);
  }
  {
    // The specification took `centerAdminId` from the body. There is no such
    // field here, so the closest a caller can come is sending one and hoping.
    const res = await evaluator.call("POST", "/api/payouts/settle/", {
      key: randomUUID(),
      body: {
        walletId: randomUUID(),
        earningTransactionIds: [randomUUID()],
        centerAdminId: admin.user.id,
        actorUserId: admin.user.id,
        role: "ADMIN",
      },
    });
    check(
      "a body claiming to be the admin does not make you one",
      res.status === 403,
      `got ${res.status}`,
    );
  }
  {
    const res = await admin.call("POST", "/api/payouts/settle/", {
      body: { walletId: randomUUID(), earningTransactionIds: [randomUUID()] },
    });
    check(
      "settling without an Idempotency-Key is refused",
      res.status === 400 && res.body?.error?.code === "IDEMPOTENCY_KEY_REQUIRED",
      `got ${res.status} ${res.body?.error?.code}`,
    );
  }

  // =========================================================================
  console.log("\nAn unknown payout rate is said, not guessed");
  // =========================================================================

  {
    const res = await admin.call("POST", "/api/wallet/earnings/", {
      key: randomUUID(),
      body: {
        evaluatorId: evaluator.user.id,
        subject: UNPRICED_SUBJECT,
        classNum: 10,
        pageCount: 4,
      },
    });
    check(
      "no rate configured refuses rather than defaulting",
      res.status === 503 && res.body?.error?.code === "NOT_AVAILABLE",
      `got ${res.status} ${res.body?.error?.code}`,
    );
    check(
      "and says which subject and class need a rate",
      typeof res.body?.error?.message === "string" &&
        res.body.error.message.includes(UNPRICED_SUBJECT),
      res.body?.error?.message,
    );
  }

  // =========================================================================
  console.log("\nThe rate, and the money it produces");
  // =========================================================================

  const SUBJECT = `Ledger Test ${RUN}`;
  const RATE = { basePerScript: "30.00", perPageBooster: "2.50", complexityMultiplier: "1.25" };

  {
    const res = await admin.call("PUT", "/api/wallet/rates/", {
      body: { subject: SUBJECT, classNum: 10, ...RATE },
    });
    check("an admin can set their centre's rate", res.status === 200, `got ${res.status}`);
  }
  {
    const res = await admin.call("PUT", "/api/wallet/rates/", {
      body: { subject: SUBJECT, classNum: 10, basePerScript: 30.1 },
    });
    check(
      "a JSON float is rejected as an amount",
      res.status === 400,
      `got ${res.status} — a double cannot hold 30.10 and must not be accepted as rupees`,
    );
  }
  {
    const res = await admin.call("PUT", "/api/wallet/rates/", {
      body: { subject: SUBJECT, classNum: 10, basePerScript: "30.005" },
    });
    check("a third decimal place is rejected", res.status === 400, `got ${res.status}`);
  }

  // =========================================================================
  console.log("\nA month of earnings, every one of them replayed");
  // =========================================================================

  const earnings = [];
  const DAYS = 30;
  for (let day = 0; day < DAYS; day += 1) {
    // 1..7 pages. Page 5 gives 42.50 × 1.25 = 53.125, which rounds — so the
    // month deliberately contains amounts that a float would get wrong.
    const pageCount = (day % 7) + 1;
    const key = `ledger-test-${RUN}-day-${day}`;
    const body = { evaluatorId: evaluator.user.id, subject: SUBJECT, classNum: 10, pageCount };
    const first = await admin.call("POST", "/api/wallet/earnings/", { key, body });
    const replay = await admin.call("POST", "/api/wallet/earnings/", { key, body });
    if (first.status !== 200) bail(`Recording an earning failed: ${first.status} ${first.text}`);
    earnings.push({
      transactionId: first.body.transactionId,
      pageCount,
      amount: first.body.amount,
      replayedTo: replay.body?.transactionId,
      replayCreated: replay.body?.created,
    });
  }

  const walletId = (await admin.call("GET", "/api/payouts/")).body.wallets.find(
    (w) => w.tutorId === evaluator.user.id,
  )?.walletId;
  if (!walletId) bail("The tutor's wallet did not appear in the centre's payout list.");

  check(
    "a replayed earning returns the first row and writes nothing",
    earnings.every((e) => e.replayedTo === e.transactionId && e.replayCreated === false),
    `${earnings.filter((e) => e.replayCreated !== false).length} of ${DAYS} were written twice`,
  );

  {
    const wrong = earnings.filter(
      (e) =>
        paise(e.amount) !==
        expectedAmount(RATE.basePerScript, RATE.perPageBooster, RATE.complexityMultiplier, e.pageCount),
    );
    check(
      "every amount is (base + perPage × pages) × multiplier, rounded half up",
      wrong.length === 0,
      wrong.map((e) => `${e.pageCount}pp → ${e.amount}`).join(", "),
    );
    const rounded = earnings.filter((e) => e.pageCount === 5);
    check(
      "and 53.125 rounds to 53.13 rather than to 53.12",
      rounded.length > 0 && rounded.every((e) => e.amount === "53.13"),
      rounded.map((e) => e.amount).join(", "),
    );
  }

  // =========================================================================
  console.log("\nBalance is a projection of the entries, not a column");
  // =========================================================================

  const expectedRun = sum(earnings.map((e) => paise(e.amount)));

  async function sqlBalance(id) {
    const rows = await prisma.$queryRaw`
      SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS pending,
             COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::text AS earned,
             COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::text  AS paid
        FROM ledger.journal_lines
       WHERE wallet_id = ${id}::uuid AND account_kind = 'TUTOR_PAYABLE'`;
    return rows[0];
  }

  {
    const api = (await admin.call("GET", `/api/payouts/${walletId}/`)).body;
    const sql = await sqlBalance(walletId);
    check(
      "the API's pending balance equals SUM(credits) − SUM(debits) in SQL",
      paise(api.balance.pending) === paise(sql.pending),
      `api ${api.balance.pending} vs sql ${sql.pending}`,
    );
    check(
      "the pending total equals the sum of the listed pending entries",
      paise(api.pendingTotal) === sum(api.pendingEntries.map((e) => paise(e.amount))),
      api.pendingTotal,
    );
    check(
      "this run's earnings are all present and unpaid",
      sum(
        api.pendingEntries
          .filter((e) => earnings.some((x) => x.transactionId === e.transactionId))
          .map((e) => paise(e.amount)),
      ) === expectedRun,
      `expected ${rupees(expectedRun)}`,
    );
    // There is no `current_balance` column to drift from, which is the point.
    const columns = await prisma.$queryRaw`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'ledger' AND table_name = 'wallets'`;
    check(
      "the wallets table has no stored balance column at all",
      !columns.some((c) => /balance/i.test(c.column_name)),
      columns.map((c) => c.column_name).join(", "),
    );
  }

  // =========================================================================
  console.log("\nSettlement: appended, idempotent, and impossible to run twice");
  // =========================================================================

  const half = earnings.slice(0, 12).map((e) => e.transactionId);
  const halfTotal = sum(earnings.slice(0, 12).map((e) => paise(e.amount)));
  const replayKey = `settle-${RUN}-a`;

  let firstSettlement;
  {
    const res = await admin.call("POST", "/api/payouts/settle/", {
      key: replayKey,
      body: { walletId, earningTransactionIds: half, memo: `test ${RUN}` },
    });
    if (res.status !== 200) bail(`Settlement failed: ${res.status} ${res.text}`);
    firstSettlement = res.body;
    check(
      "a settlement pays exactly the entries it claimed",
      paise(res.body.amountPaid) === halfTotal && res.body.settledTransactionIds.length === 12,
      `${res.body.amountPaid} vs ${rupees(halfTotal)}`,
    );
  }
  {
    const res = await admin.call("POST", "/api/payouts/settle/", {
      key: replayKey,
      body: { walletId, earningTransactionIds: half, memo: `test ${RUN}` },
    });
    check(
      "the same Idempotency-Key replays the same settlement",
      res.status === 200 &&
        res.body.created === false &&
        res.body.settlementTransactionId === firstSettlement.settlementTransactionId &&
        paise(res.body.amountPaid) === halfTotal,
      `${res.status} ${res.body?.amountPaid} ${res.body?.created}`,
    );
    const allocations = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS n FROM ledger.settlement_allocations
       WHERE settlement_tx_id = ${firstSettlement.settlementTransactionId}::uuid`;
    check(
      "and the replay allocated nothing further",
      allocations[0].n === 12,
      `${allocations[0].n} allocations`,
    );
  }
  {
    // Defect 2: a mixed list. Twelve already paid, six not. The specification
    // would have re-stamped all eighteen with a fresh admin and timestamp.
    const mixed = [...half, ...earnings.slice(12, 18).map((e) => e.transactionId)];
    const mixedNew = sum(earnings.slice(12, 18).map((e) => paise(e.amount)));
    const res = await admin.call("POST", "/api/payouts/settle/", {
      key: `settle-${RUN}-mixed`,
      body: { walletId, earningTransactionIds: mixed },
    });
    check(
      "a mixed list pays only the entries that were still unpaid",
      res.status === 200 && paise(res.body.amountPaid) === mixedNew,
      `${res.body?.amountPaid} vs ${rupees(mixedNew)}`,
    );
    check(
      "and names the ones it skipped rather than silently paying them",
      res.body?.skippedTransactionIds?.length === 12,
      `${res.body?.skippedTransactionIds?.length} skipped`,
    );
    const stamps = await prisma.$queryRaw`
      SELECT COUNT(DISTINCT settlement_tx_id)::int AS n
        FROM ledger.settlement_allocations
       WHERE earning_tx_id IN (${half[0]}::uuid, ${half[1]}::uuid)`;
    check(
      "an already-settled earning keeps its original settlement — its audit trail is not overwritten",
      stamps[0].n === 1,
      `${stamps[0].n} distinct settlements claim those earnings`,
    );
  }

  // =========================================================================
  console.log("\nConcurrency: four admins clicking at once");
  // =========================================================================

  {
    const contested = earnings.slice(18, 24).map((e) => e.transactionId);
    const contestedTotal = sum(earnings.slice(18, 24).map((e) => paise(e.amount)));
    const before = await sqlBalance(walletId);

    // Four *different* Idempotency-Keys, so the key-level guard is bypassed on
    // purpose and the outcome rests entirely on the database. This is the
    // check the specification's read-then-write fails.
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        admin.call("POST", "/api/payouts/settle/", {
          key: `settle-${RUN}-race-${n}`,
          body: { walletId, earningTransactionIds: contested },
        }),
      ),
    );

    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status === 409);
    check(
      "exactly one of four concurrent settlements succeeds",
      winners.length === 1,
      `${winners.length} succeeded, ${losers.length} got 409, statuses ${results.map((r) => r.status).join("/")}`,
    );
    check(
      "the losers get 409 CONFLICT, not a 500 a client would retry into a second payout",
      losers.length === 3 && losers.every((r) => r.body?.error?.code === "CONFLICT"),
      losers.map((r) => `${r.status} ${r.body?.error?.code}`).join(", "),
    );

    const after = await sqlBalance(walletId);
    check(
      "the wallet was debited exactly once",
      paise(after.paid) - paise(before.paid) === contestedTotal,
      `moved ${rupees(paise(after.paid) - paise(before.paid))}, expected ${rupees(contestedTotal)}`,
    );

    const allocated = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS n FROM ledger.settlement_allocations
       WHERE earning_tx_id = ANY(${contested}::uuid[])`;
    check(
      "and each contested earning has exactly one allocation",
      allocated[0].n === contested.length,
      `${allocated[0].n} allocations for ${contested.length} earnings`,
    );
  }

  // =========================================================================
  console.log("\nImmutability: the ledger is append-only, and the database says so");
  // =========================================================================

  const sample = earnings[0].transactionId;

  /**
   * Run something the database must refuse, and check it refused *for the
   * stated reason*. A bare "it threw" would pass on a typo in the SQL.
   */
  async function mustRefuse(name, expected, run) {
    try {
      await run();
      check(name, false, "the statement succeeded");
    } catch (err) {
      const message = String(err?.message ?? err);
      check(name, expected.test(message), message.replace(/\s+/g, " ").slice(0, 200));
    }
  }

  const APPEND_ONLY = /append-only|is not permitted/i;
  const UNBALANCED = /unbalanced|double entry needs at least two/i;

  await mustRefuse("an earning transaction cannot be UPDATEd", APPEND_ONLY, () =>
    prisma.$executeRaw`UPDATE ledger.journal_transactions SET memo = 'tampered' WHERE id = ${sample}::uuid`);
  await mustRefuse("an earning transaction cannot be DELETEd", APPEND_ONLY, () =>
    prisma.$executeRaw`DELETE FROM ledger.journal_transactions WHERE id = ${sample}::uuid`);
  await mustRefuse("an earning's amount cannot be UPDATEd", APPEND_ONLY, () =>
    prisma.$executeRaw`UPDATE ledger.journal_lines SET amount = 999999 WHERE transaction_id = ${sample}::uuid`);
  await mustRefuse("a settlement allocation cannot be re-pointed at another payout", APPEND_ONLY, () =>
    prisma.$executeRaw`UPDATE ledger.settlement_allocations SET settlement_tx_id = ${sample}::uuid`);

  // =========================================================================
  console.log("\nDouble entry: nothing unbalanced can be committed");
  // =========================================================================

  {
    const unbalanced = await prisma.$queryRaw`
      SELECT transaction_id::text,
             SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END)::text AS net
        FROM ledger.journal_lines
       GROUP BY transaction_id
      HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) <> 0`;
    check(
      "every transaction's debits equal its credits",
      unbalanced.length === 0,
      unbalanced.map((r) => `${r.transaction_id} off by ${r.net}`).join(", "),
    );

    const net = await prisma.$queryRaw`
      SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0)::text AS net
        FROM ledger.journal_lines`;
    check("the whole journal nets to zero", paise(net[0].net) === 0n, net[0].net);

    const singles = await prisma.$queryRaw`
      SELECT transaction_id::text FROM ledger.journal_lines
       GROUP BY transaction_id HAVING COUNT(*) < 2`;
    check(
      "no transaction has a single line — the counter-account is never missing",
      singles.length === 0,
      singles.map((r) => r.transaction_id).join(", "),
    );

    // The trigger, attempted directly. A lone credit is what the specification's
    // wallet_transactions table stored for every earning it ever recorded.
    await mustRefuse("a lone, uncountered line is rejected at COMMIT", UNBALANCED, async () => {
      await prisma.$transaction(async (tx) => {
        const t = await tx.$queryRaw`
          INSERT INTO ledger.journal_transactions (scope_id, kind, actor_user_id, idempotency_key, memo)
          VALUES (${ADMIN.scopeId}::uuid, 'EARNING', ${admin.user.id}::uuid, ${`probe-${RUN}`}, 'single entry probe')
          RETURNING id::text`;
        await tx.$executeRaw`
          INSERT INTO ledger.journal_lines (transaction_id, scope_id, account_kind, wallet_id, direction, amount)
          VALUES (${t[0].id}::uuid, ${ADMIN.scopeId}::uuid, 'TUTOR_PAYABLE', ${walletId}::uuid, 'CREDIT', 100.00)`;
      });
    });
  }

  // =========================================================================
  console.log("\nNo balance is ever negative");
  // =========================================================================

  {
    const negatives = await prisma.$queryRaw`
      SELECT wallet_id::text,
             SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)::text AS pending
        FROM ledger.journal_lines
       WHERE account_kind = 'TUTOR_PAYABLE'
       GROUP BY wallet_id
      HAVING SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) < 0`;
    check(
      "no wallet in the whole ledger has a negative balance",
      negatives.length === 0,
      negatives.map((r) => `${r.wallet_id} at ${r.pending}`).join(", "),
    );

    // The specification decremented a balance that nothing incremented, so the
    // second payout of the same earnings drove it below zero. Here the same
    // request pays nothing at all.
    const res = await admin.call("POST", "/api/payouts/settle/", {
      key: `settle-${RUN}-overdraw`,
      body: { walletId, earningTransactionIds: half },
    });
    check(
      "re-settling paid entries overdraws nothing and pays nothing",
      res.status === 409,
      `got ${res.status} ${res.body?.error?.code}`,
    );

    const paidTwice = await prisma.$queryRaw`
      SELECT earning_tx_id::text, COUNT(*)::int AS n
        FROM ledger.settlement_allocations
       GROUP BY earning_tx_id HAVING COUNT(*) > 1`;
    check(
      "no earning anywhere has been settled more than once",
      paidTwice.length === 0,
      paidTwice.map((r) => `${r.earning_tx_id} × ${r.n}`).join(", "),
    );
  }

  // =========================================================================
  console.log("\nScope: an admin is an admin of a centre, not of the platform");
  // =========================================================================

  {
    // A wallet belonging to a *different* centre, inserted directly so the test
    // does not depend on a second seeded admin existing.
    await prisma.$executeRaw`
      INSERT INTO ledger.wallets (tutor_id, centre_scope_id)
      VALUES (${evaluator.user.id}::uuid, ${EVALUATOR.scopeId}::uuid)
      ON CONFLICT ON CONSTRAINT wallets_tutor_centre_unique DO NOTHING`;
    const other = await prisma.$queryRaw`
      SELECT id::text FROM ledger.wallets
       WHERE tutor_id = ${evaluator.user.id}::uuid AND centre_scope_id = ${EVALUATOR.scopeId}::uuid`;
    const otherId = other[0].id;

    const read = await admin.call("GET", `/api/payouts/${otherId}/`);
    check(
      "an admin cannot read another centre's wallet",
      read.status === 403,
      `got ${read.status}`,
    );
    const settle = await admin.call("POST", "/api/payouts/settle/", {
      key: `settle-${RUN}-cross`,
      body: { walletId: otherId, earningTransactionIds: [earnings[0].transactionId] },
    });
    check(
      "nor settle against it",
      settle.status === 403,
      `got ${settle.status}`,
    );
    check(
      "and the 403 does not distinguish 'not yours' from 'does not exist'",
      (await admin.call("GET", `/api/payouts/${randomUUID()}/`)).status === 403,
    );

    const list = await admin.call("GET", "/api/payouts/");
    check(
      "the centre's wallet list excludes the other centre's wallet",
      !list.body.wallets.some((w) => w.walletId === otherId),
    );
  }

  // =========================================================================
  console.log("\nThe tutor's own view");
  // =========================================================================

  {
    const res = await evaluator.call("GET", "/api/wallet/");
    const mine = res.body.wallets.find((w) => w.walletId === walletId);
    check("a tutor can read their own wallet", res.status === 200 && Boolean(mine));
    check(
      "and the figures agree with the ledger",
      paise(mine.balance.lifetimeEarned) - paise(mine.balance.lifetimePaid) ===
        paise(mine.balance.pending),
      JSON.stringify(mine.balance),
    );
    check(
      "earned and paid only ever grow, so pending is never a bare subtraction of nothing",
      paise(mine.balance.lifetimeEarned) > 0n && paise(mine.balance.lifetimePaid) > 0n,
      JSON.stringify(mine.balance),
    );
  }

  // -------------------------------------------------------------------------

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
