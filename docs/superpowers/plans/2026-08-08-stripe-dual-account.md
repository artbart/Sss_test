# Stripe Dual-Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bill new customers on the astronaut Stripe account while existing customers keep being billed on leadoni, with every self-serve billing flow working on both.

**Architecture:** A pure, unit-testable module (`_shared/stripe_accounts.ts`) resolves account labels, price ids and coupon ids from env. A thin client registry (`_shared/stripe.ts`) lazily constructs one `Stripe` client per account and asserts at first use that each key really belongs to its expected `acct_` id. Every Stripe call site reads a `stripe_account` column (default `'leadoni'`) and picks its client from the registry. The webhook identifies the account by which signing secret verifies the payload.

**Tech Stack:** Deno edge functions on Supabase, `npm:stripe@17` pinned to API version `2025-03-31.basil`, Postgres via `supabase db`, tests via `Deno.test` + `https://deno.land/std@0.224.0/assert/mod.ts`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-08-stripe-dual-account-design.md`
- Account labels are exactly `"leadoni"` and `"astronaut"`. No other values.
- `leadoni` = `acct_1TRcmOKD4axecwd4` (shared with PhaseMap). `astronaut` = `acct_1U287eKdnhowNC0W` (SSS-dedicated).
- **Never rename or change an existing `STRIPE_*` secret.** All existing ones mean leadoni. Astronaut uses `STRIPE_ASTRONAUT_*`.
- Coupon ids are identical on both accounts (`da8lCgTH`, `rzYEbzrc`, `bxuG6R1e`), so `STRIPE_COUPON_4W`, `STRIPE_COUPON_8W`, `STRIPE_COUPON_SAVE50` stay single-valued and un-prefixed.
- Migrations are **additive only** — no dropped or altered columns, no altered constraints.
- Deploy from `sss5/`. `config.toml` already pins `verify_jwt = false` per function; do not pass `--no-verify-jwt`.
- **Before deploying any function, download the deployed copy and diff it against local.** Deployed code has been ahead of this tree before. Download each function into its *own* directory — `_shared/` is flattened, so a shared download dir makes one function's `_shared` overwrite another's.
- Run tests with: `cd sss5/supabase/functions && deno test --allow-env _shared/`
- Do NOT touch the funnel publishable key until Task 9. That is the switch that sends real customers to astronaut.

---

### Task 1: Pure account + price resolution module

**Files:**
- Create: `sss5/supabase/functions/_shared/stripe_accounts.ts`
- Test: `sss5/supabase/functions/_shared/stripe_accounts_test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type StripeAccount = "leadoni" | "astronaut"`
  - `const STRIPE_ACCOUNTS: readonly StripeAccount[]` — `["astronaut", "leadoni"]`
  - `const EXPECTED_ACCT_ID: Record<StripeAccount, string>`
  - `function parseAccount(v: string | null | undefined): StripeAccount`
  - `function requiresOwnershipMarker(a: StripeAccount): boolean`
  - `type PriceKey = "1W" | "4W" | "8W" | "LITE" | "LIFETIME" | "STORY_PACK" | "TEST"`
  - `function envKeyFor(a: StripeAccount, suffix: string): string`
  - `function priceFor(a: StripeAccount, key: PriceKey): string | null`
  - `interface PlanConfig { priceId: string; couponId?: string }`
  - `function planConfig(a: StripeAccount, plan: string): PlanConfig | null`

- [ ] **Step 1: Write the failing test**

Create `sss5/supabase/functions/_shared/stripe_accounts_test.ts`:

```ts
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseAccount,
  requiresOwnershipMarker,
  envKeyFor,
  priceFor,
  planConfig,
  EXPECTED_ACCT_ID,
  STRIPE_ACCOUNTS,
} from "./stripe_accounts.ts";

Deno.test("parseAccount defaults null and undefined to leadoni", () => {
  assertEquals(parseAccount(null), "leadoni");
  assertEquals(parseAccount(undefined), "leadoni");
  assertEquals(parseAccount(""), "leadoni");
});

Deno.test("parseAccount passes through known labels", () => {
  assertEquals(parseAccount("leadoni"), "leadoni");
  assertEquals(parseAccount("astronaut"), "astronaut");
});

Deno.test("parseAccount throws on an unknown label rather than guessing", () => {
  assertThrows(() => parseAccount("stripe"), Error, "unknown stripe account");
});

