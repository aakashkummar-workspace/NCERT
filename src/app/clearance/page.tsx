import AppHeader from "@/components/AppHeader";
import ClearancePortal from "@/components/ClearancePortal";

/**
 * The tuition-centre manager's clearance portal.
 *
 * Dynamic for the same reason /wallet is: it is entirely session-dependent, and
 * a prerendered copy of somebody's payroll in the CDN cache is the worst
 * possible thing to leave lying about.
 *
 * The `ADMIN` gate lives on the routes this page calls, not on the page. A
 * client-side role check is a courtesy, and `requireUser("ADMIN")` re-reading
 * the row on every request is the control.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Clearance — NCERT Quick" };

export default function ClearancePage() {
  return (
    <>
      <AppHeader
        title="Clearance"
        subtitle="Verify marked scripts and authorise payouts"
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <ClearancePortal />
      </main>
    </>
  );
}
