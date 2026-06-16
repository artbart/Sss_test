// Shared entitlement lookup. Access to generate content is gated on the
// paid-through date (current_period_end), NOT on subscription status — so a
// cancel-at-period-end user keeps access until the period actually ends.
//
// Source of truth:
//   - logged-in users  -> public.users (by id)
//   - pre-signup / lead -> public.quiz_sessions (latest row by email)
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export interface AccessInfo {
  periodEnd: string | null;   // ISO timestamp of current_period_end, or null
  subStatus: string | null;   // subscription_status, for messaging/ops
}

export async function resolveAccess(
  db: SupabaseClient,
  userId?: string | null,
  leadEmail?: string | null,
): Promise<AccessInfo> {
  if (userId) {
    const { data } = await db
      .from("users")
      .select("current_period_end, subscription_status")
      .eq("id", userId)
      .maybeSingle();
    if (data) return { periodEnd: data.current_period_end ?? null, subStatus: data.subscription_status ?? null };
  }

  if (leadEmail) {
    const email = leadEmail.trim().toLowerCase();
    const { data } = await db
      .from("quiz_sessions")
      .select("current_period_end, subscription_status")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return { periodEnd: data.current_period_end ?? null, subStatus: data.subscription_status ?? null };
  }

  return { periodEnd: null, subStatus: null };
}

// True when the paid-through date is in the future.
export function hasAccess(info: AccessInfo): boolean {
  return !!info.periodEnd && new Date(info.periodEnd) >= new Date();
}