Deno.test("account ids are the real ones and are distinct", () => {
  assertEquals(EXPECTED_ACCT_ID.leadoni, "acct_1TRcmOKD4axecwd4");
  assertEquals(EXPECTED_ACCT_ID.astronaut, "acct_1U287eKdnhowNC0W");
});

Deno.test("astronaut is tried first so the common case short-circuits", () => {
  assertEquals([...STRIPE_ACCOUNTS], ["astronaut", "leadoni"]);
});

Deno.test("only leadoni needs the ownership marker", () => {
  assertEquals(requiresOwnershipMarker("leadoni"), true);
  assertEquals(requiresOwnershipMarker("astronaut"), false);
});

Deno.test("leadoni env keys are unprefixed, astronaut env keys are prefixed", () => {
  assertEquals(envKeyFor("leadoni", "PRICE_1W"), "STRIPE_PRICE_1W");
  assertEquals(envKeyFor("astronaut", "PRICE_1W"), "STRIPE_ASTRONAUT_PRICE_1W");
  assertEquals(envKeyFor("leadoni", "SECRET_KEY"), "STRIPE_SECRET_KEY");
  assertEquals(envKeyFor("astronaut", "SECRET_KEY"), "STRIPE_ASTRONAUT_SECRET_KEY");
});

Deno.test("priceFor reads the account-appropriate env var", () => {
  Deno.env.set("STRIPE_PRICE_1W", "price_leadoni_1w");
  Deno.env.set("STRIPE_ASTRONAUT_PRICE_1W", "price_astronaut_1w");
  assertEquals(priceFor("leadoni", "1W"), "price_leadoni_1w");
  assertEquals(priceFor("astronaut", "1W"), "price_astronaut_1w");
});

Deno.test("priceFor returns null when unset rather than an empty string", () => {
  Deno.env.delete("STRIPE_ASTRONAUT_PRICE_TEST");
  assertEquals(priceFor("astronaut", "TEST"), null);
});

Deno.test("planConfig maps funnel plan keys to the account's price plus coupon", () => {
  Deno.env.set("STRIPE_PRICE_4W", "price_leadoni_4w");
  Deno.env.set("STRIPE_ASTRONAUT_PRICE_4W", "price_astronaut_4w");
  Deno.env.set("STRIPE_COUPON_4W", "da8lCgTH");
  assertEquals(planConfig("leadoni", "4"), { priceId: "price_leadoni_4w", couponId: "da8lCgTH" });
  assertEquals(planConfig("astronaut", "4"), { priceId: "price_astronaut_4w", couponId: "da8lCgTH" });
});

Deno.test("planConfig plan 1 has no coupon", () => {
  Deno.env.set("STRIPE_ASTRONAUT_PRICE_1W", "price_astronaut_1w");
  assertEquals(planConfig("astronaut", "1"), { priceId: "price_astronaut_1w" });
});

Deno.test("planConfig returns null for an unknown plan key", () => {
  assertEquals(planConfig("astronaut", "99"), null);
});

