// Which Stripe account a customer belongs to, and how to resolve that
// account's price ids from the environment.
//
// Both accounts have the Stripe display name "StuffSoSweet", so the display
// name is worthless as a safety check — the acct_ id is the only reliable
// discriminator. See
// docs/superpowers/specs/2026-08-08-stripe-dual-account-design.md
//
// Pure and side-effect free on import: env is read lazily at call time, so this
// module can be unit-tested without any live keys.

export type StripeAccount = "leadoni" | "astronaut";

// astronaut first: it is the growing side, so trying it first makes the common
// case short-circuit in the webhook's signature loop.
export const STRIPE_ACCOUNTS: readonly StripeAccount[] = ["astronaut", "leadoni"];

export const EXPECTED_ACCT_ID: Record<StripeAccount, string> = {
  leadoni: "acct_1TRcmOKD4axecwd4", // display name "StuffSoSweet"; shared with PhaseMap
  astronaut: "acct_1U287eKdnhowNC0W", // display name "StuffSoSweet"; SSS-dedicated
};

// Rows written before the dual-account split have no value; they are all
// leadoni, which is why the column defaults to it.
export function parseAccount(v: string | null | undefined): StripeAccount {
  if (!v) return "leadoni";
  if (v === "leadoni" || v === "astronaut") return v;
  // Guessing here would mean billing someone on the wrong account.
  throw new Error(`unknown stripe account: ${v}`);
}

// leadoni is shared with PhaseMap, so SSS objects must be identified by
// metadata.session_id. astronaut is SSS-dedicated: everything on it is ours,
// including anything created by hand in the dashboard.
export function requiresOwnershipMarker(a: StripeAccount): boolean {
  return a === "leadoni";
}

export type PriceKey = "1W" | "4W" | "8W" | "LITE" | "LIFETIME" | "STORY_PACK" | "TEST";

// Existing secrets are unprefixed and mean leadoni. Never rename them — that is
// what keeps this change unable to regress current billing.
export function envKeyFor(a: StripeAccount, suffix: string): string {
  return a === "astronaut" ? `STRIPE_ASTRONAUT_${suffix}` : `STRIPE_${suffix}`;
}

export function priceFor(a: StripeAccount, key: PriceKey): string | null {
  return Deno.env.get(envKeyFor(a, `PRICE_${key}`)) || null;
}

export interface PlanConfig {
  priceId: string;
  couponId?: string;
}

// Coupon ids are caller-chosen in Stripe, and all three were created with
// identical ids on both accounts — so these env vars are single-valued and
// deliberately NOT account-prefixed.
const PLAN_TO_PRICE: Record<string, PriceKey> = { "1": "1W", "4": "4W", "8": "8W" };
const PLAN_TO_COUPON_ENV: Record<string, string> = {
  "4": "STRIPE_COUPON_4W",
  "8": "STRIPE_COUPON_8W",
};

// plan key sent by the funnel: "1" | "4" | "8"
export function planConfig(a: StripeAccount, plan: string): PlanConfig | null {
  const priceKey = PLAN_TO_PRICE[plan];
  if (!priceKey) return null;
  const priceId = priceFor(a, priceKey);
  if (!priceId) return null;
  const couponEnv = PLAN_TO_COUPON_ENV[plan];
  const couponId = couponEnv ? Deno.env.get(couponEnv) || undefined : undefined;
  return couponId ? { priceId, couponId } : { priceId };
}
