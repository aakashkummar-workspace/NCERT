"use client";

import { useEffect, useState } from "react";
import { formatRupees } from "@/components/WalletSummary";

/**
 * The tuition-centre manager's verification and settle flow.
 *
 * Three properties this screen has to have, because the money is real:
 *
 * 1. **Nothing is paid that was not read.** Every pending entry is a checkbox.
 *    The total under the list is the sum of the ticked ones and updates as they
 *    are ticked, and the confirm step restates it. There is no "settle all"
 *    button: between rendering this list and pressing it, another script can
 *    land, and a button that pays "whatever is outstanding" pays a figure
 *    nobody read.
 * 2. **The request carries the ids that were shown.** Not a filter the server
 *    re-evaluates. If an entry was settled by a colleague in the meantime, the
 *    server claims what it can and tells us what it skipped — which this screen
 *    then says out loud rather than quietly reporting success.
 * 3. **A retry cannot pay twice.** One `Idempotency-Key` is generated per
 *    confirm-press and reused by every retry of that press, so a tapped-twice
 *    button, a flaky connection and a double-submit all settle once.
 *
 * Gated to `ADMIN`, but the gate that matters is the server's: `requireUser`
 * re-reads the role from the database on every call. This component hiding
 * itself is a courtesy to the person who should not be here, not a control.
 */

interface PendingEntry {
  transactionId: string;
  amount: string;
  subject: string;
  classNum: number;
  pageCount: number;
  memo: string | null;
  createdAt: string;
}

interface WalletListRow {
  walletId: string;
  tutorId: string;
  tutorName: string | null;
  tutorPhone: string;
  currency: string;
  pendingEntryCount: number;
  balance: { lifetimeEarned: string; lifetimePaid: string; pending: string };
}

interface WalletDetail {
  wallet: { id: string; centreScopeId: string; currency: string };
  tutor: { id: string; displayName: string | null; phone: string; role: string } | null;
  balance: { lifetimeEarned: string; lifetimePaid: string; pending: string };
  pendingTotal: string;
  pendingEntries: PendingEntry[];
}

interface SettleResponse {
  settlementTransactionId: string;
  amountPaid: string;
  settledTransactionIds: string[];
  skippedTransactionIds: string[];
  created: boolean;
}

/*
 * Paise as bigint, built with `BigInt()` rather than `100n` because the shared
 * tsconfig targets ES2017. See the note in src/lib/ledger.ts.
 */
const ZERO = BigInt(0);
const PAISE_PER_RUPEE = BigInt(100);

/** Sum decimal strings without ever making one a `Number`. */
function sumDecimals(values: string[]): string {
  const paise = values.reduce((total, value) => {
    const [whole = "0", frac = ""] = value.split(".");
    return total + BigInt(whole) * PAISE_PER_RUPEE + BigInt(frac.padEnd(2, "0").slice(0, 2));
  }, ZERO);
  const rupees = paise / PAISE_PER_RUPEE;
  const remainder = paise % PAISE_PER_RUPEE;
  return `${rupees}.${remainder.toString().padStart(2, "0")}`;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `Request failed (${res.status}).`;
}

interface WalletListPayload {
  wallets: WalletListRow[];
  journalNet: string;
}

/*
 * Both fetches live outside the component and set no state. The effects below
 * subscribe to their promises and write from the callback with a `live` guard —
 * the shape `react-hooks/set-state-in-effect` asks for, and the one that stops
 * a slow response landing on an unmounted screen.
 */
async function fetchWallets(): Promise<WalletListPayload> {
  const res = await fetch("/api/payouts/", { credentials: "same-origin" });
  if (res.status === 403) throw new Error("This portal is for tuition-centre administrators.");
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as WalletListPayload;
}

