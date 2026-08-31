/**
 * An immutable, double-entry ledger for tutor earnings and payouts.
 *
 * This is the correction of `executeAdminWalletSettlement` in
 * `CBSE_EdTech_Platform_Technical_Specification.md` §3. That function is the
 * reference implementation of how to lose money, and every defect in it is
 * closed here deliberately rather than incidentally:
 *
 *  1. **The actor came from `req.body`.** Here the actor is `ctx.user` from the
 *     session (docs/PLATFORM.md §1) and is authorised against the *wallet's own*
 *     `centreScopeId`. `settlePayout()` takes an `actor: User` — a Prisma row —
 *     not an id, so there is no id-shaped hole to pass a lie through.
 *  2. **`updateMany` re-stamped rows it never read.** Here the settlement is a
 *     single conditional `INSERT … SELECT … ON CONFLICT DO NOTHING RETURNING`,
 *     and the money paid is the sum of *the rows it actually claimed*, not of
 *     the ids the caller asked for. An already-settled earning is silently not
 *     claimed and cannot be re-stamped, because nothing is ever stamped.
 *  3. **Read-then-write with no locking.** There is no read-then-write. The
 *     claim is one statement, and `UNIQUE(earning_tx_id)` on
 *     `ledger.settlement_allocations` makes a second claim structurally
 *     impossible rather than merely unlikely.
 *  4. **It was not double-entry.** Every transaction here writes at least two
 *     lines whose signed amounts sum to exactly zero, enforced by a DEFERRABLE
 *     CONSTRAINT TRIGGER that fires at COMMIT. An unbalanced transaction cannot
 *     be committed, by anybody, through any code path.
 *  5. **Nothing enforced immutability.** `BEFORE UPDATE OR DELETE` triggers on
 *     all three journal tables raise an exception. Settlement *appends* a
 *     payout transaction; it never touches the earning it pays for.
 *  6. **Balance semantics were undefined.** Defined here, once:
 *
 *         payable(wallet) = Σ credits to TUTOR_PAYABLE − Σ debits to it
 *
 *     Credit on completion, debit on payout. There is no `current_balance`
 *     column anywhere in this module: balance is a projection of the entries,
 *     computed by `SUM`. It cannot drift because there is nothing to drift
 *     from, and it cannot go negative because a payout is only ever assembled
 *     from named, still-unallocated earnings — see `settlePayout()`.
 *
 * ## Money
 *
 * No JS `number` ever holds a rupee. Amounts cross the wire and the module
 * boundary as decimal *strings* ("42.50"), are held in memory as `bigint`
 * paise, and are stored as `NUMERIC(14,2)`. `parseFloat` on a currency is how
 * ₹0.01 goes missing a hundred thousand times.
 *
 * ## Where these tables live, and why they are not in prisma/schema.prisma
 *
 * `prisma/schema.prisma` is frozen for this lane, and says in its own header
 * that "wallets and payouts are deliberately absent". They are absent — there
 * is no `TutorWallet`, no `WalletTransaction`, no `GigPayoutSetting`. So this
 * module owns its own tables in a separate Postgres **schema** called `ledger`,
 * created idempotently by `ensureLedgerSchema()` below.
 *
 * That is a deliberate, reversible, and loudly-declared choice:
 *
 *   - `DATABASE_URL` pins `?schema=public`, so Prisma's migration engine does
 *     not see, diff, or manage anything in `ledger`. No migration is added and
 *     no line of `prisma/schema.prisma` changes.
 *   - There are no cross-schema foreign keys to `public.users`. A FK from
 *     `ledger` into a Prisma-managed table would make `prisma migrate reset`
 *     fail for every other lane, which is a rude thing to do to four people
 *     sharing one database. `tutorId` is validated in application code instead.
 *   - `DROP SCHEMA ledger CASCADE;` removes every trace.
 *
 * The Prisma models this *should* become, when the schema unfreezes, are listed
 * at the bottom of this file.
 */
import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";
import { ApiError, isUniqueViolation } from "@/lib/api";
import prisma from "@/lib/db";

// ---------------------------------------------------------------------------
// Money — bigint paise, decimal strings at the boundary
// ---------------------------------------------------------------------------

/**
 * Rupees, as an exact integer count of paise. Two decimal places is not an
 * assumption about INR: it is `NUMERIC(14,2)` in the tables below, and the
 * conversion here is the only place the two representations meet.
 */
export type Paise = bigint;

/*
 * BigInt literals (`0n`) need an ES2020 target and `tsconfig.json` says ES2017.
 * Bumping a shared compiler target for one module's convenience is not this
 * lane's call, so the handful of constants this file needs are named instead —
 * which reads better in the arithmetic anyway.
 */
const ZERO: Paise = BigInt(0);
const TWO: Paise = BigInt(2);
const PAISE_PER_RUPEE: Paise = BigInt(100);

const DECIMAL_RE = /^-?\d{1,12}(\.\d{1,2})?$/;

/**
 * "42.5" → 4250n. Rejects anything that is not a plain decimal with at most two
 * fractional digits, including `1e3`, `Infinity`, `"42.505"` and `""`. A silent
 * truncation of a third decimal place is a rounding policy nobody chose.
 */
export function paiseFromDecimal(input: string): Paise {
  const s = input.trim();
  if (!DECIMAL_RE.test(s)) {
    throw new ApiError("VALIDATION_FAILED", `"${input}" is not an amount (expected e.g. "42.50")`);
  }
  const negative = s.startsWith("-");
  const bare = negative ? s.slice(1) : s;
  const [whole, frac = ""] = bare.split(".");
  const paise = BigInt(whole) * PAISE_PER_RUPEE + BigInt(frac.padEnd(2, "0"));
  return negative ? -paise : paise;
}

