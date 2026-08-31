/**
 * What a graded script is worth, per subject and class.
 *
 * The PRD asks for earnings "based on subject-specific configuration", so the
 * rate is data, not a constant. The formula is the specification's own:
 *
 *     amount = (basePerScript + perPageBooster × pages) × complexityMultiplier
 *
 * evaluated entirely in integer paise, rounded half away from zero once at the
 * end. No JS `number` holds a rupee at any point, including the multiplier —
 * which is carried as hundredths, so `1.25` is `125n` and the multiply is
 * exact rather than 1.2499999999999998.
 *
 * ## The unknown rate
 *
 * The specification ends its routing controller with:
 *
 *     baseBounty: pricingRules?.basePayoutPerScript ?? 30.00
 *
 * That `?? 30.00` is the defect this module exists to not have. It converts "no
 * one has decided what Class 9 Hindi is worth at this centre" into "₹30.00",
 * and ₹30.00 is indistinguishable, three months later, from a rate somebody
 * chose. Every tutor paid under it was paid a placeholder, and nothing in the
 * data says so.
 *
 * So `rateFor()` returns a discriminated result, not a number:
 *
 *     { known: true,  rate, amount }        a rate exists; here is the money
 *     { known: false, scopeId, subject, classNum }   nobody has set one
 *
 * There is no default, no fallback row seeded, and no overload that supplies
 * one. An earning cannot be recorded against an unknown rate — the route
 * refuses with 503 `NOT_AVAILABLE`, the same shape `src/lib/storage.ts` uses for
 * an unconfigured driver, and `WalletSummary` renders the work as "awaiting a
 * rate" rather than as zero. Zero is a number someone acts on; "awaiting a
 * rate" is a job for an administrator.
 */
import { ApiError } from "@/lib/api";
import prisma from "@/lib/db";
import {
  decimalFromPaise,
  divRoundHalfUp,
  ensureLedgerSchema,
  paiseFromDecimal,
  type Paise,
} from "@/lib/ledger";

/* See the note in src/lib/ledger.ts: the tsconfig target is ES2017, so no `0n`. */
const ZERO = BigInt(0);
const HUNDRED = BigInt(100);
/** 9.99 in hundredths — a multiplier of ten or more is a typo, not a policy. */
const MAX_MULTIPLIER = BigInt(999);

export interface PayoutRate {
  scopeId: string;
  subject: string;
  classNum: number;
  /** Decimal strings, as stored. */
  basePerScript: string;
  perPageBooster: string;
  /** Two decimal places, e.g. "1.25". Applied last. */
  complexityMultiplier: string;
  currency: string;
  setByUserId: string;
  updatedAt: Date;
}

export type RateLookup =
  | { known: true; rate: PayoutRate }
  | { known: false; scopeId: string; subject: string; classNum: number };

interface RateRow {
  scope_id: string;
  subject: string;
  class_num: number;
  base_per_script: string;
  per_page_booster: string;
  complexity_multiplier: string;
  currency: string;
  set_by_user_id: string;
  updated_at: Date;
}

function toRate(row: RateRow): PayoutRate {
  return {
    scopeId: row.scope_id,
    subject: row.subject,
    classNum: Number(row.class_num),
    basePerScript: row.base_per_script,
    perPageBooster: row.per_page_booster,
    complexityMultiplier: row.complexity_multiplier,
    currency: row.currency.trim(),
    setByUserId: row.set_by_user_id,
    updatedAt: row.updated_at,
  };
}

/**
 * The rate for one (centre, subject, class), or an explicit "not known".
 *
 * The lookup is exact. It deliberately does not fall back to a centre-wide
 * rate, a global rate, or the other class's rate: each of those is a guess
 * wearing a lookup's clothes, and a tutor's pay is not the place for one.
 */
export async function rateFor(
  scopeId: string,
  subject: string,
  classNum: number,
): Promise<RateLookup> {
  await ensureLedgerSchema();
  const rows = await prisma.$queryRaw<RateRow[]>`
    SELECT scope_id::text, subject, class_num,
           base_per_script::text, per_page_booster::text, complexity_multiplier::text,
           currency, set_by_user_id::text, updated_at
      FROM ledger.payout_settings
     WHERE scope_id = ${scopeId}::uuid AND subject = ${subject} AND class_num = ${classNum}`;
  if (!rows[0]) return { known: false, scopeId, subject, classNum };
  return { known: true, rate: toRate(rows[0]) };
}

/** Every rate this centre has set, for the admin's configuration screen. */
export async function ratesForCentre(scopeId: string): Promise<PayoutRate[]> {
  await ensureLedgerSchema();
  const rows = await prisma.$queryRaw<RateRow[]>`
    SELECT scope_id::text, subject, class_num,
           base_per_script::text, per_page_booster::text, complexity_multiplier::text,
           currency, set_by_user_id::text, updated_at
      FROM ledger.payout_settings
     WHERE scope_id = ${scopeId}::uuid
     ORDER BY subject, class_num`;
  return rows.map(toRate);
}

