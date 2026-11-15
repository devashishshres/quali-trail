import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/server/accounts/policy";

/**
 * Runs before every page and API request.
 *  1. Rejects cross-site writes to the API (CSRF defence in depth; auth cookies are also SameSite=Lax).
 *  2. Refreshes the Supabase session cookie.
 *  3. Routes by role, without loops:
 *       signed out           -> public pages only, otherwise /sign-in
 *       signed in, no role   -> /onboarding (which never redirects a signed-in user away)
 *       supervisor only      -> /supervisor; worker pages send them there
 *       worker (or both)     -> worker pages; /supervisor only with a supervisor profile
 * This is an optimistic check: every API route still authorizes the caller itself.
 */

const PUBLIC = ["/sign-in", "/sign-up", "/forgot-password", "/reset-password", "/auth/", "/signoff", "/invite/"];
const WORKER_PAGES = ["/passport", "/evidence", "/opportunities", "/reports", "/supervisors", "/jobs", "/share"];
/** Exact path or a sub-path ("/evidence", "/evidence/x"), never a longer sibling ("/evidencex"). */
const startsWithAny = (path: string, list: string[]) =>
  list.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p || path.startsWith(`${p}/`)));

function crossSiteWrite(request: NextRequest): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
  const path = request.nextUrl.pathname;
  if (!path.startsWith("/api/") || path.startsWith("/api/webhooks/")) return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false; // non-browser clients; they carry no ambient cookies of ours
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export async function proxy(request: NextRequest) {
  if (crossSiteWrite(request)) {
    return NextResponse.json({ error: { code: "forbidden", message: "Cross-site request refused." } }, { status: 403 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (process.env.NEXT_PUBLIC_DATA_MODE === "fixtures" || !url || !key) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
      },
    },
  });

  const { data } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  if (path.startsWith("/api")) return response;

  const redirect = (to: string, next?: string) => {
    const target = new URL(to, request.url);
    if (next) target.searchParams.set("next", next);
    const r = NextResponse.redirect(target);
    for (const c of response.cookies.getAll()) r.cookies.set(c);
    return r;
  };

  if (!data.user) {
    if (startsWithAny(path, PUBLIC)) return response;
    return redirect("/sign-in", path + request.nextUrl.search);
  }

  // Customer and invitation pages, the email-link callback, password reset and onboarding work for anyone signed in.
  // So do shared employer packets: each page and API call there checks the share's recipient itself.
  if (startsWithAny(path, ["/signoff", "/invite/", "/auth/", "/onboarding", "/forgot-password", "/reset-password", "/employer"])) return response;

  const [w, s] = await Promise.all([
    supabase.from("workers").select("id").eq("auth_user_id", data.user.id).maybeSingle(),
    supabase.from("supervisor_profiles").select("auth_user_id").eq("auth_user_id", data.user.id).maybeSingle(),
  ]);
  const isWorker = Boolean(w.data);
  const isSupervisor = Boolean(!s.error && s.data);
  const home = isWorker ? "/passport" : isSupervisor ? "/supervisor" : "/onboarding";

  if (path.startsWith("/sign-in") || path.startsWith("/sign-up")) {
    return redirect(safeNext(request.nextUrl.searchParams.get("next"), home));
  }
  if (startsWithAny(path, WORKER_PAGES) && !isWorker) return redirect(home);
  if (startsWithAny(path, ["/supervisor"]) && !isSupervisor) return redirect(isWorker ? "/onboarding?role=supervisor" : "/onboarding");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)"],
};