/** 4250n → "42.50". Always two decimal places, so a total never renders as "42.5". */
export function decimalFromPaise(paise: Paise): string {
  const negative = paise < ZERO;
  const abs = negative ? -paise : paise;
  const whole = abs / PAISE_PER_RUPEE;
  const frac = abs % PAISE_PER_RUPEE;
  return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(2, "0")}`;
}

/**
 * Divide, rounding half away from zero — the rule a person doing this on paper
 * uses, and the one an accountant expects. `Math.round` is not available: these
 * are bigints, deliberately.
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= ZERO) throw new Error("divRoundHalfUp: denominator must be positive");
  const negative = numerator < ZERO;
  const abs = negative ? -numerator : numerator;
  const quotient = (abs * TWO + denominator) / (denominator * TWO);
  return negative ? -quotient : quotient;
}

export function sumPaise(values: readonly Paise[]): Paise {
  return values.reduce((total, v) => total + v, ZERO);
}

// ---------------------------------------------------------------------------
// The account structure
// ---------------------------------------------------------------------------

/**
 * Three accounts, which is the fewest that makes the two events balance.
 *
 *   Earning (the tutor finished a script worth ₹42.50):
 *     DEBIT   CENTRE_EXPENSE   42.50   the centre incurred a cost
 *     CREDIT  TUTOR_PAYABLE    42.50   the centre now owes this tutor
 *
 *   Payout (an admin settles ₹42.50):
 *     DEBIT   TUTOR_PAYABLE    42.50   the debt is discharged
 *     CREDIT  CENTRE_CASH      42.50   money left the centre
 *
 * `TUTOR_PAYABLE` is the only account with a wallet: it is credit-normal and it
 * *is* the wallet balance. `CENTRE_EXPENSE` and `CENTRE_CASH` belong to the
 * centre (the scope), which is what makes the spec's missing counter-account
 * present. Reading the journal as a whole, every row nets to zero — which is
 * the property `scripts/test-ledger.mjs` asserts first, because a ledger that
 * does not sum to zero is not a ledger.
 */
export type AccountKind = "CENTRE_EXPENSE" | "TUTOR_PAYABLE" | "CENTRE_CASH";
export type Direction = "DEBIT" | "CREDIT";
export type TransactionKind = "EARNING" | "PAYOUT";

export interface JournalLine {
  accountKind: AccountKind;
  /** Set iff `accountKind === "TUTOR_PAYABLE"`. */
  walletId: string | null;
  direction: Direction;
  /** Always positive. The direction carries the sign. */
  amount: string;
}

export interface Wallet {
  id: string;
  tutorId: string;
  /** The tuition centre that owes the money. Authorisation is against this. */
  centreScopeId: string;
  currency: string;
}

export interface EarningEntry {
  transactionId: string;
  walletId: string;
  subject: string;
  classNum: number;
  pageCount: number;
  ticketId: string | null;
  /** Positive, credit to the tutor. */
  amount: string;
  memo: string | null;
  createdAt: Date;
  /** The payout that settled it, or null while it is still pending. */
  settledByTransactionId: string | null;
  settledAt: Date | null;
}

export interface WalletBalance {
  walletId: string;
  /** Everything ever credited. Never decreases. */
  lifetimeEarned: string;
  /** Everything ever paid out. Never decreases. */
  lifetimePaid: string;
  /** `lifetimeEarned − lifetimePaid`. Provably ≥ 0; see `settlePayout()`. */
  pending: string;
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

/**
 * The whole of the ledger's storage, as one idempotent script.
 *
 * Every statement is `IF NOT EXISTS` or wrapped so a re-run is a no-op, and the
 * whole thing runs under a Postgres advisory lock so that two requests arriving
 * on a cold process cannot race each other through the DDL.
 */
/*
 * Split on `--;;` and run one at a time: Prisma sends raw SQL as a prepared
 * statement, and Postgres refuses more than one command in one of those
 * (`42601: cannot insert multiple commands into a prepared statement`). The
 * delimiter is a comment, so the script also pastes straight into `psql`.
 */
const DDL = `
CREATE SCHEMA IF NOT EXISTS ledger;

--;;
DO $$ BEGIN
  CREATE TYPE ledger.account_kind AS ENUM ('CENTRE_EXPENSE','TUTOR_PAYABLE','CENTRE_CASH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--;;
DO $$ BEGIN
  CREATE TYPE ledger.direction AS ENUM ('DEBIT','CREDIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--;;
DO $$ BEGIN
  CREATE TYPE ledger.transaction_kind AS ENUM ('EARNING','PAYOUT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Subject-specific payout configuration. There is deliberately no row inserted
-- by this script and no fallback in the code that reads it: a missing row means
-- the rate is UNKNOWN, and an unknown rate refuses to produce a number. The
-- specification's "?? 30.00" is the exact thing this omission prevents.
--;;
CREATE TABLE IF NOT EXISTS ledger.payout_settings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id              uuid        NOT NULL,
  subject               varchar(60) NOT NULL,
  class_num             int         NOT NULL,
  base_per_script       numeric(14,2) NOT NULL CHECK (base_per_script >= 0),
  per_page_booster      numeric(14,2) NOT NULL DEFAULT 0 CHECK (per_page_booster >= 0),
  complexity_multiplier numeric(4,2)  NOT NULL DEFAULT 1.00 CHECK (complexity_multiplier > 0),
  currency              char(3)     NOT NULL DEFAULT 'INR',
  set_by_user_id        uuid        NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_settings_unique UNIQUE (scope_id, subject, class_num)
);

--;;
CREATE TABLE IF NOT EXISTS ledger.wallets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- public.users(id). No FK on purpose: a cross-schema FK into a
  -- Prisma-managed table breaks "prisma migrate reset" for every other lane.
  tutor_id        uuid    NOT NULL,
  centre_scope_id uuid    NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'INR',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallets_tutor_centre_unique UNIQUE (tutor_id, centre_scope_id)
);

--;;
CREATE INDEX IF NOT EXISTS wallets_by_centre ON ledger.wallets (centre_scope_id, tutor_id);

--;;
CREATE TABLE IF NOT EXISTS ledger.journal_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id        uuid NOT NULL,
  kind            ledger.transaction_kind NOT NULL,
  -- The session user who caused this. For an EARNING, whoever recorded the
  -- completed work; for a PAYOUT, the admin who settled it. This is the audit
  -- trail the specification overwrote on every re-run of updateMany().
  actor_user_id   uuid NOT NULL,
  idempotency_key varchar(64) NOT NULL,
  memo            varchar(300),
  -- EARNING only: what was graded.
  ticket_id       uuid,
  subject         varchar(60),
  class_num       int,
  page_count      int,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Scoped to the acting user the way docs/PLATFORM.md §5 requires: a key
  -- looked up globally hands one admin another admin's settlement.
  CONSTRAINT journal_tx_idempotent UNIQUE (scope_id, actor_user_id, idempotency_key)
);

