"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Sign in, or create an account. One screen, one form, one button.
 *
 * ## Why the two are not separate screens
 *
 * Because from the outside they are the same act — "let me in" — and the person
 * doing it usually cannot remember which one applies to them. Splitting them
 * makes that a decision, and a wrong guess sends you to the screen that tells
 * you no.
 *
 * ## Creating an account is two requests, and that is on purpose
 *
 * `POST /api/auth/register/` answers identically whether or not the address is
 * already taken, and therefore cannot hand back a session — if the address
 * existed, the session would be somebody else's. So it registers, then signs
 * in. If the address was already somebody's, the sign-in fails with the same
 * message a wrong password gets, which is exactly what it should say: we do not
 * tell a stranger whose address is registered here. See src/lib/auth.ts.
 *
 * ## The copy
 *
 * Errors say what happened and stop. No apology, no "oops", no advice about
 * password managers. A person who has just mistyped their password does not
 * need a paragraph.
 */

interface Failure {
  code?: string;
  message: string;
}

async function post(url: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    const envelope = text ? (JSON.parse(text) as { error?: Failure }) : {};
    throw new Error(envelope.error?.message ?? "Something went wrong. Try again.");
  }
}

type Mode = "signin" | "create";

/**
 * Inlined at build time by Next, so a production bundle does not contain the
 * picker at all — matching the server, where the `role` field is not on the
 * request shape either.
 */
const DEV = process.env.NODE_ENV !== "production";

const ROLES = [
  { value: "STUDENT", label: "Student" },
  { value: "EVALUATOR", label: "Evaluator" },
  { value: "PARENT", label: "Parent" },
  { value: "ADMIN", label: "Admin" },
] as const;

export default function SignInForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<string>("STUDENT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in? Then this screen has nothing to offer. `.then` with a
  // `live` guard rather than an async effect — the same shape RevisionQueue
  // uses, and the one the lint rule about setting state in an effect allows.
  useEffect(() => {
    let live = true;
    fetch("/api/auth/session/", { credentials: "same-origin" })
      .then((res) => {
        if (live && res.ok) router.replace("/hub/");
      })
      .catch(() => {
        // Offline, or signed out. Either way the form below is the answer.
      });
    return () => {
      live = false;
    };
  }, [router]);

  const ready = email.trim().length > 5 && password.length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        await post("/api/auth/register/", {
          email: email.trim(),
          password,
          displayName: displayName.trim() || undefined,
          ...(DEV ? { role } : {}),
        });
      }
      await post("/api/auth/login/", { email: email.trim(), password });
      // Hub reads the session itself when it mounts, so a client push is
      // enough — the cookie is set by the time this line runs.
      router.push("/hub/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Sign in or create an account"
        className="mb-5 grid grid-cols-2 gap-1 rounded-xl border border-border bg-surface-alt p-1"
      >
        {(
          [
            ["signin", "Sign in"],
            ["create", "Create account"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => {
              setMode(value);
              setError(null);
            }}
            className={`min-h-11 rounded-lg px-3 text-sm font-semibold transition-colors ${
              mode === value ? "bg-surface text-ink shadow-sm" : "text-ink-soft"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-3">
        {mode === "create" && (
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink-soft">Your name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value.slice(0, 120))}
              autoComplete="name"
              placeholder="Optional"
              className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm"
            />
          </label>
        )}

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-soft">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value.slice(0, 255))}
            autoComplete="email"
            inputMode="email"
            required
            className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-soft">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value.slice(0, 200))}
            autoComplete={mode === "create" ? "new-password" : "current-password"}
            required
            className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm"
          />
          {mode === "create" && (
            <span className="mt-1 block text-xs text-ink-faint">At least 10 characters.</span>
          )}
        </label>

        {DEV && mode === "create" && (
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink-soft">
              Sign up as — development only
            </span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-ink-faint">
              Not built into a production bundle, and ignored by the server there. Every real
              sign-up is a student.
            </span>
          </label>
        )}

        {error && (
          <p role="alert" className="text-xs font-medium text-accent">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !ready}
          className="min-h-11 w-full rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-40"
        >
          {busy
            ? mode === "create"
              ? "Creating…"
              : "Signing in…"
            : mode === "create"
              ? "Create account"
              : "Sign in"}
        </button>
      </form>

      <p className="mt-5 text-xs leading-relaxed text-ink-faint">
        Reading, quizzes, papers and revision need no account and work with no network. An account
        is for the parts other people touch: submitting written answers, doubts, marking, payouts.
      </p>
    </div>
  );
}
