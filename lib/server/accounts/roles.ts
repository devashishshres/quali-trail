import "server-only";
import type { Account } from "@/lib/api/auth";
import { supervisorReviewEnabled } from "@/lib/server/accounts/flags";
import { mayCreateRole, type RoleState } from "@/lib/server/accounts/policy";
import { hmac } from "@/lib/server/signoff/crypto";
import { rpcValue } from "@/lib/server/signoff/service";

/** Does this address hold an open supervisor invitation? Only meaningful while supervisor review is on. */
export async function hasPendingInvite(email: string): Promise<boolean> {
  if (!supervisorReviewEnabled()) return false;
  return (await rpcValue<boolean>("account_has_pending_invite", { p_email_hash: hmac("email", email.trim().toLowerCase()) })) === true;
}

/** The facts the role policy needs, for a signed-in account with a confirmed email. */
export async function roleState(a: Account & { user: { email: string } }): Promise<RoleState> {
  return {
    email: a.user.email,
    hasWorker: Boolean(a.worker),
    hasSupervisor: Boolean(a.supervisor),
    hasInvite: a.supervisor ? false : await hasPendingInvite(a.user.email),
    supervisorReviewOn: supervisorReviewEnabled(),
  };
}

export async function allowedRoles(a: Account): Promise<{ worker: boolean; supervisor: boolean }> {
  if (!a.user.emailConfirmed || !a.user.email) return { worker: false, supervisor: false };
  const s = await roleState(a as Account & { user: { email: string } });
  return { worker: mayCreateRole("worker", s), supervisor: mayCreateRole("supervisor", s) };
}
