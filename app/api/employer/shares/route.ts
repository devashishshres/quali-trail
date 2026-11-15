import { getAccount } from "@/lib/api/auth";
import { employerReviewEnabled } from "@/lib/server/employer/flags";
import { allow, guarded, json, off, rpcValue, tooMany } from "@/lib/server/signoff/service";
import { ReviewerShare } from "@/lib/types/employer";

/** GET /api/employer/shares — packets opened by this account. Closed ones are listed without content. */
async function handleGET() {
  if (!employerReviewEnabled()) return off();
  const a = await getAccount();
  if (!a || !a.user.emailConfirmed) return json({ error: { code: "unauthorized", message: "Sign in with a confirmed email address." } }, 401);
  if (!(await allow("employer-list-user", a.user.id, 600, 120))) return tooMany();
  const list = await rpcValue<unknown[]>("employer_share_list_for_reviewer", { p_auth: a.user.id });
  if (!Array.isArray(list)) return json({ error: { code: "internal", message: "Couldn't load shared packets." } }, 500);
  return json({ shares: list.map((s) => ReviewerShare.parse(s)) });
}

export const GET = guarded(handleGET);
