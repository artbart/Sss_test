// Per-account Stripe clients.
//
// Clients are built LAZILY. Eager construction would mean any function
// importing this module needs BOTH accounts' secret keys set, coupling
// unrelated functions to each other's config — cancel-subscription would fail
// to boot over a missing astronaut key it never uses.
//
// Account resolution and price lookup live in ./stripe_accounts.ts, which is
// pure and unit-tested. This file is only the client plumbing.
import Stripe from "npm:stripe@17";
import { type StripeAccount, EXPECTED_ACCT_ID, envKeyFor } from "./stripe_accounts.ts";

// Re-exported so call sites need a single import.
export {
  EXPECTED_ACCT_ID,
  envKeyFor,
  parseAccount,
  planConfig,
  priceFor,
  requiresOwnershipMarker,
  STRIPE_ACCOUNTS,
} from "./stripe_accounts.ts";
export type { PlanConfig, PriceKey, StripeAccount } from "./stripe_accounts.ts";

const CLIENTS = new Map<StripeAccount, Stripe>();

export function stripeFor(a: StripeAccount): Stripe {
  const cached = CLIENTS.get(a);
  if (cached) return cached;
  const envKey = envKeyFor(a, "SECRET_KEY");
  const key = Deno.env.get(envKey);
  if (!key) throw new Error(`${envKey} is not set`);
  const client = new Stripe(key, {
    // npm:stripe@17's types only know "2025-02-24.acacia", but this codebase is
    // written against Basil semantics throughout (invoice.parent.
    // subscription_details, confirmation_secret, the invoice_payments REST
    // fallback in slack-stats). The runtime value is correct; the types are
    // stale, so cast rather than downgrade the pin.
    apiVersion: "2025-03-31.basil" as Stripe.StripeConfig["apiVersion"],
    httpClient: Stripe.createFetchHttpClient(),
  });
  CLIENTS.set(a, client);
  return client;
}

// Both accounts are named "StuffSoSweet" and their acct_ ids differ only after
// a shared prefix, so a swapped secret is easy to create and invisible
// afterwards — it would silently bill customers on the wrong account. Verify
// once per worker that the key really belongs to the account we think it does.
const ASSERTED = new Set<StripeAccount>();

export async function assertAccount(a: StripeAccount): Promise<void> {
  if (ASSERTED.has(a)) return;
  // accounts.retrieve() with no id returns the account owning the key.
  // deno-lint-ignore no-explicit-any
  const acct = (await (stripeFor(a) as any).accounts.retrieve()) as { id?: string };
  if (acct?.id !== EXPECTED_ACCT_ID[a]) {
    throw new Error(
      `${envKeyFor(a, "SECRET_KEY")} belongs to ${acct?.id ?? "unknown"}, expected ${EXPECTED_ACCT_ID[a]}`,
    );
  }
  ASSERTED.add(a);
}

// Used for webhook signature verification in Deno's runtime.
export const cryptoProvider = Stripe.createSubtleCryptoProvider();

export function normEmail(e: string): string {
  return (e ?? "").trim().toLowerCase();
}