Deno.test("planConfig returns null when the price env var is missing", () => {
  Deno.env.delete("STRIPE_ASTRONAUT_PRICE_8W");
  Deno.env.set("STRIPE_COUPON_8W", "rzYEbzrc");
  assertEquals(planConfig("astronaut", "8"), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sss5/supabase/functions && deno test --allow-env _shared/stripe_accounts_test.ts`
Expected: FAIL — `Module not found "./stripe_accounts.ts"`.

- [ ] **Step 3: Write the implementation**

Create `sss5/supabase/functions/_shared/stripe_accounts.ts`:

```ts
// Which Stripe account a customer belongs to, and how to resolve that account's
// price ids from the environment.
//
// Both accounts have the Stripe display name "StuffSoSweet", so the display
// name is worthless as a safety check — the acct_ id is the only reliable
// discriminator. See docs/superpowers/specs/2026-08-08-stripe-dual-account-design.md
//
// Pure and side-effect free on import: env is read lazily at call time so this
// module can be unit-tested without any live keys.

export type StripeAccount = "leadoni" | "astronaut";

// astronaut first: it is the growing side, so trying it first makes the common
// case short-circuit in the webhook's signature loop.
export const STRIPE_ACCOUNTS: readonly StripeAccount[] = ["astronaut", "leadoni"];

export const EXPECTED_ACCT_ID: Record<StripeAccount, string> = {
  leadoni: "acct_1TRcmOKD4axecwd4", // display name "StuffSoSweet"; shared with PhaseMap
  astronaut: "acct_1U287eKdnhowNC0W", // display name "StuffSoSweet"; SSS-dedicated
};

// Rows written before the dual-account split have no value; they are all leadoni.
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

// Existing secrets are unprefixed and mean leadoni. Never rename them.
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

// Coupon ids are caller-chosen in Stripe and were created identically on both
// accounts, so these env vars are single-valued and NOT account-prefixed.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd sss5/supabase/functions && deno test --allow-env _shared/stripe_accounts_test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add sss5/supabase/functions/_shared/stripe_accounts.ts sss5/supabase/functions/_shared/stripe_accounts_test.ts
git commit -m "Add pure Stripe account + price resolution module"
```

---

### Task 2: Lazy client registry with boot-time account assertion

**Files:**
- Modify: `sss5/supabase/functions/_shared/stripe.ts`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `function stripeFor(a: StripeAccount): Stripe`
  - `async function assertAccount(a: StripeAccount): Promise<void>`
  - `const cryptoProvider` (unchanged export)
  - `function normEmail(e: string): string` (unchanged export)
  - Re-exports `StripeAccount`, `parseAccount`, `planConfig`, `priceFor`, `requiresOwnershipMarker`, `STRIPE_ACCOUNTS`, `EXPECTED_ACCT_ID` so call sites need only one import.
  - **Removes** the old `stripe` singleton and the old one-argument `planConfig(plan)`.

- [ ] **Step 1: Replace the file contents**

Replace `sss5/supabase/functions/_shared/stripe.ts` entirely with:

```ts
// Per-account Stripe clients.
//
// Clients are built LAZILY. Eager construction would mean any function
// importing this module needs BOTH accounts' secret keys set, coupling
// unrelated functions to each other's config.
import Stripe from "npm:stripe@17";
import {
  type StripeAccount,
  EXPECTED_ACCT_ID,
  envKeyFor,
} from "./stripe_accounts.ts";

export {
  type StripeAccount,
  type PlanConfig,
  type PriceKey,
  STRIPE_ACCOUNTS,
  EXPECTED_ACCT_ID,
  parseAccount,
  planConfig,
  priceFor,
  requiresOwnershipMarker,
  envKeyFor,
} from "./stripe_accounts.ts";

const CLIENTS = new Map<StripeAccount, Stripe>();

export function stripeFor(a: StripeAccount): Stripe {
  const cached = CLIENTS.get(a);
  if (cached) return cached;
  const key = Deno.env.get(envKeyFor(a, "SECRET_KEY"));
  if (!key) throw new Error(`${envKeyFor(a, "SECRET_KEY")} is not set`);
  const client = new Stripe(key, {
    apiVersion: "2025-03-31.basil",
    httpClient: Stripe.createFetchHttpClient(),
  });
  CLIENTS.set(a, client);
  return client;
}

// Both accounts are named "StuffSoSweet" and their acct_ ids differ only after
// a shared prefix, so a swapped secret is easy to create and invisible
// afterwards — it would silently bill customers on the wrong account. Verify
// the key actually belongs to the account we think it does.
const ASSERTED = new Set<StripeAccount>();

export async function assertAccount(a: StripeAccount): Promise<void> {
  if (ASSERTED.has(a)) return;
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
```

- [ ] **Step 2: Verify nothing still imports the removed singleton**

Run: `cd sss5/supabase/functions && grep -rn "import { stripe[,} ]" . | grep -v stripeFor`
Expected: six matches (`create-subscription`, `cancel-subscription`, `create-story-pack-checkout`, `retention-offer`, `slack-stats`, `stripe-webhook`). These are fixed in Tasks 4–8. Record the list; it is the checklist for those tasks.

- [ ] **Step 3: Verify the pure module tests still pass**

Run: `cd sss5/supabase/functions && deno test --allow-env _shared/`
Expected: PASS — Task 1's tests plus the pre-existing `access_test.ts` and `retention_test.ts`.

- [ ] **Step 4: Set the missing leadoni story-pack secret**

The leadoni story-pack price is currently a hardcoded constant in `create-story-pack-checkout`. It must become an env var so both accounts resolve the same way.

```bash
cd sss5 && supabase secrets set \
  STRIPE_PRICE_STORY_PACK=price_1U15jjKD4axecwd4bal2iilJ \
  --project-ref gmhbcxylqubhxozomhlt
```

Expected: `"count":1`.

- [ ] **Step 5: Commit**

```bash
git add sss5/supabase/functions/_shared/stripe.ts
git commit -m "Replace Stripe singleton with a lazy per-account client registry"
```

---

### Task 3: Add the routing column

**Files:**
- Create: `sss5/supabase/migrations/20260808_stripe_account_column.sql`

**Interfaces:**
- Consumes: the label values from Task 1.
- Produces: `users.stripe_account`, `quiz_sessions.stripe_account`, `quiz2_sessions.stripe_account` — all `text not null default 'leadoni'`.

- [ ] **Step 1: Write the migration**

Create `sss5/supabase/migrations/20260808_stripe_account_column.sql`:

```sql
-- Which Stripe account bills this customer.
--
-- Defaulting to 'leadoni' means every pre-existing row is correct the moment
-- the column exists, so there is no backfill pass and no window where rows are
-- unrouted. Only new signups write 'astronaut'.
--
-- Additive only: no existing column or constraint is altered.

alter table public.users
  add column if not exists stripe_account text not null default 'leadoni';

alter table public.quiz_sessions
  add column if not exists stripe_account text not null default 'leadoni';

alter table public.quiz2_sessions
  add column if not exists stripe_account text not null default 'leadoni';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_stripe_account_check') then
    alter table public.users
      add constraint users_stripe_account_check
      check (stripe_account in ('leadoni','astronaut'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quiz_sessions_stripe_account_check') then
    alter table public.quiz_sessions
      add constraint quiz_sessions_stripe_account_check
      check (stripe_account in ('leadoni','astronaut'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quiz2_sessions_stripe_account_check') then
    alter table public.quiz2_sessions
      add constraint quiz2_sessions_stripe_account_check
      check (stripe_account in ('leadoni','astronaut'));
  end if;
end $$;
```

- [ ] **Step 2: Apply it**

```bash
cd /Users/mintarasgrinius/Documents/sss-app && \
supabase db query --linked "$(cat sss-home/sss5/supabase/migrations/20260808_stripe_account_column.sql)"
```

Expected: no error.

- [ ] **Step 3: Verify every existing row routes to leadoni**

```bash
supabase db query --linked "select stripe_account, count(*) from public.users group by 1;"
```
Expected: a single row, `leadoni`, with the full user count. **If any row reads `astronaut`, stop** — the default was applied wrongly.

- [ ] **Step 4: Verify the constraint rejects a bad value**

```bash
supabase db query --linked "update public.users set stripe_account='stripe' where false;"
```
Expected: succeeds (zero rows). Then:
```bash
supabase db query --linked "select 'x'::text where 'stripe' in ('leadoni','astronaut');"
```
Expected: zero rows, confirming the allowed set.

- [ ] **Step 5: Commit**

```bash
git add sss5/supabase/migrations/20260808_stripe_account_column.sql
git commit -m "Add stripe_account routing column, defaulted to leadoni"
```

---

### Task 4: `create-subscription` → astronaut

**Files:**
- Modify: `sss5/supabase/functions/create-subscription/index.ts`

**Interfaces:**
- Consumes: `stripeFor`, `planConfig`, `assertAccount`, `type StripeAccount` from `_shared/stripe.ts`.
- Produces: quiz session rows carrying `stripe_account`.

**Note:** this task leaves the account as `"leadoni"` behind a single named constant. Task 9 flips it. Splitting it this way means the refactor ships and is proven under real traffic before any customer is routed anywhere new.

- [ ] **Step 1: Change the import and add the account constant**

Replace the import line:
```ts
import { stripe, planConfig, normEmail } from "../_shared/stripe.ts";
```
with:
```ts
import { stripeFor, planConfig, normEmail, assertAccount, type StripeAccount } from "../_shared/stripe.ts";

// The account NEW signups are created on. Flipped to "astronaut" at cutover;
// see docs/superpowers/plans/2026-08-08-stripe-dual-account.md Task 9.
const SIGNUP_ACCOUNT: StripeAccount = "leadoni";
```

- [ ] **Step 2: Bind the client once at the top of the request handler**

Immediately after the method check inside `Deno.serve`, add:
```ts
  await assertAccount(SIGNUP_ACCOUNT);
  const stripe = stripeFor(SIGNUP_ACCOUNT);
```
Every existing `stripe.` call in the file now resolves to this local binding — no other call site in this file changes.

- [ ] **Step 3: Pass the account to planConfig**

Find the `planConfig(` call and change it to `planConfig(SIGNUP_ACCOUNT, plan)`.

- [ ] **Step 4: Stamp the account on the quiz session**

Find where the function updates the quiz session with `stripe_customer_id` / `stripe_subscription_id` and add `stripe_account: SIGNUP_ACCOUNT` to the same update object. If there is more than one such update, add it to each.

- [ ] **Step 5: Type-check**

Run: `cd sss5/supabase/functions && deno check create-subscription/index.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add sss5/supabase/functions/create-subscription/index.ts
git commit -m "Make create-subscription account-aware (still leadoni)"
```

---

### Task 5: `cancel-subscription` and `create-story-pack-checkout`

**Files:**
- Modify: `sss5/supabase/functions/cancel-subscription/index.ts`
- Modify: `sss5/supabase/functions/create-story-pack-checkout/index.ts`

**Interfaces:**
- Consumes: `stripeFor`, `parseAccount`, `priceFor` from `_shared/stripe.ts`; `users.stripe_account` from Task 3.
- Produces: nothing new.

- [ ] **Step 1: `cancel-subscription` — import, select, bind**

Change the import to:
```ts
import { stripeFor, parseAccount } from "../_shared/stripe.ts";
```
Change the profile select to include the column:
```ts
    .select("stripe_subscription_id, subscription_status, stripe_account")
```
After the `!profile?.stripe_subscription_id` guard, bind the client:
```ts
  const stripe = stripeFor(parseAccount(profile.stripe_account));
```

- [ ] **Step 2: `create-story-pack-checkout` — remove the hardcoded price**

Change the import to:
```ts
import { stripeFor, parseAccount, priceFor, normEmail } from "../_shared/stripe.ts";
```
Delete the `STORY_PACK_PRICE_ID` constant and its comment. Where the user profile is loaded, ensure the select includes `stripe_account`, then before the Stripe call add:

```ts
  const account = parseAccount(profile.stripe_account);
  const stripe = stripeFor(account);
  const storyPackPrice = priceFor(account, "STORY_PACK");
  if (!storyPackPrice) {
    console.error("story pack price not configured for account", account);
    return jsonResponse({ error: "Story packs are unavailable right now" }, 503);
  }
```
Replace every use of `STORY_PACK_PRICE_ID` with `storyPackPrice`.

- [ ] **Step 3: Stamp the account on the checkout session metadata**

In the `stripe.checkout.sessions.create({...})` call, add `stripe_account: account` to the `metadata` object so the webhook can cross-check which account fulfilled the purchase.

- [ ] **Step 4: Type-check both**

Run: `cd sss5/supabase/functions && deno check cancel-subscription/index.ts create-story-pack-checkout/index.ts`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add sss5/supabase/functions/cancel-subscription/index.ts sss5/supabase/functions/create-story-pack-checkout/index.ts
git commit -m "Route cancel and story-pack checkout by stripe_account"
```

---

### Task 6: `retention-offer`

**Files:**
- Modify: `sss5/supabase/functions/retention-offer/index.ts`

**Interfaces:**
- Consumes: `stripeFor`, `parseAccount`, `priceFor` from `_shared/stripe.ts`; `users.stripe_account`.
- Produces: nothing new.

This file has seven `stripe.` call sites and uses `STRIPE_PRICE_LITE`, `STRIPE_PRICE_LIFETIME` and `STRIPE_COUPON_SAVE50`. Bind once; the coupon env var is deliberately unchanged because the id is identical on both accounts.

- [ ] **Step 1: Change the import**

```ts
import { stripeFor, parseAccount, priceFor } from "../_shared/stripe.ts";
```

- [ ] **Step 2: Select the column**

Change the profile select to:
```ts
    .select("id, email, stripe_subscription_id, stripe_customer_id, stripe_account")
```

- [ ] **Step 3: Bind the client and prices once, right after the profile loads**

Immediately after the profile-not-found guard, add:
```ts
  const account = parseAccount(profile.stripe_account);
  const stripe = stripeFor(account);
  const litePriceId = priceFor(account, "LITE");
  const lifetimePriceId = priceFor(account, "LIFETIME");
```

- [ ] **Step 4: Replace the direct env reads for prices**

Replace every `Deno.env.get("STRIPE_PRICE_LITE")` with `litePriceId` and every `Deno.env.get("STRIPE_PRICE_LIFETIME")` with `lifetimePriceId`. Leave `Deno.env.get("STRIPE_COUPON_SAVE50")` exactly as it is — coupon `bxuG6R1e` exists with the same id on both accounts.

- [ ] **Step 5: Guard the rungs that need a price**

Before each branch that uses `litePriceId` or `lifetimePriceId`, add a null check that returns a graceful response rather than passing `undefined` to Stripe. Example for the lite rung:
```ts
  if (!litePriceId) {
    console.error("lite price not configured for account", account);
    return jsonResponse({ error: "That offer is unavailable right now" }, 503);
  }
```

- [ ] **Step 6: Type-check**

Run: `cd sss5/supabase/functions && deno check retention-offer/index.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add sss5/supabase/functions/retention-offer/index.ts
git commit -m "Route retention-offer by stripe_account"
```

---

### Task 7: `stripe-webhook` dual signature verification

**Files:**
- Modify: `sss5/supabase/functions/stripe-webhook/index.ts`

**Interfaces:**
- Consumes: `stripeFor`, `cryptoProvider`, `STRIPE_ACCOUNTS`, `envKeyFor`, `requiresOwnershipMarker`, `type StripeAccount`.
- Produces: an `account: StripeAccount` value threaded to every handler and written to `users.stripe_account` / quiz session rows on insert.

**This is the highest-risk task.** The account must be threaded through, never re-derived. `stripe.subscriptions.cancel(...)` during lifetime fulfilment on the wrong client throws and fires the `lifetime_cancel_failed` 🚨 alert — the customer holds lifetime *and* keeps being billed.

- [ ] **Step 1: Change the import and drop the single-secret constant**

Replace the `import { stripe, cryptoProvider }` line with:
```ts
import {
  stripeFor,
  cryptoProvider,
  STRIPE_ACCOUNTS,
  envKeyFor,
  requiresOwnershipMarker,
  type StripeAccount,
} from "../_shared/stripe.ts";
```
Delete `const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;`.

- [ ] **Step 2: Add the dual verifier**

Add above `Deno.serve`:
```ts
// One endpoint is registered in BOTH Stripe accounts. Whichever signing secret
// verifies the payload identifies the account the event came from. An HMAC is
// microseconds, so the failed first attempt costs nothing measurable.
async function verifyEvent(
  raw: string,
  sig: string,
  // deno-lint-ignore no-explicit-any
): Promise<{ event: any; account: StripeAccount } | null> {
  for (const account of STRIPE_ACCOUNTS) {
    const secret = Deno.env.get(envKeyFor(account, "WEBHOOK_SECRET"));
    if (!secret) continue;
    try {
      const event = await stripeFor(account).webhooks.constructEventAsync(
        raw, sig, secret, undefined, cryptoProvider,
      );
      return { event, account };
    } catch {
      // wrong account's secret — try the next
    }
  }
  return null;
}
```

- [ ] **Step 3: Use it in the handler**

Replace the existing `constructEventAsync` call and its surrounding try/catch with:
```ts
  const verified = await verifyEvent(raw, sig);
  if (!verified) {
    console.error("webhook signature matched no configured account");
    return new Response("Bad signature", { status: 400 });
  }
  const { event, account } = verified;
  const stripe = stripeFor(account);
  console.log(`webhook ${event.type} from ${account}`);
```

- [ ] **Step 4: Make the ownership guard account-aware**

Change the `ours()` helper to take the account:
```ts
// deno-lint-ignore no-explicit-any
function ours(sub: any, account: StripeAccount): boolean {
  if (!requiresOwnershipMarker(account)) return true;
  return !!sub?.metadata?.session_id;
}
```
Update every call site to pass `account`.

- [ ] **Step 5: Stamp the account on every row the webhook writes**

Add `stripe_account: account` to each insert/update object that already sets `stripe_customer_id` or `stripe_subscription_id` — on `users`, `quiz_sessions` and `quiz2_sessions`.

- [ ] **Step 6: Type-check**

Run: `cd sss5/supabase/functions && deno check stripe-webhook/index.ts`
Expected: no errors.

- [ ] **Step 7: Confirm no bare `stripe.` remains outside the handler scope**

Run: `cd sss5/supabase/functions && grep -n "stripe\." stripe-webhook/index.ts`
Expected: every match is inside the request handler, below the `const stripe = stripeFor(account)` binding. Any match above it is a bug — it would have no client to resolve.

- [ ] **Step 8: Commit**

```bash
git add sss5/supabase/functions/stripe-webhook/index.ts
git commit -m "Verify webhooks against both accounts and thread the account through"
```

---

### Task 8: `slack-stats` aggregates both accounts

**Files:**
- Modify: `sss5/supabase/functions/slack-stats/index.ts`

**Interfaces:**
- Consumes: `stripeFor`, `STRIPE_ACCOUNTS`, `requiresOwnershipMarker`, `priceFor`, `type StripeAccount`.
- Produces: a combined report; no new exports.

- [ ] **Step 1: Change the import**

```ts
import {
  stripeFor,
  STRIPE_ACCOUNTS,
  requiresOwnershipMarker,
  priceFor,
  envKeyFor,
  type StripeAccount,
} from "../_shared/stripe.ts";
```

- [ ] **Step 2: Make the ownership and test-price helpers account-aware**

```ts
// deno-lint-ignore no-explicit-any
function ours(sub: any, account: StripeAccount): boolean {
  if (!requiresOwnershipMarker(account)) return true;
  return !!sub?.metadata?.session_id;
}
```
Replace the module-level `TEST_PRICE_IDS` set with one built from both accounts, so astronaut's test price is excluded too:
```ts
function testPriceIds(): Set<string> {
  const ids = new Set<string>();
  for (const a of STRIPE_ACCOUNTS) {
    const id = priceFor(a, "TEST");
    if (id) ids.add(id);
  }
  return ids;
}
```
Change `isTestSub` to take the set as a parameter.

- [ ] **Step 3: Wrap the gathering loops per account**

Extract the body of `gatherStatsText` that walks Stripe into a helper taking `(account, stripe)` and accumulating into the existing `Win` objects and counters, then call it once per account in `STRIPE_ACCOUNTS`. The `subCache` must be **per account** — a `sub_...` id is only meaningful on its own account, and sharing one cache across both would let a leadoni id answer an astronaut lookup.

- [ ] **Step 4: Build PLAN_LABELS from both accounts**

Replace the module-level `PLAN_LABELS` loop with one that iterates `STRIPE_ACCOUNTS` × `["1W","4W","8W"]`, mapping each resolved price id to the same label, so `8w` from either account aggregates into one plan-mix entry.

- [ ] **Step 5: Type-check**

Run: `cd sss5/supabase/functions && deno check slack-stats/index.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add sss5/supabase/functions/slack-stats/index.ts
git commit -m "Aggregate /stats across both Stripe accounts"
```

---

### Task 9: Deploy, then cut over

**Files:**
- Modify: `quiz/a.html` (publishable key)
- Modify: `quiz2/index.html` (publishable key)
- Modify: `sss5/quiz.html` (dev mirror, for consistency)
- Modify: `sss5/supabase/functions/create-subscription/index.ts` (`SIGNUP_ACCOUNT`)

**Interfaces:**
- Consumes: everything above.
- Produces: live traffic on astronaut.

- [ ] **Step 1: Drift-check before deploying**

For each of `create-subscription`, `cancel-subscription`, `create-story-pack-checkout`, `retention-offer`, `stripe-webhook`, `slack-stats`, download the deployed copy into its **own** directory and diff against local:

```bash
B=/private/tmp/claude-501/-Users-mintarasgrinius-Documents-sss-app/*/scratchpad/predeploy
L=/Users/mintarasgrinius/Documents/sss-app/sss-home/sss5/supabase/functions
rm -rf $B; mkdir -p $B
for f in create-subscription cancel-subscription create-story-pack-checkout retention-offer stripe-webhook slack-stats; do
  mkdir -p $B/$f && cd $B/$f && supabase init --force >/dev/null 2>&1
  supabase functions download "$f" --project-ref gmhbcxylqubhxozomhlt >/dev/null 2>&1
  diff -q $B/$f/supabase/functions/$f/index.ts $L/$f/index.ts >/dev/null \
    && echo "$f: local == deployed (pre-change baseline drifted!)" \
    || echo "$f: differs (expected — your changes)"
done
```
Review each diff and confirm every difference is one of yours. **If a deployed file contains something you did not write, stop and reconcile.**

- [ ] **Step 2: Deploy all six functions**

```bash
cd /Users/mintarasgrinius/Documents/sss-app/sss-home/sss5
for f in create-subscription cancel-subscription create-story-pack-checkout retention-offer stripe-webhook slack-stats; do
  supabase functions deploy "$f" --project-ref gmhbcxylqubhxozomhlt
done
```
Expected: six `"message":"Deployed Functions."`.

- [ ] **Step 3: Verify NOTHING changed for existing customers**

This is the whole point of deploying before flipping. With `SIGNUP_ACCOUNT` still `"leadoni"`, exercise the live system:
- Run `/stats-sss` in Slack. Expected: numbers match the previous run (astronaut has no data to add).
- On a real leadoni test account, open the cancel flow and reach the retention offer, then back out.

**If either misbehaves, stop.** The refactor is wrong and no customer has been routed anywhere yet.

- [ ] **Step 4: Commit the verified refactor**

```bash
git commit --allow-empty -m "Verified dual-account refactor live with signups still on leadoni"
```

- [ ] **Step 5: Flip the signup account**

In `sss5/supabase/functions/create-subscription/index.ts`:
```ts
const SIGNUP_ACCOUNT: StripeAccount = "astronaut";
```
Deploy: `cd sss5 && supabase functions deploy create-subscription --project-ref gmhbcxylqubhxozomhlt`

- [ ] **Step 6: Swap the funnel publishable key**

In `quiz/a.html`, `quiz2/index.html` and `sss5/quiz.html`, replace the `STRIPE_PUBLISHABLE_KEY` value with:
```
pk_live_51U287eKdnhowNC0W2El5F5tnREZd1h6gJpNquWoYH3qE1dXxIN5hgLXlJquMjCZaAPJTVjagfTTrxjotd6KCqYws00c5Em8gEd
```
Also update the stale comment above it — it currently says "(TEST). Safe to ship. Swap to the live pk_live_ key at go-live", which has been wrong since go-live.

- [ ] **Step 7: Verify the key landed in all three files**

Run: `cd /Users/mintarasgrinius/Documents/sss-app/sss-home && grep -rn "pk_live_51" quiz/a.html quiz2/index.html sss5/quiz.html`
Expected: three matches, all `pk_live_51U287e…`. **Zero matches for `51TRcmO`.**

- [ ] **Step 8: Commit and deploy the funnel**

```bash
git add quiz/a.html quiz2/index.html sss5/quiz.html sss5/supabase/functions/create-subscription/index.ts
git commit -m "Cut new signups over to the astronaut Stripe account"
```
Then publish the site by whatever the repo's normal deploy is (`./deploy-cf.sh`).

- [ ] **Step 9: End-to-end verification with a real card**

1. Complete a real signup through the live funnel.
2. Confirm in Stripe that the customer and subscription exist on **astronaut** (`acct_1U287e…`), not leadoni.
3. Confirm the 🎉 purchase alert lands in `#sss-notifications`.
4. Confirm the `users` row has `stripe_account = 'astronaut'`:
   ```bash
   supabase db query --linked "select email, stripe_account, stripe_customer_id from public.users order by created_at desc limit 3;"
   ```
5. Cancel that subscription through the app and confirm it cancels on astronaut.
6. Run `/stats-sss` and confirm the new subscriber appears and totals are not double-counted.

- [ ] **Step 10: Rollback trigger**

If any of step 9 fails: set `SIGNUP_ACCOUNT` back to `"leadoni"`, revert the three publishable keys, redeploy and republish. Anyone already created on astronaut keeps working — the routing column leaves both accounts serviceable, so there is no state to unwind.

---

## Self-Review

**Spec coverage.** Registry + boot assertion → Task 2. Routing column → Task 3. Per-account price map → Task 1. Coupons un-prefixed → Task 1. Six call sites → Tasks 4–8. Webhook try-both → Task 7. Per-account ownership filter → Tasks 7, 8. Story-pack price out of the hardcoded constant → Task 5. Funnel key → Task 9. Staged cutover → Task 9 steps 3–5. Rollback → Task 9 step 10. Astronaut test price joining `TEST_PRICE_IDS` → Task 8 step 2.

**Not covered by any task, deliberately:** the settlement-currency question (astronaut is LT/EUR with USD prices). It is a business decision recorded in the spec, not code.

**Type consistency.** `stripeFor`, `parseAccount`, `priceFor`, `planConfig`, `requiresOwnershipMarker`, `envKeyFor`, `assertAccount`, `STRIPE_ACCOUNTS`, `EXPECTED_ACCT_ID`, `StripeAccount`, `PriceKey`, `PlanConfig` are defined in Tasks 1–2 and used with those exact names in Tasks 4–8. `ours(sub, account)` takes the same two arguments in Tasks 7 and 8.
