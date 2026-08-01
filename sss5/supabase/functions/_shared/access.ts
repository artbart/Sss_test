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
  lifetimeAt: string | null;  // ISO timestamp of the lifetime purchase, or null
  planTier: string;           // 'standard' | 'lite' — drives the monthly story quota
}

// Monthly story quota per plan tier. Unknown tiers fall back to standard so a
// bad value can never lock a paying user out.
const STORY_LIMITS: Record<string, number> = { standard: 3, lite: 1 };

export function storyLimitFor(planTier: string | null | undefined): number {
  return STORY_LIMITS[planTier ?? ""] ?? STORY_LIMITS.standard;
}

export async function resolveAccess(
  db: SupabaseClient,
  userId?: string | null,
  leadEmail?: string | null,
): Promise<AccessInfo> {
  if (userId) {
    const { data } = await db
      .from("users")
      .select("current_period_end, subscription_status, lifetime_at, plan_tier")
      .eq("id", userId)
      .maybeSingle();
    if (data) return {
      periodEnd: data.current_period_end ?? null,
      subStatus: data.subscription_status ?? null,
      lifetimeAt: data.lifetime_at ?? null,
      planTier: data.plan_tier ?? "standard",
    };
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
      // Pre-signup leads cannot hold lifetime; they are always standard tier.
      return { periodEnd: best.current_period_end ?? null, subStatus: best.subscription_status ?? null, lifetimeAt: null, planTier: "standard" };
    }
  }

  return { periodEnd: null, subStatus: null, lifetimeAt: null, planTier: "standard" };
}

// True when the user holds lifetime, or the paid-through date is in the future.
export function hasAccess(info: AccessInfo): boolean {
  if (info.lifetimeAt) return true;
  return !!info.periodEnd && new Date(info.periodEnd) >= new Date();
}