--;;
CREATE INDEX IF NOT EXISTS journal_tx_by_scope ON ledger.journal_transactions (scope_id, kind, created_at DESC);

--;;
CREATE TABLE IF NOT EXISTS ledger.journal_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES ledger.journal_transactions(id),
  scope_id       uuid NOT NULL,
  account_kind   ledger.account_kind NOT NULL,
  wallet_id      uuid REFERENCES ledger.wallets(id),
  direction      ledger.direction NOT NULL,
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- A wallet belongs to exactly the payable account, and the payable account
  -- always names a wallet. Anything else is an account with no owner.
  CONSTRAINT line_wallet_matches_account
    CHECK ((account_kind = 'TUTOR_PAYABLE') = (wallet_id IS NOT NULL))
);

--;;
CREATE INDEX IF NOT EXISTS journal_lines_by_tx ON ledger.journal_lines (transaction_id);
--;;
CREATE INDEX IF NOT EXISTS journal_lines_by_wallet ON ledger.journal_lines (wallet_id, direction);

-- One earning is settled at most once, for all time, by anybody. This single
-- unique index is what makes double payment impossible; the locking below is a
-- courtesy that reduces wasted work, not the guarantee.
--;;
CREATE TABLE IF NOT EXISTS ledger.settlement_allocations (
  settlement_tx_id uuid NOT NULL REFERENCES ledger.journal_transactions(id),
  earning_tx_id    uuid NOT NULL REFERENCES ledger.journal_transactions(id),
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (settlement_tx_id, earning_tx_id),
  CONSTRAINT allocation_earning_once UNIQUE (earning_tx_id)
);

-- Immutability, enforced by the database rather than by everyone remembering.
--;;
CREATE OR REPLACE FUNCTION ledger.deny_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION
    'ledger.% is append-only; % is not permitted. Correct an entry by appending a reversing transaction.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $fn$ LANGUAGE plpgsql;

--;;
DO $$ BEGIN
  CREATE TRIGGER journal_transactions_append_only
    BEFORE UPDATE OR DELETE ON ledger.journal_transactions
    FOR EACH ROW EXECUTE FUNCTION ledger.deny_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--;;
DO $$ BEGIN
  CREATE TRIGGER journal_lines_append_only
    BEFORE UPDATE OR DELETE ON ledger.journal_lines
    FOR EACH ROW EXECUTE FUNCTION ledger.deny_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--;;
DO $$ BEGIN
  CREATE TRIGGER settlement_allocations_append_only
    BEFORE UPDATE OR DELETE ON ledger.settlement_allocations
    FOR EACH ROW EXECUTE FUNCTION ledger.deny_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Double entry, enforced at COMMIT. Deferred because the two sides of a
-- transaction are two INSERTs, and the first of them is legitimately unbalanced
-- for the microsecond before the second lands.
--;;
CREATE OR REPLACE FUNCTION ledger.assert_balanced() RETURNS trigger AS $fn$
DECLARE net numeric(14,2);
DECLARE lines int;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0), COUNT(*)
    INTO net, lines
    FROM ledger.journal_lines WHERE transaction_id = NEW.transaction_id;
  IF lines < 2 THEN
    RAISE EXCEPTION 'ledger transaction % has % line(s); double entry needs at least two',
      NEW.transaction_id, lines USING ERRCODE = 'check_violation';
  END IF;
  IF net <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced by %', NEW.transaction_id, net
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

--;;
DO $$ BEGIN
  CREATE CONSTRAINT TRIGGER journal_lines_balanced
    AFTER INSERT ON ledger.journal_lines
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger.assert_balanced();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

/** Arbitrary but fixed: the advisory-lock key this module's DDL serialises on. */
const DDL_LOCK_KEY = BigInt("810542026");

let bootstrap: Promise<void> | null = null;

/**
 * Create the ledger schema if it is not there. Memoised per process, so the
 * cost is one advisory lock on the first ledger request after a deploy.
 */
