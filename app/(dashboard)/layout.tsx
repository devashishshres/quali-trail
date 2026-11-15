import { Suspense } from "react";
import { Sidebar } from "@/components/shell/sidebar";
import { FIXTURE_MODE } from "@/lib/client/api";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <Suspense fallback={<aside className="no-print hidden h-dvh w-60 shrink-0 bg-navy lg:block" aria-hidden="true" />}>
        <Sidebar />
      </Suspense>
      <div className="min-w-0 flex-1">
        {FIXTURE_MODE && (
          <div className="no-print border-b border-orange/40 bg-orange-wash">
            <div className="hazard h-1" aria-hidden="true" />
            <p className="px-4 py-2 text-sm sm:px-8">
              <strong>Fixture mode.</strong> You&apos;re seeing sample data from the demo seed. Nothing you add is saved, and match
              results are pre-written, not computed.
            </p>
          </div>
        )}
        <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-8 sm:px-8 lg:pb-16 lg:pt-12">{children}</main>
      </div>
    </div>
  );
}
