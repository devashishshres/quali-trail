"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FIXTURE_MODE } from "@/lib/client/api";
import { accountsApi } from "@/lib/client/accounts-api";
import { useLoad } from "@/lib/client/use-load";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { Icon, type IconName } from "../ui/icons";

type NavItem = { href: string; label: string; icon: IconName };
const WORKER_NAV: NavItem[] = [
  { href: "/passport", label: "Passport", icon: "passport" },
  { href: "/evidence", label: "My Evidence", icon: "evidence" },
  { href: "/opportunities", label: "Opportunities", icon: "briefcase" },
  { href: "/reports", label: "Reports", icon: "report" },
];
const SUPERVISORS: NavItem = { href: "/supervisors", label: "Supervisors", icon: "people" };
const REVIEWS: NavItem = { href: "/supervisor", label: "Reviews", icon: "clipboard" };
const SHARE: NavItem = { href: "/share", label: "Share", icon: "external" };

/** Navigation follows the caller's own roles: technician, reviewer, or both. */
function useNav(): NavItem[] {
  const me = useLoad(() => (FIXTURE_MODE ? Promise.resolve(null) : accountsApi.me()));
  if (FIXTURE_MODE) return WORKER_NAV;
  const m = me.data;
  if (!m) return [];
  return [
    ...(m.worker ? WORKER_NAV : []),
    ...(m.worker && m.features.supervisorReview ? [SUPERVISORS] : []),
    ...(m.worker && m.features.employerReview ? [SHARE] : []),
    ...(m.supervisor ? [REVIEWS] : []),
  ];
}

function Wordmark() {
  return (
    <Link href="/" className="font-display text-2xl font-bold tracking-tight text-white">
      Quali<span className="text-orange">Trail</span>
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const NAV = useNav();
  const router = useRouter();
  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  async function signOut() {
    await createBrowserSupabase().auth.signOut();
    router.replace("/sign-in");
  }

  return (
    <>
      {/* Desktop rail */}
      <aside className="no-print sticky top-0 hidden h-dvh w-60 shrink-0 flex-col bg-navy px-4 py-6 text-white/80 lg:flex">
        <div className="px-2">
          <Wordmark />
          <p className="mt-1 text-sm text-white/60">Your experience. Recognized. Portable.</p>
        </div>
        <nav className="mt-10 flex flex-col gap-1" aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active(item.href) ? "page" : undefined}
              className={`flex items-center gap-3 rounded-md px-3 py-2.5 font-medium transition-colors ${
                active(item.href) ? "bg-white/10 text-white shadow-[inset_3px_0_0_var(--color-orange)]" : "hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon name={item.icon} />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto px-2 text-sm">
          {FIXTURE_MODE ? (
            <p className="text-white/60">Showing sample data. Set NEXT_PUBLIC_DATA_MODE=live to use your Supabase records.</p>
          ) : (
            <button onClick={signOut} className="flex items-center gap-2 text-white/70 hover:text-white">
              <Icon name="signout" className="size-4" /> Sign out
            </button>
          )}
        </div>
      </aside>

      {/* Mobile: top bar + bottom tabs (thumb reach on a job site) */}
      <header className="no-print flex items-center justify-between bg-navy px-4 py-3 lg:hidden">
        <Wordmark />
        {!FIXTURE_MODE && (
          <button onClick={signOut} className="text-white/70" aria-label="Sign out">
            <Icon name="signout" />
          </button>
        )}
      </header>
      <nav
        style={{ gridTemplateColumns: `repeat(${Math.max(NAV.length, 1)}, minmax(0, 1fr))` }}
        className="no-print fixed inset-x-0 bottom-0 z-20 grid border-t border-white/10 bg-navy pb-[env(safe-area-inset-bottom)] lg:hidden"
        aria-label="Main"
      >
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active(item.href) ? "page" : undefined}
            className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${active(item.href) ? "text-orange" : "text-white/70"}`}
          >
            <Icon name={item.icon} />
            {item.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