export function ensureLedgerSchema(): Promise<void> {
  bootstrap ??= (async () => {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DDL_LOCK_KEY}::bigint)`;
        for (const statement of DDL.split("--;;")) {
          const sql = statement.trim();
          if (sql) await tx.$executeRawUnsafe(sql);
        }
      });
    } catch (err) {
      // Do not cache a failed bootstrap: a database that was down at boot must
      // be retried, not remembered as broken for the life of the process.
      bootstrap = null;
      throw err;
    }
  })();
  return bootstrap;
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

interface WalletRow {
  id: string;
  tutor_id: string;
  centre_scope_id: string;
  currency: string;
}

function toWallet(row: WalletRow): Wallet {
  return {
    id: row.id,
    tutorId: row.tutor_id,
    centreScopeId: row.centre_scope_id,
    currency: row.currency.trim(),
  };
}

/**
 * The wallet a tutor holds at one centre, created on first use.
 *
 * A tutor may hold one wallet per centre — the spec's
 * `UNIQUE(tutor_id, center_tenant_id)`, which is the one thing in its wallet
 * table worth keeping. `ON CONFLICT DO NOTHING` plus a read-back rather than a
 * check-then-insert, for the reason docs/PLATFORM.md §5 gives: two requests
 * 30 ms apart both read nothing and both insert.
 */
export async function walletFor(tutorId: string, centreScopeId: string): Promise<Wallet> {
  await ensureLedgerSchema();
  await prisma.$executeRaw`
    INSERT INTO ledger.wallets (tutor_id, centre_scope_id)
    VALUES (${tutorId}::uuid, ${centreScopeId}::uuid)
    ON CONFLICT ON CONSTRAINT wallets_tutor_centre_unique DO NOTHING`;
  const rows = await prisma.$queryRaw<WalletRow[]>`
    SELECT id::text, tutor_id::text, centre_scope_id::text, currency
      FROM ledger.wallets
     WHERE tutor_id = ${tutorId}::uuid AND centre_scope_id = ${centreScopeId}::uuid`;
  if (!rows[0]) throw new ApiError("INTERNAL", "Wallet could not be opened.");
  return toWallet(rows[0]);
}

/**
 * A wallet by id, **only** if it belongs to the given centre.
 *
 * Defect 1. The specification looked wallets up by the ids in the request body
 * and never asked whose they were, so any caller settled anything as anyone.
 * `centreScopeId` here always comes from `actor.scopeId`; there is no overload
 * that takes it from anywhere else.
 *
 * A wallet in another centre and a wallet that does not exist both come back
 * `null`, and callers turn both into the same 403 — a 403 that distinguishes
 * them is a membership oracle (docs/PLATFORM.md §3).
 */
export async function walletInCentre(walletId: string, centreScopeId: string): Promise<Wallet | null> {
  await ensureLedgerSchema();
  const rows = await prisma.$queryRaw<WalletRow[]>`
    SELECT id::text, tutor_id::text, centre_scope_id::text, currency
      FROM ledger.wallets
     WHERE id = ${walletId}::uuid AND centre_scope_id = ${centreScopeId}::uuid`;
  return rows[0] ? toWallet(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Balance — a projection, never a column
// ---------------------------------------------------------------------------

/**
 * Balance is computed from the entries, every time. Defect 6.
 *
 * The specification kept a `current_balance` column that settlement
 * decremented and *nothing* ever incremented, so balances only ever fell and
 * went negative on the second payout. There is no such column here. If this
 * ever needs to be faster than a `SUM` over an indexed wallet, the answer is a
 * materialised projection that is rebuilt from these rows and checked against
 * them — not a number that is edited in place.
 */
export async function walletBalance(walletId: string): Promise<WalletBalance> {
  await ensureLedgerSchema();
  const rows = await prisma.$queryRaw<{ earned: string; paid: string }[]>`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::text AS earned,
      COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'),  0)::text AS paid
    FROM ledger.journal_lines
    WHERE wallet_id = ${walletId}::uuid AND account_kind = 'TUTOR_PAYABLE'`;
  const earned = paiseFromDecimal(rows[0]?.earned ?? "0");
  const paid = paiseFromDecimal(rows[0]?.paid ?? "0");
  return {
    walletId,
    lifetimeEarned: decimalFromPaise(earned),
    lifetimePaid: decimalFromPaise(paid),
    pending: decimalFromPaise(earned - paid),
  };
}

interface EarningRow {
  transaction_id: string;
  wallet_id: string;
  subject: string;
  class_num: number;
  page_count: number;
  ticket_id: string | null;
  amount: string;
  memo: string | null;
  created_at: Date;
  settled_by: string | null;
  settled_at: Date | null;
}

function toEarning(row: EarningRow): EarningEntry {
  return {
    transactionId: row.transaction_id,
    walletId: row.wallet_id,
    subject: row.subject,
    classNum: Number(row.class_num),
    pageCount: Number(row.page_count),
    ticketId: row.ticket_id,
    amount: row.amount,
    memo: row.memo,
    createdAt: row.created_at,
    settledByTransactionId: row.settled_by,
    settledAt: row.settled_at,
  };
}

/** Every earning on a wallet, newest first, each showing whether it is settled. */
export async function earningsFor(
  walletId: string,
  opts: { onlyPending?: boolean; limit?: number } = {},
): Promise<EarningEntry[]> {
  await ensureLedgerSchema();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const rows = await prisma.$queryRaw<EarningRow[]>`
    SELECT t.id::text          AS transaction_id,
           l.wallet_id::text   AS wallet_id,
           t.subject, t.class_num, t.page_count,
           t.ticket_id::text   AS ticket_id,
           l.amount::text      AS amount,
           t.memo, t.created_at,
           a.settlement_tx_id::text AS settled_by,
           s.created_at             AS settled_at
      FROM ledger.journal_lines l
      JOIN ledger.journal_transactions t ON t.id = l.transaction_id
      LEFT JOIN ledger.settlement_allocations a ON a.earning_tx_id = t.id
      LEFT JOIN ledger.journal_transactions s ON s.id = a.settlement_tx_id
     WHERE l.wallet_id = ${walletId}::uuid
       AND l.account_kind = 'TUTOR_PAYABLE'
       AND l.direction = 'CREDIT'
       AND (${opts.onlyPending === true} = false OR a.earning_tx_id IS NULL)
     ORDER BY t.created_at DESC
     LIMIT ${limit}`;
  return rows.map(toEarning);
}

// ---------------------------------------------------------------------------
// Recording an earning — credit on completion
// ---------------------------------------------------------------------------

export interface RecordEarningInput {
  /** From the session. Never from a body. */
  actor: User;
  /** Whose wallet is credited. The subject of the operation, not the actor. */
  tutorId: string;
  /** The centre that owes it — always `actor.scopeId`, passed explicitly to be visible. */
  centreScopeId: string;
  amount: Paise;
  subject: string;
  classNum: number;
  pageCount: number;
  ticketId?: string | null;
  memo?: string | null;
  idempotencyKey: string;
}

export interface RecordedEarning {
  transactionId: string;
  walletId: string;
  amount: string;
  /** False means this was a retry and nothing new was written. */
  created: boolean;
}

/**
 * Credit on completion. One earning, two balanced lines, appended once.
 *
 * The idempotency is the database's, not a pre-flight check: insert the
 * transaction with `ON CONFLICT DO NOTHING` and, if nothing came back, read the
 * winner's row. Two retries 30 ms apart therefore produce one credit and two
 * identical answers.
 *
 * Also usable from Lane E1's ticket-completion path without an HTTP hop — that
 * is why it takes a `User` and an amount rather than a request.
 */
export async function recordEarning(input: RecordEarningInput): Promise<RecordedEarning> {
  if (input.amount <= ZERO) {
    throw new ApiError("VALIDATION_FAILED", "An earning must be a positive amount.");
  }
  await ensureLedgerSchema();
  const wallet = await walletFor(input.tutorId, input.centreScopeId);
  const amount = decimalFromPaise(input.amount);

  return prisma.$transaction(async (tx) => {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO ledger.journal_transactions
        (scope_id, kind, actor_user_id, idempotency_key, memo, ticket_id, subject, class_num, page_count)
      VALUES
        (${input.centreScopeId}::uuid, 'EARNING', ${input.actor.id}::uuid, ${input.idempotencyKey},
         ${input.memo ?? null}, ${input.ticketId ?? null}::uuid, ${input.subject},
         ${input.classNum}, ${input.pageCount})
      ON CONFLICT ON CONSTRAINT journal_tx_idempotent DO NOTHING
      RETURNING id::text`;

    if (!inserted[0]) {
      // A retry. Return what the first attempt wrote, scoped to this actor the
      // way the unique index is.
      const existing = await tx.$queryRaw<{ id: string; amount: string; wallet_id: string }[]>`
        SELECT t.id::text, l.amount::text, l.wallet_id::text
          FROM ledger.journal_transactions t
          JOIN ledger.journal_lines l
            ON l.transaction_id = t.id AND l.account_kind = 'TUTOR_PAYABLE'
         WHERE t.scope_id = ${input.centreScopeId}::uuid
           AND t.actor_user_id = ${input.actor.id}::uuid
           AND t.idempotency_key = ${input.idempotencyKey}`;
      if (!existing[0]) throw new ApiError("CONFLICT", "This key is already in use by a different record.");
      return {
        transactionId: existing[0].id,
        walletId: existing[0].wallet_id,
        amount: existing[0].amount,
        created: false,
      };
    }

    const transactionId = inserted[0].id;
    await tx.$executeRaw`
      INSERT INTO ledger.journal_lines (transaction_id, scope_id, account_kind, wallet_id, direction, amount)
      VALUES
        (${transactionId}::uuid, ${input.centreScopeId}::uuid, 'CENTRE_EXPENSE', NULL, 'DEBIT',  ${amount}::numeric),
        (${transactionId}::uuid, ${input.centreScopeId}::uuid, 'TUTOR_PAYABLE', ${wallet.id}::uuid, 'CREDIT', ${amount}::numeric)`;

    return { transactionId, walletId: wallet.id, amount, created: true };
  });
}