/**
 * `(base + perPage × pages) × multiplier`, in paise, exactly.
 *
 * The multiplier is `NUMERIC(4,2)`, so it is an integer number of hundredths;
 * multiplying by it and dividing by 100 with half-up rounding is the whole
 * operation. Rounding happens once, at the end — rounding the booster and then
 * the multiplier separately loses a paisa per script, which is a rupee per
 * hundred scripts and an argument per month.
 */
export function amountForScript(rate: PayoutRate, pageCount: number): Paise {
  if (!Number.isInteger(pageCount) || pageCount < 0) {
    throw new ApiError("VALIDATION_FAILED", "pageCount must be a whole number of pages.");
  }
  const base = paiseFromDecimal(rate.basePerScript);
  const perPage = paiseFromDecimal(rate.perPageBooster);
  const multiplierHundredths = paiseFromDecimal(rate.complexityMultiplier);
  const beforeMultiplier = base + perPage * BigInt(pageCount);
  return divRoundHalfUp(beforeMultiplier * multiplierHundredths, HUNDRED);
}

export interface QuotedAmount {
  amount: Paise;
  /** The same figure as a decimal string, for display and for the wire. */
  amountDecimal: string;
  rate: PayoutRate;
  /** How the number was reached, so an admin can check it without a calculator. */
  workings: string;
}

/**
 * Price one script, or throw the 503 that says nobody has set a rate.
 *
 * `NOT_AVAILABLE` rather than `NOT_FOUND` on purpose: the request is
 * well-formed and the caller is entitled to make it. What is missing is a
 * configuration an administrator has to supply, which is the same situation as
 * an unconfigured storage driver and deserves the same, actionable code.
 */
export async function quoteScript(
  scopeId: string,
  subject: string,
  classNum: number,
  pageCount: number,
): Promise<QuotedAmount> {
  const lookup = await rateFor(scopeId, subject, classNum);
  if (!lookup.known) {
    throw new ApiError(
      "NOT_AVAILABLE",
      `No payout rate is set for ${subject}, Class ${classNum} at this centre. ` +
        `Set one at /clearance before recording earnings — this deliberately has no default, ` +
        `because a default rate is indistinguishable later from a rate someone chose.`,
    );
  }
  const rate = lookup.rate;
  const amount = amountForScript(rate, pageCount);
  return {
    amount,
    amountDecimal: decimalFromPaise(amount),
    rate,
    workings:
      `(${rate.basePerScript} base + ${rate.perPageBooster} × ${pageCount} pages)` +
      ` × ${rate.complexityMultiplier} = ${decimalFromPaise(amount)}`,
  };
}

export interface SetRateInput {
  /** From the session. The centre whose rates these are. */
  scopeId: string;
  actorUserId: string;
  subject: string;
  classNum: number;
  basePerScript: string;
  perPageBooster: string;
  complexityMultiplier: string;
}

/**
 * Set or change one rate.
 *
 * This is an ordinary upsert and not part of the ledger: a rate is a policy,
 * not an entry, and changing it must not restate what was already earned. The
 * amount is frozen into the journal line when the earning is recorded, so a
 * tutor who worked in March under the March rate stays paid at it however many
 * times the rate is edited afterwards. `set_by_user_id` records who last
 * changed it, which is the audit question anyone actually asks of this table.
 */
export async function setRate(input: SetRateInput): Promise<PayoutRate> {
  await ensureLedgerSchema();
  // Validate through the money parser rather than a regex here, so "30.005"
  // and "1e3" are rejected in exactly one place in this codebase.
  const base = paiseFromDecimal(input.basePerScript);
  const booster = paiseFromDecimal(input.perPageBooster);
  const multiplier = paiseFromDecimal(input.complexityMultiplier);
  if (base < ZERO || booster < ZERO) {
    throw new ApiError("VALIDATION_FAILED", "A payout rate cannot be negative.");
  }
  if (multiplier <= ZERO) {
    throw new ApiError("VALIDATION_FAILED", "The complexity multiplier must be greater than zero.");
  }
  if (multiplier > MAX_MULTIPLIER) {
    throw new ApiError("VALIDATION_FAILED", "The complexity multiplier must be below 10.00.");
  }

  const rows = await prisma.$queryRaw<RateRow[]>`
    INSERT INTO ledger.payout_settings
      (scope_id, subject, class_num, base_per_script, per_page_booster, complexity_multiplier, set_by_user_id, updated_at)
    VALUES
      (${input.scopeId}::uuid, ${input.subject}, ${input.classNum},
       ${decimalFromPaise(base)}::numeric, ${decimalFromPaise(booster)}::numeric,
       ${decimalFromPaise(multiplier)}::numeric, ${input.actorUserId}::uuid, now())
    ON CONFLICT ON CONSTRAINT payout_settings_unique DO UPDATE
      SET base_per_script       = EXCLUDED.base_per_script,
          per_page_booster      = EXCLUDED.per_page_booster,
          complexity_multiplier = EXCLUDED.complexity_multiplier,
          set_by_user_id        = EXCLUDED.set_by_user_id,
          updated_at            = now()
    RETURNING scope_id::text, subject, class_num,
              base_per_script::text, per_page_booster::text, complexity_multiplier::text,
              currency, set_by_user_id::text, updated_at`;
  if (!rows[0]) throw new ApiError("INTERNAL", "The rate could not be saved.");
  return toRate(rows[0]);
}