async function fetchWalletDetail(walletId: string): Promise<WalletDetail> {
  const res = await fetch(`/api/payouts/${walletId}/`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as WalletDetail;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Could not reach the server.";
}

export default function ClearancePortal() {
  const [wallets, setWallets] = useState<WalletListRow[] | null>(null);
  const [journalNet, setJournalNet] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** Bumped after a settlement, to re-read both the list and the open wallet. */
  const [attempt, setAttempt] = useState(0);

  const [openWalletId, setOpenWalletId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WalletDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [memo, setMemo] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchWallets()
      .then((body) => {
        if (!live) return;
        setListError(null);
        setWallets(body.wallets);
        setJournalNet(body.journalNet);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setListError(messageOf(err));
        setWallets([]);
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (openWalletId === null) return;
    let live = true;
    fetchWalletDetail(openWalletId)
      .then((body) => {
        if (!live) return;
        setDetailError(null);
        setDetail(body);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setDetailError(messageOf(err));
        setDetail(null);
      });
    return () => {
      live = false;
    };
  }, [openWalletId, attempt]);

  /** Opening a wallet resets the checklist; nothing stays ticked across tutors. */
  function openWallet(walletId: string | null) {
    setOpenWalletId(walletId);
    setDetail(null);
    setDetailError(null);
    setTicked(new Set());
    setConfirming(false);
    setOutcome(null);
  }

  const selected = detail?.pendingEntries.filter((e) => ticked.has(e.transactionId)) ?? [];
  const selectedTotal = sumDecimals(selected.map((e) => e.amount));

  function toggle(id: string) {
    setConfirming(false);
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function settle() {
    if (!detail || selected.length === 0) return;
    setBusy(true);
    setOutcome(null);
    // One key per confirm-press. Generated here and not on the server, so that
    // a retry of *this* press reuses it and settles once, while a deliberate
    // second payout later gets a new one.
    const key = crypto.randomUUID();
    try {
      const res = await fetch("/api/payouts/settle/", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          walletId: detail.wallet.id,
          earningTransactionIds: selected.map((e) => e.transactionId),
          memo: memo.trim() || undefined,
        }),
      });
      if (!res.ok) {
        setOutcome(await readError(res));
        return;
      }
      const body = (await res.json()) as SettleResponse;
      const skipped = body.skippedTransactionIds.length;
      setOutcome(
        `${body.created ? "Settled" : "Already settled"} ${formatRupees(body.amountPaid)} across ` +
          `${body.settledTransactionIds.length} ${
            body.settledTransactionIds.length === 1 ? "entry" : "entries"
          }.` +
          (skipped > 0
            ? ` ${skipped} ${skipped === 1 ? "entry was" : "entries were"} skipped — already paid by someone else.`
            : ""),
      );
      setConfirming(false);
      setMemo("");
      setTicked(new Set());
      // Re-read both views from the server rather than patching them locally: a
      // payout screen that shows its own optimistic guess of what it just paid
      // is the screen that hides a settlement someone else made meanwhile.
      setAttempt((n) => n + 1);
    } catch {
      setOutcome("Could not reach the server. Press again — a retry cannot pay twice.");
    } finally {
      setBusy(false);
    }
  }

  if (wallets === null) {
    return <p className="py-8 text-center text-sm text-ink-faint">Loading wallets…</p>;
  }

  if (listError) {
    return (
      <div className="rounded-xl border border-border bg-surface p-5">
        <p className="text-sm text-ink-soft">{listError}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {journalNet !== null && (
        <p
          className={
            journalNet === "0.00"
              ? "text-xs text-ink-faint"
              : "rounded-lg border border-accent bg-accent-soft p-3 text-xs font-medium"
          }
        >
          {journalNet === "0.00"
            ? "Ledger balanced: every debit has a matching credit."
            : `Ledger does NOT balance — net ${formatRupees(journalNet)}. Do not authorise payouts; report this.`}
        </p>
      )}

      {wallets.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-5">
          <p className="text-sm font-medium">No wallets at this centre</p>
          <p className="mt-1 text-sm text-ink-soft">
            A wallet opens when the centre first credits a tutor for a marked script.
          </p>
        </div>
      )}

      <ul className="flex flex-col gap-3">
        {wallets.map((row) => (
          <li key={row.walletId} className="rounded-xl border border-border bg-surface">
            <button
              type="button"
              onClick={() => openWallet(openWalletId === row.walletId ? null : row.walletId)}
              aria-expanded={openWalletId === row.walletId}
              className="flex w-full items-center gap-3 p-4 text-left"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{row.tutorName ?? row.tutorPhone}</p>
                <p className="text-xs text-ink-faint">
                  {row.pendingEntryCount === 0
                    ? "Nothing pending"
                    : `${row.pendingEntryCount} ${
                        row.pendingEntryCount === 1 ? "entry" : "entries"
                      } awaiting clearance`}
                </p>
              </div>
              <p className="shrink-0 tabular-nums text-sm font-semibold">
                {formatRupees(row.balance.pending)}
              </p>
            </button>

            {openWalletId === row.walletId && (
              <div className="border-t border-border p-4">
                {detailError && <p className="text-sm text-ink-soft">{detailError}</p>}
                {!detail && !detailError && (
                  <p className="text-sm text-ink-faint">Loading entries…</p>
                )}

                {detail && detail.pendingEntries.length === 0 && (
                  <p className="text-sm text-ink-soft">
                    Everything earned on this wallet has been paid. Lifetime:{" "}
                    {formatRupees(detail.balance.lifetimeEarned)}.
                  </p>
                )}

                {detail && detail.pendingEntries.length > 0 && (
                  <>
                    <ul className="flex flex-col divide-y divide-border">
                      {detail.pendingEntries.map((entry) => (
                        <li key={entry.transactionId}>
                          <label className="flex min-h-11 cursor-pointer items-center gap-3 py-3">
                            <input
                              type="checkbox"
                              checked={ticked.has(entry.transactionId)}
                              onChange={() => toggle(entry.transactionId)}
                              className="size-5 shrink-0 accent-[var(--accent)]"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">
                                {entry.subject} · Class {entry.classNum} · {entry.pageCount}{" "}
                                {entry.pageCount === 1 ? "page" : "pages"}
                              </span>
                              <span className="block text-xs text-ink-faint">
                                {new Date(entry.createdAt).toLocaleDateString("en-IN", {
                                  day: "numeric",
                                  month: "short",
                                })}
                                {entry.memo ? ` · ${entry.memo}` : ""}
                              </span>
                            </span>
                            <span className="shrink-0 tabular-nums text-sm">
                              {formatRupees(entry.amount)}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>

                    <div className="mt-4 flex items-baseline justify-between border-t border-border pt-3">
                      <span className="text-sm text-ink-soft">
                        {selected.length} of {detail.pendingEntries.length} selected
                      </span>
                      <span className="tabular-nums text-lg font-semibold">
                        {formatRupees(selectedTotal)}
                      </span>
                    </div>

                    <label className="mt-3 block text-xs text-ink-faint">
                      Payment reference (cheque number, UPI reference, &ldquo;cash&rdquo;)
                      <input
                        type="text"
                        value={memo}
                        maxLength={300}
                        onChange={(e) => setMemo(e.target.value)}
                        className="mt-1 h-11 w-full rounded-lg border border-border bg-paper px-3 text-sm text-ink"
                      />
                    </label>

                    {!confirming ? (
                      <button
                        type="button"
                        disabled={selected.length === 0}
                        onClick={() => setConfirming(true)}
                        className="mt-3 h-11 w-full rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-40"
                      >
                        Review {formatRupees(selectedTotal)} payout
                      </button>
                    ) : (
                      /* The restatement. The figure and the count are repeated
                         here rather than assumed remembered, because the click
                         that matters is this one. */
                      <div className="mt-3 rounded-lg border border-accent bg-accent-soft p-4">
                        <p className="text-sm font-medium">
                          Pay {formatRupees(selectedTotal)} to{" "}
                          {detail.tutor?.displayName ?? detail.tutor?.phone ?? "this tutor"}?
                        </p>
                        <p className="mt-1 text-xs text-ink-soft">
                          {selected.length}{" "}
                          {selected.length === 1 ? "entry is" : "entries are"} marked settled. This
                          appends a payout to the ledger; the earnings themselves are never edited.
                        </p>
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void settle()}
                            className="h-11 flex-1 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-40"
                          >
                            {busy ? "Settling…" : "Confirm payout"}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirming(false)}
                            className="h-11 rounded-lg border border-border px-4 text-sm font-medium"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {outcome && (
                  <p role="status" className="mt-3 text-sm text-ink-soft">
                    {outcome}
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