// ---------------------------------------------------------------------------
// Settlement — debit on payout, appended, once, ever
// ---------------------------------------------------------------------------

export interface SettleInput {
  /** From the session. The whole point. */
  actor: User;
  wallet: Wallet;
  /**
   * The earnings the admin ticked. Ids from a request body are fine *here* and
   * only here, because they are filtered in SQL by the wallet and the centre —
   * an id belonging to another centre selects nothing rather than paying it.
   */
  earningTransactionIds: string[];
  idempotencyKey: string;
  memo?: string | null;
}

export interface SettleResult {
  settlementTransactionId: string;
  walletId: string;
  /** The sum of what was actually claimed — not of what was asked for. */
  amountPaid: string;
  settledTransactionIds: string[];
  /** Asked for but not claimed: already settled, or not this wallet's. */
  skippedTransactionIds: string[];
  /** False means this was a retry of a settlement that already happened. */
  created: boolean;
  balanceAfter: WalletBalance;
}

/**
 * Settle a set of earnings. This is the function the specification got wrong
 * six ways; each fix is marked.
 */
export async function settlePayout(input: SettleInput): Promise<SettleResult> {
  const requested = [...new Set(input.earningTransactionIds)];
  if (requested.length === 0) {
    throw new ApiError("VALIDATION_FAILED", "Select at least one entry to settle.");
  }
  // Defect 1, again, belt and braces: the caller has already checked this, but
  // a helper that trusts its caller's authorisation is one refactor away from
  // being called by something that did not check.
  if (input.wallet.centreScopeId !== input.actor.scopeId) {
    throw ApiError.forbidden("You do not have access to this.");
  }
  await ensureLedgerSchema();

  let result: SettlementOutcome;
  try {
    result = await claimAndPay(input, requested);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // `ON CONFLICT DO NOTHING` blocks on a concurrent insert of the same
    // `earning_tx_id` and then does nothing, so the loser of a race normally
    // arrives at the "nothing claimed" branch inside. Should Postgres surface
    // the unique violation itself — a different isolation level, a future index
    // — it means the same thing, and it must not reach a client as a 500 that
    // their retry logic turns into a second payout.
    if (isUniqueViolation(err, "allocation_earning_once") || rawUniqueViolation(err)) {
      throw new ApiError("CONFLICT", NOTHING_SETTLED);
    }
    throw err;
  }

  return {
    ...result,
    walletId: input.wallet.id,
    balanceAfter: await walletBalance(input.wallet.id),
  };
}

