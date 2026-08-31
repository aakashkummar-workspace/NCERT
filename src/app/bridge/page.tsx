import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import { allBridges, bridgeHref, type Bridge } from "@/lib/bridge";

export const metadata = { title: "Bridges — NCERT Quick" };

/**
 * Every run-up, listed.
 *
 * The offer is dismissible and forgettable by design, so it needs somewhere to
 * live afterwards — "it is under Bridges if you change your mind" has to be
 * true. Listing them also makes the map inspectable: a student can see that
 * Quadratic Equations leans on Class 9 identities before they get anything
 * wrong, which is the version of this feature with no bad day attached.
 *
 * The admitted gaps are listed too, in their own section. They are never
 * offered, and saying so is more use than hiding them.
 */
function groupKey(b: Bridge): string {
  return `Class ${b.classNum} ${b.subject}`;
}

export default function BridgeIndexPage() {
  const bridges = allBridges();
  const offerable = bridges.filter((b) => b.steps.length > 0);
  const gapOnly = bridges.filter((b) => b.steps.length === 0);

  const groups = new Map<string, Bridge[]>();
  for (const b of offerable) {
    const list = groups.get(groupKey(b)) ?? [];
    list.push(b);
    groups.set(groupKey(b), list);
  }

  return (
    <>
      <AppHeader
        title="Bridges"
        subtitle="Two-minute run-ups to a chapter, from the chapter it leans on"
        back={{ href: "/", label: "home" }}
      />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <p className="mb-6 text-sm text-ink-soft">
          Each one is the smallest thing that makes the next chapter possible. Nothing here is
          scored, and reading one changes nothing on your progress.
        </p>

        {[...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, list]) => (
            <section key={name} className="mb-8">
              <h2 className="mb-3 font-semibold">{name}</h2>
              <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
                {[...list]
                  .sort((a, b) => a.chapter - b.chapter || a.id.localeCompare(b.id))
                  .map((bridge) => (
                    <li key={bridge.id}>
                      <Link href={bridgeHref(bridge)} className="block p-3">
                        <div className="flex items-baseline gap-3">
                          <span className="min-w-0 flex-1 text-sm font-medium">
                            {bridge.concept ?? bridge.title}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-ink-faint">
                            {bridge.minutes} min
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-ink-faint">
                          Chapter {bridge.chapter} · after{" "}
                          {bridge.steps.map((s) => s.title).join(", ")}
                        </p>
                      </Link>
                    </li>
                  ))}
              </ul>
            </section>
          ))}

        {gapOnly.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-3 font-semibold">No run-up possible</h2>
            <p className="mb-3 text-sm text-ink-soft">
              These chapters build on Class 6–8 work, and this app mirrors Class 9 and 10 only.
              Naming the gap is more honest than sending you to a Class 9 chapter that only sounds
              similar.
            </p>
            <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-dashed border-border">
              {gapOnly.map((bridge) => (
                <li key={bridge.id} className="p-3">
                  <p className="text-sm font-medium">
                    {bridge.title}{" "}
                    <span className="font-normal text-ink-faint">
                      · Class {bridge.classNum} {bridge.subject}
                    </span>
                  </p>
                  {bridge.gaps.map((gap) => (
                    <p key={gap.topic} className="mt-0.5 text-xs text-ink-faint">
                      Needs Class {gap.grade}: {gap.topic}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
