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
    // V2-aware: check both quiz tables and use the most recent row (in case a
    // user has sessions in both). Same class of fix as #111 (trigger) and the
    // magic-link function — email fallback was V1-only.
    const [v1, v2] = await Promise.all([
      db.from("quiz_sessions")
        .select("current_period_end, subscription_status, created_at")
        .eq("email", email).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      db.from("quiz2_sessions")
        .select("current_period_end, subscription_status, created_at")
        .eq("email", email).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const rows = [v1.data, v2.data].filter(Boolean) as Array<{ current_period_end: string | null; subscription_status: string | null; created_at: string }>;
    if (rows.length) {
      rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
      const best = rows[0];
      return { periodEnd: best.current_period_end ?? null, subStatus: best.subscription_status ?? null };
    }
  }

  return { periodEnd: null, subStatus: null };
}

// True when the paid-through date is in the future.
export function hasAccess(info: AccessInfo): boolean {
  return !!info.periodEnd && new Date(info.periodEnd) >= new Date();
}