const NOTHING_SETTLED =
  "Nothing was settled: every entry selected has already been paid, or does not belong to this wallet.";

type SettlementOutcome = Omit<SettleResult, "walletId" | "balanceAfter">;

/**
 * The whole settlement, in one database transaction. Split out of
 * `settlePayout` only so the error mapping above reads as one thing.
 */
async function claimAndPay(input: SettleInput, requested: string[]): Promise<SettlementOutcome> {
  const ids = Prisma.join(requested.map((id) => Prisma.sql`${id}::uuid`));

  return prisma.$transaction(async (tx) => {
    // ---- Idempotency, layer 1: the same key twice is one settlement. -------
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO ledger.journal_transactions
        (scope_id, kind, actor_user_id, idempotency_key, memo)
      VALUES
        (${input.actor.scopeId}::uuid, 'PAYOUT', ${input.actor.id}::uuid, ${input.idempotencyKey},
         ${input.memo ?? null})
      ON CONFLICT ON CONSTRAINT journal_tx_idempotent DO NOTHING
      RETURNING id::text`;

    if (!inserted[0]) {
      const replay = await tx.$queryRaw<
        { id: string; amount: string; earning_tx_id: string }[]
      >`
        SELECT t.id::text,
               COALESCE(l.amount, 0)::text AS amount,
               a.earning_tx_id::text
          FROM ledger.journal_transactions t
          LEFT JOIN ledger.journal_lines l
            ON l.transaction_id = t.id AND l.account_kind = 'TUTOR_PAYABLE' AND l.direction = 'DEBIT'
          LEFT JOIN ledger.settlement_allocations a ON a.settlement_tx_id = t.id
         WHERE t.scope_id = ${input.actor.scopeId}::uuid
           AND t.actor_user_id = ${input.actor.id}::uuid
           AND t.idempotency_key = ${input.idempotencyKey}`;
      if (!replay[0]) throw new ApiError("CONFLICT", "This key is already in use by a different record.");
      const settled = replay.map((r) => r.earning_tx_id).filter((id): id is string => id !== null);
      return {
        settlementTransactionId: replay[0].id,
        amountPaid: replay[0].amount,
        settledTransactionIds: settled,
        skippedTransactionIds: requested.filter((id) => !settled.includes(id)),
        created: false,
      };
    }

    const settlementId = inserted[0].id;

    // ---- Reduce contention. Not the guarantee; see below. ------------------
    // Defect 3's stated fix. Locking the candidate earning rows in a stable
    // order means two admins clicking at once queue rather than collide. It is
    // deliberately *not* what makes the outcome correct: `FOR UPDATE` does not
    // re-check the LEFT JOIN's nullability after the lock is granted, so both
    // sessions can still believe an earning is unallocated. The unique index
    // below is what actually decides.
    await tx.$queryRaw`
      SELECT t.id
        FROM ledger.journal_transactions t
       WHERE t.id IN (${ids})
         AND t.kind = 'EARNING'
         AND t.scope_id = ${input.actor.scopeId}::uuid
       ORDER BY t.id
         FOR UPDATE`;

    // ---- Defects 2, 3 and 6: one conditional statement claims the rows. ----
    // The specification wrote back against the caller's raw `transactionIds`,
    // so an already-paid row was re-stamped with a new admin and timestamp and
    // its audit trail destroyed by the only function that ever touched it.
    // Here nothing is stamped: the claim is an INSERT, `ON CONFLICT DO NOTHING`
    // drops anything already allocated, and `RETURNING` hands back exactly the
    // rows this request won. Everything downstream is computed from those.
    //
    // The WHERE also pins wallet and centre, so an id from another centre
    // pasted into the body selects nothing rather than paying it.
    const claimed = await tx.$queryRaw<{ earning_tx_id: string; amount: string }[]>`
      INSERT INTO ledger.settlement_allocations (settlement_tx_id, earning_tx_id, amount)
      SELECT ${settlementId}::uuid, t.id, l.amount
        FROM ledger.journal_transactions t
        JOIN ledger.journal_lines l
          ON l.transaction_id = t.id
         AND l.account_kind = 'TUTOR_PAYABLE'
         AND l.direction = 'CREDIT'
       WHERE t.id IN (${ids})
         AND t.kind = 'EARNING'
         AND t.scope_id = ${input.actor.scopeId}::uuid
         AND l.wallet_id = ${input.wallet.id}::uuid
      ON CONFLICT ON CONSTRAINT allocation_earning_once DO NOTHING
      RETURNING earning_tx_id::text, amount::text`;

    if (claimed.length === 0) {
      // Nothing was won. Roll back so this request does not leave an empty
      // payout transaction behind — and so the idempotency key stays free for
      // a genuine retry rather than being burnt by a race it lost.
      throw new ApiError("CONFLICT", NOTHING_SETTLED);
    }

    const total = sumPaise(claimed.map((row) => paiseFromDecimal(row.amount)));
    const amountPaid = decimalFromPaise(total);

    // ---- Defects 4 and 5: append two balanced lines. -----------------------
    // Nothing above this point modified the earning. The earning is untouched
    // and untouchable; the payout is a new transaction that references it.
    await tx.$executeRaw`
      INSERT INTO ledger.journal_lines (transaction_id, scope_id, account_kind, wallet_id, direction, amount)
      VALUES
        (${settlementId}::uuid, ${input.actor.scopeId}::uuid, 'TUTOR_PAYABLE', ${input.wallet.id}::uuid, 'DEBIT', ${amountPaid}::numeric),
        (${settlementId}::uuid, ${input.actor.scopeId}::uuid, 'CENTRE_CASH', NULL, 'CREDIT', ${amountPaid}::numeric)`;

    // ---- Defect 6: a balance that cannot go negative, checked before commit.
    // The structural argument is that a payout is assembled only from named,
    // still-unallocated earnings, each allocatable once, so
    // `pending = Σ unallocated earnings ≥ 0`. This assertion is the seatbelt:
    // it runs inside the same transaction, so a future adjustment path that
    // breaks the argument rolls back rather than overdrawing a tutor.
    const after = await tx.$queryRaw<{ pending: string }[]>`
      SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS pending
        FROM ledger.journal_lines
       WHERE wallet_id = ${input.wallet.id}::uuid AND account_kind = 'TUTOR_PAYABLE'`;
    if (paiseFromDecimal(after[0]?.pending ?? "0") < ZERO) {
      throw new ApiError("CONFLICT", "That settlement would overdraw the wallet.");
    }

    const settledTransactionIds = claimed.map((row) => row.earning_tx_id);
    return {
      settlementTransactionId: settlementId,
      amountPaid,
      settledTransactionIds,
      skippedTransactionIds: requested.filter((id) => !settledTransactionIds.includes(id)),
      created: true,
    };
  });
}

/**
 * Prisma reports a unique violation raised inside `$queryRaw` as P2010 carrying
 * the bare SQLSTATE, not as the P2002 that `isUniqueViolation` recognises.
 */
function rawUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2010") return false;
  const meta = err.meta as { code?: string; message?: string } | undefined;
  return meta?.code === "23505" || (meta?.message ?? "").includes("allocation_earning_once");
}


// ---------------------------------------------------------------------------
// Centre-wide views
// ---------------------------------------------------------------------------

export interface CentreWalletRow {
  wallet: Wallet;
  tutorName: string | null;
  tutorPhone: string;
  pendingEntryCount: number;
  balance: WalletBalance;
}

/**
 * Every wallet the acting admin's centre owes into, with what is pending.
 *
 * Scoped by `centreScopeId` even though almost every seeded row sits on the nil
 * UUID today — the day it does not, an unscoped query here is the one that
 * shows one tuition centre another centre's payroll.
 */
export async function centreWallets(centreScopeId: string): Promise<CentreWalletRow[]> {
  await ensureLedgerSchema();
  const rows = await prisma.$queryRaw<
    {
      id: string;
      tutor_id: string;
      centre_scope_id: string;
      currency: string;
      earned: string;
      paid: string;
      pending_count: number;
    }[]
  >`
    SELECT w.id::text, w.tutor_id::text, w.centre_scope_id::text, w.currency,
           COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'CREDIT'), 0)::text AS earned,
           COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'DEBIT'),  0)::text AS paid,
           COUNT(*) FILTER (WHERE l.direction = 'CREDIT' AND a.earning_tx_id IS NULL)::int AS pending_count
      FROM ledger.wallets w
      LEFT JOIN ledger.journal_lines l
        ON l.wallet_id = w.id AND l.account_kind = 'TUTOR_PAYABLE'
      LEFT JOIN ledger.settlement_allocations a
        ON a.earning_tx_id = l.transaction_id AND l.direction = 'CREDIT'
     WHERE w.centre_scope_id = ${centreScopeId}::uuid
     GROUP BY w.id, w.tutor_id, w.centre_scope_id, w.currency
     ORDER BY 5 DESC`;

  if (rows.length === 0) return [];

  const tutors = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.tutor_id) } },
    select: { id: true, displayName: true, phone: true },
  });
  const byId = new Map(tutors.map((t) => [t.id, t]));

  return rows.map((row) => {
    const earned = paiseFromDecimal(row.earned);
    const paid = paiseFromDecimal(row.paid);
    const tutor = byId.get(row.tutor_id);
    return {
      wallet: toWallet(row),
      tutorName: tutor?.displayName ?? null,
      // A deleted user leaves a wallet that still owes money. Say so rather
      // than dropping the row and losing the debt from the total.
      tutorPhone: tutor?.phone ?? "(account removed)",
      pendingEntryCount: Number(row.pending_count),
      balance: {
        walletId: row.id,
        lifetimeEarned: decimalFromPaise(earned),
        lifetimePaid: decimalFromPaise(paid),
        pending: decimalFromPaise(earned - paid),
      },
    };
  });
}

export interface TutorWalletRow {
  wallet: Wallet;
  balance: WalletBalance;
  pendingEntryCount: number;
}

/**
 * Every wallet one tutor holds, across every centre they work for.
 *
 * Keyed on the tutor id from the *session*, never from a query parameter: a
 * `?tutorId=` here would let any signed-in user read any colleague's pay.
 */
export async function tutorWallets(tutorId: string): Promise<TutorWalletRow[]> {
  await ensureLedgerSchema();
  const rows = await prisma.$queryRaw<
    {
      id: string;
      tutor_id: string;
      centre_scope_id: string;
      currency: string;
      earned: string;
      paid: string;
      pending_count: number;
    }[]
  >`
    SELECT w.id::text, w.tutor_id::text, w.centre_scope_id::text, w.currency,
           COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'CREDIT'), 0)::text AS earned,
           COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'DEBIT'),  0)::text AS paid,
           COUNT(*) FILTER (WHERE l.direction = 'CREDIT' AND a.earning_tx_id IS NULL)::int AS pending_count
      FROM ledger.wallets w
      LEFT JOIN ledger.journal_lines l
        ON l.wallet_id = w.id AND l.account_kind = 'TUTOR_PAYABLE'
      LEFT JOIN ledger.settlement_allocations a
        ON a.earning_tx_id = l.transaction_id AND l.direction = 'CREDIT'
     WHERE w.tutor_id = ${tutorId}::uuid
     GROUP BY w.id, w.tutor_id, w.centre_scope_id, w.currency
     ORDER BY w.created_at`;

  return rows.map((row) => {
    const earned = paiseFromDecimal(row.earned);
    const paid = paiseFromDecimal(row.paid);
    return {
      wallet: toWallet(row),
      pendingEntryCount: Number(row.pending_count),
      balance: {
        walletId: row.id,
        lifetimeEarned: decimalFromPaise(earned),
        lifetimePaid: decimalFromPaise(paid),
        pending: decimalFromPaise(earned - paid),
      },
    };
  });
}

/**
 * The whole journal nets to zero. Cheap enough to expose as a health check and
 * exactly the invariant `scripts/test-ledger.mjs` leans on.
 */
export async function journalNet(): Promise<string> {
  await ensureLedgerSchema();
  const rows = await prisma.$queryRaw<{ net: string }[]>`
    SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0)::text AS net
      FROM ledger.journal_lines`;
  // Normalised through the money parser so it is always "0.00" and never "0":
  // COALESCE(…, 0) comes back as an integer when the journal is empty, and a
  // caller comparing against "0.00" would read an empty ledger as broken.
  return decimalFromPaise(paiseFromDecimal(rows[0]?.net ?? "0"));
}

// ---------------------------------------------------------------------------
// What this needs from prisma/schema.prisma, when it unfreezes
// ---------------------------------------------------------------------------
//
// The schema is frozen for this lane and has no wallet models at all — its own
// header says "wallets and payouts are deliberately absent", and there is no
// `TutorWallet`, `WalletTransaction` or `GigPayoutSetting` to be insufficient.
// The five models below are what the tables above should become. They are
// written out here rather than in a report that gets lost:
//
//   model TutorWallet {
//     id            String   @id @default(uuid()) @db.Uuid
//     tutorId       String   @db.Uuid
//     tutor         User     @relation(fields: [tutorId], references: [id], onDelete: Restrict)
//     centreScopeId String   @db.Uuid          // the centre that owes, not the tutor's own scope
//     currency      String   @default("INR") @db.Char(3)
//     createdAt     DateTime @default(now()) @db.Timestamptz(6)
//     @@unique([tutorId, centreScopeId])
//     @@index([centreScopeId])
//   }
//   // No `currentBalance`. Balance is Σ(lines). See defect 6 above.
//
//   model LedgerTransaction {
//     id             String   @id @default(uuid()) @db.Uuid
//     scopeId        String   @db.Uuid
//     kind           LedgerTransactionKind          // EARNING | PAYOUT
//     actorUserId    String   @db.Uuid              // session user; never a body field
//     idempotencyKey String   @db.VarChar(64)
//     memo           String?  @db.VarChar(300)
//     ticketId       String?  @db.Uuid
//     subject        String?  @db.VarChar(60)
//     classNum       Int?
//     pageCount      Int?
//     createdAt      DateTime @default(now()) @db.Timestamptz(6)
//     lines          LedgerLine[]
//     @@unique([scopeId, actorUserId, idempotencyKey])
//     // deliberately no updatedAt
//   }
//
//   model LedgerLine {
//     id            String   @id @default(uuid()) @db.Uuid
//     transactionId String   @db.Uuid
//     scopeId       String   @db.Uuid
//     accountKind   LedgerAccountKind              // CENTRE_EXPENSE | TUTOR_PAYABLE | CENTRE_CASH
//     walletId      String?  @db.Uuid
//     direction     LedgerDirection                // DEBIT | CREDIT
//     amount        Decimal  @db.Decimal(14, 2)
//     createdAt     DateTime @default(now()) @db.Timestamptz(6)
//     @@index([walletId, direction])
//   }
//
//   model SettlementAllocation {
//     settlementTxId String  @db.Uuid
//     earningTxId    String  @unique @db.Uuid      // <- the whole guarantee
//     amount         Decimal @db.Decimal(14, 2)
//     @@id([settlementTxId, earningTxId])
//   }
//
//   model PayoutSetting {
//     id                   String   @id @default(uuid()) @db.Uuid
//     scopeId              String   @db.Uuid
//     subject              String   @db.VarChar(60)
//     classNum             Int
//     basePerScript        Decimal  @db.Decimal(14, 2)
//     perPageBooster       Decimal  @default(0) @db.Decimal(14, 2)
//     complexityMultiplier Decimal  @default(1.00) @db.Decimal(4, 2)
//     setByUserId          String   @db.Uuid
//     updatedAt            DateTime @updatedAt @db.Timestamptz(6)
//     @@unique([scopeId, subject, classNum])
//   }
//
// Four things Prisma cannot express and the migration must add by hand, all of
// them load-bearing rather than decorative — they are in the DDL above:
//
//   1. BEFORE UPDATE OR DELETE triggers on the three journal tables. Without
//      them "immutable" is a comment.
//   2. The DEFERRABLE CONSTRAINT TRIGGER asserting each transaction's lines sum
//      to zero and number at least two.
//   3. CHECK ((accountKind = 'TUTOR_PAYABLE') = (walletId IS NOT NULL)).
//   4. CHECK (amount > 0) on lines and allocations — the direction carries the
//      sign, so a negative amount is a second, contradictory way to say the
//      same thing.
