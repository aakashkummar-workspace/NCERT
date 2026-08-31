import AppHeader from "@/components/AppHeader";
import WalletSummary from "@/components/WalletSummary";

/**
 * A tutor's earnings.
 *
 * Dynamic, unlike every reader route: it reads a session cookie, so it must not
 * be prerendered into the static shell. The route table printed by
 * `next build` should show this as ƒ — the reader's /class, /read, /quiz,
 * /practice and /past-papers routes must stay ○/●.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Earnings — NCERT Quick" };

export default function WalletPage() {
  return (
    <>
      <AppHeader
        title="Earnings"
        subtitle="What you have been paid, and what is still owed"
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <WalletSummary />
      </main>
    </>
  );
}
