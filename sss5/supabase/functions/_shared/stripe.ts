// Shared Stripe client + funnel-plan → price/coupon map.
// Secrets are set via `supabase secrets set` (see migrations/DEPLOY notes).
import Stripe from "npm:stripe@17";

export const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2025-03-31.basil",
  httpClient: Stripe.createFetchHttpClient(),
});

// Used for webhook signature verification in Deno's runtime.
export const cryptoProvider = Stripe.createSubtleCryptoProvider();

export interface PlanConfig {
  priceId: string;
  couponId?: string;
}

// plan key sent by the funnel: "1" | "4" | "8"
export function planConfig(plan: string): PlanConfig | null {
  switch (plan) {
    case "1":
      return { priceId: Deno.env.get("STRIPE_PRICE_1W")! };
    case "4":
      return { priceId: Deno.env.get("STRIPE_PRICE_4W")!, couponId: Deno.env.get("STRIPE_COUPON_4W")! };
    case "8":
      return { priceId: Deno.env.get("STRIPE_PRICE_8W")!, couponId: Deno.env.get("STRIPE_COUPON_8W")! };
    default:
      return null;
  }
}

export function normEmail(e: string): string {
  return (e ?? "").trim().toLowerCase();
}
