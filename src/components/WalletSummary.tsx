"use client";

import { useEffect, useState } from "react";

/**
 * What a tutor has earned, and what is still owed to them.
 *
 * Two numbers do the work, and the copy is chosen so neither can be misread:
 *
 *   **Pending** is money earned and not yet paid. It is the one a tutor came to
 *   see, so it is the largest thing on the screen.
 *   **Paid so far** is lifetime settlements. It only ever grows.
 *
 * Deliberately absent: a single "balance". In the specification the wallet had
 * one `current_balance` column that settlement decremented and nothing ever
 * incremented, so the number a tutor saw was neither their earnings nor their
 * arrears — it was a running subtraction with no defined meaning. Every figure
 * here is a sum over ledger entries, and the entry list underneath is the
 * arithmetic, so a tutor who disagrees with the total can find the row.
 *
 * Amounts arrive as decimal strings and are never converted to numbers. They
 * are grouped for display by string manipulation, not by `toLocaleString` on a
 * float — ₹1,04,832.15 is not something to reconstruct from a double.
 */

interface Entry {
  transactionId: string;
  amount: string;
  subject: string;
  classNum: number;
  pageCount: number;
  memo: string | null;
  createdAt: string;
  settled: boolean;
  settledAt: string | null;
}

interface WalletRow {
  walletId: string;
  centreScopeId: string;
  currency: string;
  balance: { lifetimeEarned: string; lifetimePaid: string; pending: string };
  pendingEntryCount: number;
  entries: Entry[];
}

interface Payload {
  tutor: { id: string; displayName: string | null; role: string };
  wallets: WalletRow[];
}

/**
 * "1234567.5" → "12,34,567.50". Indian grouping: the last three digits, then
 * pairs. Done on the string because the value is exact as a string and stops
 * being exact the moment it is a `Number`.
 */
export function formatRupees(decimal: string): string {
  const negative = decimal.startsWith("-");
  const [whole = "0", frac = "00"] = (negative ? decimal.slice(1) : decimal).split(".");
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${negative ? "-" : ""}₹${grouped}.${frac.padEnd(2, "0")}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Fetch, or throw a message fit to show a tutor.
 *
 * Kept outside the component and free of `setState` on purpose: the effect
 * below subscribes to this promise and writes state from its callback, which is
 * both what `react-hooks/set-state-in-effect` asks for and what lets an unmount
 * during a slow request drop the result instead of setting state on a gone
 * component. It is the same shape RevisionQueue uses.
 */
async function fetchWallet(): Promise<Payload> {
  // Trailing slash: next.config.ts sets trailingSlash, and the redirect costs a
  // round trip on a connection that is already slow.
  const res = await fetch("/api/wallet/", { credentials: "same-origin" });
  if (res.status === 401) throw new Error("Sign in to see your earnings.");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? "Could not load your wallet.");
  }
  return (await res.json()) as Payload;
}

export default function WalletSummary() {
  const [state, setState] = useState<
    { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: Payload }
  >({ status: "loading" });
  /** Bumped by "Try again". The effect's only trigger. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    fetchWallet()
      .then((data) => {
        if (live) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (live) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Could not reach the server.",
          });
        }
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  if (state.status === "loading") {
    return <p className="py-8 text-center text-sm text-ink-faint">Loading your earnings…</p>;
  }

  if (state.status === "error") {
    return (
      <div className="rounded-xl border border-border bg-surface p-4">
        <p className="text-sm text-ink-soft">{state.message}</p>
        <button
          type="button"
          onClick={() => {
            setState({ status: "loading" });
            setAttempt((n) => n + 1);
          }}
          className="mt-3 h-11 rounded-lg border border-border px-4 text-sm font-medium hover:bg-surface-alt"
        >
          Try again
        </button>
      </div>
    );
  }

  const { wallets } = state.data;

  if (wallets.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-5">
        <p className="text-sm font-medium">No earnings yet</p>
        <p className="mt-1 text-sm text-ink-soft">
          A wallet opens the first time a tuition centre credits you for a marked script. Nothing
          is owed to you, and nothing is missing.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {wallets.map((wallet) => (
        <section key={wallet.walletId} className="rounded-xl border border-border bg-surface">
          <div className="border-b border-border p-5">
            <p className="text-xs uppercase tracking-wide text-ink-faint">Pending</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">
              {formatRupees(wallet.balance.pending)}
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              {wallet.pendingEntryCount === 0
                ? "Everything you have earned has been paid."
                : `${wallet.pendingEntryCount} ${
                    wallet.pendingEntryCount === 1 ? "script" : "scripts"
                  } marked and awaiting clearance by the centre.`}
            </p>

            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-ink-faint">Earned, all time</dt>
                <dd className="tabular-nums font-medium">
                  {formatRupees(wallet.balance.lifetimeEarned)}
                </dd>
              </div>
              <div>
                <dt className="text-ink-faint">Paid so far</dt>
                <dd className="tabular-nums font-medium">
                  {formatRupees(wallet.balance.lifetimePaid)}
                </dd>
              </div>
            </dl>
          </div>

          <ul className="divide-y divide-border">
            {wallet.entries.length === 0 && (
              <li className="p-5 text-sm text-ink-soft">No entries on this wallet yet.</li>
            )}
            {wallet.entries.map((entry) => (
              <li key={entry.transactionId} className="flex items-start gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {entry.subject} · Class {entry.classNum}
                  </p>
                  <p className="text-xs text-ink-faint">
                    {formatDate(entry.createdAt)} · {entry.pageCount}{" "}
                    {entry.pageCount === 1 ? "page" : "pages"}
                    {entry.memo ? ` · ${entry.memo}` : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="tabular-nums text-sm font-medium">{formatRupees(entry.amount)}</p>
                  {/* "Paid" and "Pending", never a colour alone: the state of
                      someone's pay should survive a greyscale screenshot and a
                      colour-blind reader. */}
                  <p className={entry.settled ? "text-xs text-ink-faint" : "text-xs text-accent"}>
                    {entry.settled
                      ? `Paid${entry.settledAt ? ` ${formatDate(entry.settledAt)}` : ""}`
                      : "Pending"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
