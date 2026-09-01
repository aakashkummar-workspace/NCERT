"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Every feature in the app, on one screen, arranged by who you are.
 *
 * The app grew a server half — grading, evaluators, parents, payouts — and
 * those screens were reachable only by typing a URL. This is the index.
 *
 * Two decisions shape it:
 *
 *  1. **The page is prerendered and the session is fetched on the client.**
 *     Making it server-rendered would read the cookie at request time and be
 *     honest about who you are, but it would also mean the page does not exist
 *     offline — and the eight things a student can do with no network are the
 *     eight most important things here. So the shell ships static, the study
 *     tools are always listed, and the account-bound sections appear once we
 *     know the role.
 *  2. **Nothing is hidden for being unavailable.** A feature that needs a
 *     network, a sign-in, or a model key is listed and says so. A dashboard
 *     that silently omits half the product teaches you it is smaller than it
 *     is, and you go looking for the missing thing in a menu that never had it.
 */

type Role = "STUDENT" | "EVALUATOR" | "PARENT" | "ADMIN";

interface Me {
  user: { displayName: string | null; role: Role; hitlEnabled: boolean };
  studentProfile: { classNum: number; schoolName: string | null } | null;
  evaluatorProfile: { evaluatorType: string; activeForRouting: boolean } | null;
}

/** Signed out is a normal answer here, not a failure — hence `null`, not a throw. */
async function loadMe(): Promise<Me | null> {
  try {
    const res = await fetch("/api/auth/session/", { credentials: "same-origin" });
    if (!res.ok) return null;
    return (await res.json()) as Me;
  } catch {
    // Offline. The study tools below still work; the rest genuinely does not.
    return null;
  }
}

interface Item {
  href: string;
  title: string;
  /** What it does, in the student's words rather than the system's. */
  blurb: string;
  /** Set when the thing is real but cannot finish right now. */
  caveat?: string;
}

const STUDY: Item[] = [
  { href: "/", title: "Read", blurb: "149 NCERT chapters, Class 9 and 10. Download one and it stays." },
  { href: "/practice/", title: "Sample papers", blurb: "66 CBSE papers with their official marking schemes. 30 you can score yourself." },
  { href: "/test/", title: "Dual-track tests", blurb: "One sitting: Section A marks itself, Section B you write on paper." },
  { href: "/quiz/", title: "Quizzes", blurb: "Short chapter checks that mark as you go." },
  { href: "/bridge/", title: "Run-ups", blurb: "Two minutes on what a chapter assumes you already have. Nothing is scored." },
  { href: "/revise/", title: "Revise", blurb: "What is due today, scheduled from how you actually did." },
  { href: "/progress/", title: "Progress", blurb: "CBSE weightage against your own confidence." },
  { href: "/downloads/", title: "Downloads", blurb: "What is saved on this phone, and how much room it takes." },
];

const STUDENT: Item[] = [
  {
    href: "/submit/",
    title: "Submit written answers",
    blurb: "Photograph what you wrote. It comes back marked against the scheme, step by step.",
    caveat: "Grading runs only when a model key is set. Until then submissions queue rather than guess.",
  },
  { href: "/sittings/", title: "Papers you have sat", blurb: "Every sitting, self-marked or sent away — and which of them anybody is still marking." },
  { href: "/results/", title: "Marked answers", blurb: "Green, orange and red over your own handwriting, beside the scheme's own words." },
  { href: "/doubts/", title: "Doubts", blurb: "Ask under a nickname if you would rather. Type it or record it." },
  { href: "/parent/", title: "Parent access", blurb: "Who has asked to see your work, and what they would see. Yours to allow or stop." },
];

const EVALUATOR: Item[] = [
  { href: "/evaluate/", title: "Marking queue", blurb: "Claim a script, check the AI's draft, and put your own marks on it." },
  { href: "/wallet/", title: "Earnings", blurb: "What you have earned and what is still to be paid." },
];

const PARENT: Item[] = [
  { href: "/parent/", title: "How they are doing", blurb: "Effort, trend, and which chapters are hard — with something useful to do about it." },
];

const ADMIN: Item[] = [
  { href: "/moderation/", title: "Moderation", blurb: "Reported posts, worst first. Hide, remove, or resolve who wrote it." },
  { href: "/clearance/", title: "Payout clearance", blurb: "Check what is owed and settle it. Every settlement is appended, never edited." },
];

const ROLE_SECTIONS: Record<Role, { label: string; items: Item[] }> = {
  STUDENT: { label: "Your work", items: STUDENT },
  EVALUATOR: { label: "Marking", items: EVALUATOR },
  PARENT: { label: "Your child", items: PARENT },
  ADMIN: { label: "Running the place", items: ADMIN },
};

function Card({ item }: { item: Item }) {
  return (
    <li>
      <Link
        href={item.href}
        className="flex h-full min-h-[104px] flex-col rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent"
      >
        <span className="text-[15px] font-semibold">{item.title}</span>
        <span className="mt-1 text-[13px] leading-snug text-ink-soft">{item.blurb}</span>
        {item.caveat && (
          <span className="mt-2 text-[12px] leading-snug text-ink-faint">{item.caveat}</span>
        )}
      </Link>
    </li>
  );
}

function Section({ label, items }: { label: string; items: Item[] }) {
  return (
    <section className="mt-7 first:mt-0">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">{label}</h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <Card key={item.href + item.title} item={item} />
        ))}
      </ul>
    </section>
  );
}

export default function Hub() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let live = true;
    loadMe().then((result) => {
      if (!live) return;
      setMe(result);
      setChecked(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const section = me ? ROLE_SECTIONS[me.user.role] : null;

  return (
    <div>
      <Section label="Study — works with no network" items={STUDY} />

      {section && <Section label={section.label} items={section.items} />}

      {checked && !me && (
        <section className="mt-7">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Needs an account
          </h2>
          <Link
            href="/signin/"
            className="block rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent"
          >
            <p className="text-[15px] font-semibold">Sign in or create an account</p>
            <p className="mt-1 text-[13px] leading-snug text-ink-soft">
              Submitting written answers, doubts, marking and payouts need this, and a connection.
              Everything above works without either.
            </p>
            <p className="mt-2 text-[12px] leading-snug text-ink-faint">
              An email and a password. Grading itself still runs only when a model key is set —
              until then submissions queue rather than guess.
            </p>
          </Link>
        </section>
      )}

      {me && (
        <p className="mt-7 text-[12px] text-ink-faint">
          Signed in as {me.user.displayName ?? "you"}
          {me.studentProfile ? ` · Class ${me.studentProfile.classNum}` : ""} ·{" "}
          {me.user.role.toLowerCase()}
        </p>
      )}
    </div>
  );
}
