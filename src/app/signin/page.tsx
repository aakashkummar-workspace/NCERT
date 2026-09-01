import AppHeader from "@/components/AppHeader";
import SignInForm from "@/components/SignInForm";

export const metadata = { title: "Sign in — NCERT Quick" };

/**
 * Prerendered, like the hub: the form does its own work on the client, so this
 * page costs nothing to serve and is in the shell cache. Signing in still needs
 * a connection — the two routes it posts to are the network, and there is no
 * offline version of being let in.
 */
export default function SignInPage() {
  return (
    <>
      <AppHeader
        title="Sign in"
        subtitle="For submitting answers, doubts and marking"
        back={{ href: "/hub/", label: "everything" }}
      />
      <main className="mx-auto w-full max-w-sm flex-1 px-4 py-6">
        <SignInForm />
      </main>
    </>
  );
}
