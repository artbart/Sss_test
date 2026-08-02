# Retention Save-Flow with Lifetime Offer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unconditional cancel button with a branched save-flow that captures a cancellation reason and offers pause / discount / downgrade / lifetime before letting the user go.

**Architecture:** A modal in `settings.html` sits in front of the existing `cancel-subscription` call. A new `retention-offer` edge function executes whichever rung the user accepts. Lifetime is a one-time Stripe Checkout payment fulfilled by a new `stripe-webhook` branch that writes a `users.lifetime_at` entitlement, which the shared access module honours everywhere.

**Tech Stack:** Deno edge functions (Supabase), Stripe Node SDK v17 (Basil API `2025-03-31`), `@supabase/supabase-js@2.45.4`, vanilla ES modules in the frontend, `deno test` for pure-logic unit tests.

**Spec:** `docs/superpowers/specs/2026-08-01-retention-save-flow-design.md`

## Global Constraints

- **Supabase project `gmhbcxylqubhxozomhlt` is shared.** All migrations are strictly additive: `add column if not exists`, `create table if not exists`. Never drop, rename, or alter `casp_notes` or any table not named in this plan.
- **The Stripe account is shared with another product (PhaseMap).** Every webhook branch must verify the event belongs to Stuff So Sweet before writing anything. The existing `ours(sub)` guard only works for subscription events; the new one-time-payment branch needs its own check (Task 7).
- **Deployed edge functions may be ahead of the local copies.** Task 0 is a hard prerequisite; do not skip it.
- **The only local copy of the edge functions is `Sss_test/sss5/supabase/functions/`.** The top-level `supabase/functions/` is an empty linked-project shell. All function paths below are relative to the repo root `/Users/mintarasgrinius/Documents/sss-app`.
- **Access is paid-through, not status-based.** A `cancel_at_period_end` user keeps access until `current_period_end`. Do not "fix" this.
- **`MONTHLY_STORY_LIMIT` values:** `standard` → 3, `lite` → 1. Lifetime holders get `standard`.
- **Offer values:** pause 4 weeks; discount 50% off one cycle; lifetime $79 one-time; downgrade $9.99 / 4 weeks.
- **New Stripe env vars** (set via `supabase secrets set`, following the existing `STRIPE_PRICE_4W` convention): `STRIPE_PRICE_LIFETIME`, `STRIPE_PRICE_LITE`, `STRIPE_COUPON_SAVE50`, `APP_URL`.
- **Repo is not under version control.** `git rev-parse` fails at the repo root. Task 0 offers `git init`; if it is declined, skip every `git commit` step in this plan and use the stated verification command as the task gate instead.
- **Line numbers in this plan rot.** Several were invalidated mid-execution by earlier tasks editing the same files (e.g. Task 0b's v5 reconciliation shifted everything below it in `start-authenticated-story-v2/index.ts`). Locate anchors by content — a distinctive comment, string, or function/variable name — not by the line number printed here, and re-derive the anchor before editing.
- **`deno check` never passes clean on a Stripe-touching file in this repo.** `_shared/stripe.ts:6` pins `apiVersion: "2025-03-31.basil"`, while the cached `npm:stripe@17` types only know `"2025-02-24.acacia"` — a `TS2322` that also reproduces on the untouched, in-production `cancel-subscription`. It is a stale-types issue, not a runtime bug; deployed functions work fine. The gate actually used for every Stripe-touching typecheck below (Tasks 5, 6, 7, and the Task 11 sweep): run `deno check` and confirm there is **exactly one** error, at `_shared/stripe.ts:6:3`. A second error is real and must be fixed.

---

### Task 0: Sync local functions with deployed, and establish version control

Without this, deploying any function in this plan silently overwrites remote work that exists only on Supabase.

**Files:**
- Modify: `Sss_test/sss5/supabase/functions/**` (whatever the diff reveals)
- Create: `.gitignore` (only if `git init` is accepted)

- [ ] **Step 1: Pull the deployed functions to a scratch directory**

```bash
cd /Users/mintarasgrinius/Documents/sss-app
mkdir -p /private/tmp/claude-501/sss-remote && cd /private/tmp/claude-501/sss-remote
supabase functions download cancel-subscription --project-ref gmhbcxylqubhxozomhlt
supabase functions download stripe-webhook --project-ref gmhbcxylqubhxozomhlt
supabase functions download start-authenticated-story-v2 --project-ref gmhbcxylqubhxozomhlt
supabase functions download start-authenticated-story --project-ref gmhbcxylqubhxozomhlt
supabase functions download submit-choice --project-ref gmhbcxylqubhxozomhlt
```

- [ ] **Step 2: Diff each against local**

```bash
for f in cancel-subscription stripe-webhook start-authenticated-story-v2 start-authenticated-story submit-choice; do
  echo "=== $f ==="
  diff -u "/Users/mintarasgrinius/Documents/sss-app/Sss_test/sss5/supabase/functions/$f/index.ts" \
          "/private/tmp/claude-501/sss-remote/supabase/functions/$f/index.ts"
done
```

Expected: no output means local matches deployed. **Any output is a blocker** — reconcile by copying the remote version over local (remote is the source of truth for deployed behaviour) and re-reading it before continuing. Report what differed.

- [ ] **Step 3: Initialise version control (ask the user first)**

This plan's commit steps assume a repo. Ask the user whether to run this; if they decline, note it and skip all `git commit` steps.

```bash
cd /Users/mintarasgrinius/Documents/sss-app
git init
printf 'node_modules/\nsupabase/.temp/\n.DS_Store\n' > .gitignore
git add -A && git commit -m "chore: initial commit of existing tree"
```

- [ ] **Step 4: Verify**

Run: `cd /Users/mintarasgrinius/Documents/sss-app && git status --short | head`
Expected: clean tree (or, if git was declined, `fatal: not a git repository` — that is an accepted state).

---

### Task 1: Add the entitlement columns

**Files:**
- Create: `Sss_test/sss5/supabase/migrations/20260801_retention.sql`

**Interfaces:**
- Produces: `users.lifetime_at timestamptz`, `users.plan_tier text default 'standard'` — consumed by Tasks 2, 5, 6, 7, 9, 10.

- [ ] **Step 1: Write the migration**

```sql
-- Retention save-flow: lifetime entitlement + plan tiers.
-- Strictly additive. Does NOT touch casp_notes or any unrelated table.
-- Target project: gmhbcxylqubhxozomhlt

alter table public.users
  add column if not exists lifetime_at timestamptz,
  add column if not exists plan_tier   text not null default 'standard';

-- Only two tiers exist today. Guard against typos writing a tier that
-- storyLimitFor() would silently treat as 'standard'.
alter table public.users
  drop constraint if exists users_plan_tier_check;
alter table public.users
  add constraint users_plan_tier_check
  check (plan_tier in ('standard', 'lite'));

create index if not exists users_lifetime_at_idx
  on public.users (lifetime_at)
  where lifetime_at is not null;
```

- [ ] **Step 2: Apply it**

```bash
cd /Users/mintarasgrinius/Documents/sss-app
supabase db push --project-ref gmhbcxylqubhxozomhlt
```

- [ ] **Step 3: Verify the columns exist and nothing else changed**

```bash
supabase db query --project-ref gmhbcxylqubhxozomhlt \
  "select column_name, data_type, column_default from information_schema.columns
   where table_schema='public' and table_name='users'
     and column_name in ('lifetime_at','plan_tier') order by column_name"
```

Expected: two rows — `lifetime_at | timestamp with time zone | NULL` and `plan_tier | text | 'standard'::text`.

> **Correction:** the plan originally used `supabase db execute`, which does not exist as a
> subcommand — it is `supabase db query`. Note also that `db query --linked` requires a properly
> linked project (a `supabase/config.toml`), which this checkout does not have, so this command may
> need to be run from an environment that is actually linked, or via the Supabase dashboard's SQL
> editor instead.

- [ ] **Step 4: Commit**

```bash
git add Sss_test/sss5/supabase/migrations/20260801_retention.sql
git commit -m "feat: add lifetime_at and plan_tier to users"
```

---

### Task 2: Teach the shared access module about lifetime and tiers

`_shared/access.ts` already exists and is the intended home for this logic, but today only `submit-choice` uses it. This task extends it; Task 3 makes everyone use it.

**Files:**
- Modify: `Sss_test/sss5/supabase/functions/_shared/access.ts`
- Test: `Sss_test/sss5/supabase/functions/_shared/access_test.ts` (create)

**Interfaces:**
- Produces:
  - `interface AccessInfo { periodEnd: string | null; subStatus: string | null; lifetimeAt: string | null; planTier: string }`
  - `hasAccess(info: AccessInfo): boolean` — now true if lifetime OR paid-through
  - `storyLimitFor(planTier: string | null | undefined): number`
- Consumed by Tasks 3, 5, 10.

- [ ] **Step 1: Write the failing test**

Create `Sss_test/sss5/supabase/functions/_shared/access_test.ts`:

```typescript
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hasAccess, storyLimitFor, type AccessInfo } from "./access.ts";

const FUTURE = new Date(Date.now() + 7 * 864e5).toISOString();
const PAST = new Date(Date.now() - 7 * 864e5).toISOString();

function info(over: Partial<AccessInfo> = {}): AccessInfo {
  return { periodEnd: null, subStatus: null, lifetimeAt: null, planTier: "standard", ...over };
}

Deno.test("paid-through user has access", () => {
  assertEquals(hasAccess(info({ periodEnd: FUTURE })), true);
});

Deno.test("expired user has no access", () => {
  assertEquals(hasAccess(info({ periodEnd: PAST })), false);
});

Deno.test("lifetime holder has access despite an expired period", () => {
  assertEquals(hasAccess(info({ periodEnd: PAST, lifetimeAt: PAST, subStatus: "canceled" })), true);
});

Deno.test("lifetime holder has access with no subscription at all", () => {
  assertEquals(hasAccess(info({ lifetimeAt: PAST })), true);
});

Deno.test("no subscription and no lifetime means no access", () => {
  assertEquals(hasAccess(info()), false);
});

Deno.test("standard tier gets 3 stories", () => {
  assertEquals(storyLimitFor("standard"), 3);
});

Deno.test("lite tier gets 1 story", () => {
  assertEquals(storyLimitFor("lite"), 1);
});

Deno.test("unknown or missing tier falls back to standard", () => {
  assertEquals(storyLimitFor(null), 3);
  assertEquals(storyLimitFor(undefined), 3);
  assertEquals(storyLimitFor("nonsense"), 3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/mintarasgrinius/Documents/sss-app/Sss_test/sss5/supabase/functions && deno test --allow-all _shared/access_test.ts`
Expected: FAIL — `storyLimitFor` is not exported, and `AccessInfo` has no `lifetimeAt` / `planTier`.

- [ ] **Step 3: Extend `access.ts`**

Replace the `AccessInfo` interface and `hasAccess` function, and add `storyLimitFor`. The `resolveAccess` `users` branch must also select the new columns.

```typescript
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

// True when the user holds lifetime, or the paid-through date is in the future.
export function hasAccess(info: AccessInfo): boolean {
  if (info.lifetimeAt) return true;
  return !!info.periodEnd && new Date(info.periodEnd) >= new Date();
}
```

In `resolveAccess`, change the `users` lookup to:

```typescript
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
```

The two `quiz_sessions` / `quiz2_sessions` fallback branches are pre-signup leads who cannot hold lifetime. Return the new fields as defaults so the type is satisfied — add `lifetimeAt: null, planTier: "standard"` to the object built from `best`, and to the final `return { periodEnd: null, subStatus: null }` fallback.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/mintarasgrinius/Documents/sss-app/Sss_test/sss5/supabase/functions && deno test --allow-all _shared/access_test.ts`
Expected: PASS — 8 passed.

- [ ] **Step 5: Commit**

```bash
git add Sss_test/sss5/supabase/functions/_shared/access.ts Sss_test/sss5/supabase/functions/_shared/access_test.ts
git commit -m "feat: lifetime and plan-tier awareness in shared access module"
```

---

### Task 3: Route every access gate through the shared module

**This is the task that makes lifetime actually work.** There are currently four gates and all four are inlined comparisons — including `submit-choice`, which imports `access.ts` but never calls its decision function. Patching only the story-v2 gate would leave a lifetime holder able to start a story but unable to read the next chapter.

> **Correction (post-implementation):** this task originally listed `submit-choice` as
> "Verify only ... already imports `access.ts`; inherits the fix." That claim was false, and the
> plan repeated a mistake the controller made live during execution. `submit-choice` imported
> `resolveAccess` but then destructured `{ periodEnd }` from it and ran its own inlined date
> comparison, ignoring `lifetimeAt` entirely — a fourth gate hiding behind a correct-looking
> import. Had it shipped, a lifetime holder could start a story but never read chapter two. Fixed
> during implementation (commits 25196da..876b116, review clean). `submit-choice` is a required
> edit below, not a verification step.

**Files:**
- Modify: `Sss_test/sss5/supabase/functions/start-authenticated-story-v2/index.ts` (gate at ~line 68-82; `MONTHLY_STORY_LIMIT` const at line 20)
- Modify: `Sss_test/sss5/supabase/functions/start-authenticated-story/index.ts` (gate at ~line 67-78)
- Modify: `Sss_test/sss5/supabase/functions/submit-choice/index.ts` — imports `access.ts` but destructures `{ periodEnd }` and runs its own inlined comparison; needs the same `hasAccess()` replacement as the two files above.

**Interfaces:**
- Consumes: `resolveAccess`, `hasAccess`, `storyLimitFor` from Task 2.

- [ ] **Step 1: Replace the inlined gate in `start-authenticated-story-v2/index.ts`**

Add to the imports at the top of the file:

```typescript
import { resolveAccess, hasAccess, storyLimitFor } from "../_shared/access.ts";
```

Delete the module-level `const MONTHLY_STORY_LIMIT = 3;` (line 20). Then replace this block:

```typescript
  // Access gate: paid-through must be in the future.
  const periodEnd = profile.current_period_end ? new Date(profile.current_period_end) : null;
  if (!periodEnd || periodEnd < new Date()) {
    return jsonResponse(
      { error: "Active subscription required to start a new story", subscription_status: profile.subscription_status },
      403,
    );
  }
```

with:

```typescript
  // Access gate: lifetime holders always pass; otherwise paid-through must be
  // in the future. Shared with submit-choice via _shared/access.ts.
  const access = await resolveAccess(db, profile.id);
  if (!hasAccess(access)) {
    return jsonResponse(
      { error: "Active subscription required to start a new story", subscription_status: access.subStatus },
      403,
    );
  }
  const storyLimit = storyLimitFor(access.planTier);
```

- [ ] **Step 2: Make the quota block tier-aware in the same file**

Replace every remaining `MONTHLY_STORY_LIMIT` reference in the quota block with `storyLimit`:

```typescript
  const used = createdThisMonth ?? 0;
  if (used >= storyLimit) {
    const resetIso = startOfNextMonthISO();
    await db.from("events").insert({
      user_id: profile.id, email: profile.email,
      event_type: "story_creation_blocked_monthly_cap",
      metadata: { used, limit: storyLimit, resets_at: resetIso, quiz_version: 2 },
    });
    return jsonResponse({
      error: `You've used all ${storyLimit} of your stories this month`,
      detail: `Your quota resets at the start of next month.`,
      used, limit: storyLimit, resets_at: resetIso,
    }, 429);
  }
```

Also update the `metadata` on the success-path `events` insert further down the file (currently `monthly_limit: MONTHLY_STORY_LIMIT`) to `monthly_limit: storyLimit`.

- [ ] **Step 3: Apply the same gate replacement to `start-authenticated-story/index.ts` (V1)**

V1 has the same duplicated gate *and* the same hardcoded quota. Add the import, delete `const MONTHLY_STORY_LIMIT = 3;` (line 20), and replace the gate block at ~line 73:

```typescript
  const periodEnd = profile.current_period_end ? new Date(profile.current_period_end) : null;
  if (!periodEnd || periodEnd < new Date()) {
```

with the identical `resolveAccess` / `hasAccess` pattern from Step 1, keeping V1's existing error message and response shape, and adding `const storyLimit = storyLimitFor(access.planTier);` after it.

Then replace `MONTHLY_STORY_LIMIT` with `storyLimit` at every remaining site in that file — lines **90, 96, 99, 102, 134, 147**. Line 147 is the success response's `quota: { used: used + 1, limit: MONTHLY_STORY_LIMIT }`; missing it would report the wrong limit back to the client.

- [ ] **Step 4: Confirm no inlined gate survives**

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test/sss5/supabase/functions
grep -rn "current_period_end" --include="*.ts" . | grep -v "_shared/access.ts" | grep -v "stripe-webhook" | grep -v "cancel-subscription"
```

Expected: no lines that *compare* `current_period_end` to a date. Remaining hits should only be column selects or row writes (e.g. `start-authenticated-story-v2/index.ts:146-147`, which copies the value into a session row — that is not a gate, leave it).

**Caveat (post-implementation):** this grep alone missed exactly one gate during execution — `submit-choice` destructured `resolveAccess()`'s result into a variable named `periodEnd`, so the literal string `current_period_end` never appeared in the comparison. Treat this command as a first pass, not proof. Also search for the comparison *shape* (`new Date(`, `.gte`/`.lte`, 402/403 responses) and check that every caller of `resolveAccess` actually calls `hasAccess()` rather than reading its fields directly.

- [ ] **Step 5: Typecheck and deploy**

```bash
cd /Users/mintarasgrinius/Documents/sss-app
deno check Sss_test/sss5/supabase/functions/start-authenticated-story-v2/index.ts
deno check Sss_test/sss5/supabase/functions/start-authenticated-story/index.ts
deno check Sss_test/sss5/supabase/functions/submit-choice/index.ts
supabase functions deploy start-authenticated-story-v2 start-authenticated-story submit-choice --project-ref gmhbcxylqubhxozomhlt
```

Expected: all three typecheck clean and deploy.

- [ ] **Step 6: Verify a real subscriber is unaffected**

Sign in to the app as an existing active subscriber and start a new story. Expected: works exactly as before, quota hint reads `2 left` after one story.

- [ ] **Step 7: Commit**

```bash
git add Sss_test/sss5/supabase/functions/start-authenticated-story-v2/index.ts Sss_test/sss5/supabase/functions/start-authenticated-story/index.ts
git commit -m "refactor: route all access gates through _shared/access.ts"
```

---

### Task 4: Pure rung-routing logic

Keeping the branch table as a pure function means the flow's behaviour is testable without Stripe, a browser, or a database.

**Files:**
- Create: `Sss_test/sss5/supabase/functions/_shared/retention.ts`
- Test: `Sss_test/sss5/supabase/functions/_shared/retention_test.ts`

**Interfaces:**
- Produces:
  - `type CancelReason = "too_expensive" | "not_using" | "ran_out" | "broken"`
  - `type Rung = "discount" | "lifetime" | "pause" | "downgrade" | "support" | "cancel"`
  - `nextRung(reason: CancelReason, declined: Rung[]): Rung`
  - `REASONS: readonly CancelReason[]`
- Consumed by Tasks 5 and 8.

- [ ] **Step 1: Write the failing test**

Create `Sss_test/sss5/supabase/functions/_shared/retention_test.ts`:

```typescript
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { nextRung, REASONS } from "./retention.ts";

Deno.test("price objection leads with the discount", () => {
  assertEquals(nextRung("too_expensive", []), "discount");
});

Deno.test("price objection falls back to lifetime after declining the discount", () => {
  assertEquals(nextRung("too_expensive", ["discount"]), "lifetime");
});

Deno.test("price objection cancels after declining both rungs", () => {
  assertEquals(nextRung("too_expensive", ["discount", "lifetime"]), "cancel");
});

Deno.test("low usage leads with pause, then downgrade", () => {
  assertEquals(nextRung("not_using", []), "pause");
  assertEquals(nextRung("not_using", ["pause"]), "downgrade");
  assertEquals(nextRung("not_using", ["pause", "downgrade"]), "cancel");
});

Deno.test("ran out of content gets pause only, then cancel", () => {
  assertEquals(nextRung("ran_out", []), "pause");
  assertEquals(nextRung("ran_out", ["pause"]), "cancel");
});

Deno.test("a broken product is never offered a discount", () => {
  assertEquals(nextRung("broken", []), "support");
  assertEquals(nextRung("broken", ["support"]), "cancel");
});

Deno.test("lifetime is never offered outside the price-objection branch", () => {
  for (const reason of REASONS) {
    if (reason === "too_expensive") continue;
    const seen: string[] = [];
    let rung = nextRung(reason, []);
    while (rung !== "cancel" && seen.length < 5) { seen.push(rung); rung = nextRung(reason, seen as never); }
    assertEquals(seen.includes("lifetime"), false, `lifetime leaked into the '${reason}' branch`);
  }
});

Deno.test("no branch ever shows more than two offers", () => {
  for (const reason of REASONS) {
    const seen: string[] = [];
    let rung = nextRung(reason, []);
    while (rung !== "cancel" && seen.length < 10) { seen.push(rung); rung = nextRung(reason, seen as never); }
    assertEquals(seen.length <= 2, true, `'${reason}' offered ${seen.length} rungs`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/mintarasgrinius/Documents/sss-app/Sss_test/sss5/supabase/functions && deno test --allow-all _shared/retention_test.ts`
Expected: FAIL — `Module not found "./retention.ts"`.

- [ ] **Step 3: Write the implementation**

Create `Sss_test/sss5/supabase/functions/_shared/retention.ts`:

```typescript
// Cancellation save-flow branch table. Pure — no Stripe, no DB — so the
// flow's shape is unit-testable and both the edge function and the frontend
// agree on which rung comes next.
//
// Two invariants, enforced by retention_test.ts:
//   1. "lifetime" appears ONLY in the too_expensive branch. It permanently
//      ends recurring revenue, so it is gated behind a stated price objection.
//   2. No branch shows more than two offers. More reads as bargaining and
//      trains users to always click cancel.

export type CancelReason = "too_expensive" | "not_using" | "ran_out" | "broken";
export type Rung = "discount" | "lifetime" | "pause" | "downgrade" | "support" | "cancel";

export const REASONS: readonly CancelReason[] = ["too_expensive", "not_using", "ran_out", "broken"] as const;

const LADDERS: Record<CancelReason, Rung[]> = {
  too_expensive: ["discount", "lifetime"],
  not_using:     ["pause", "downgrade"],
  ran_out:       ["pause"],
  broken:        ["support"],
};

// The next rung to show, given what the user has already declined.
// Returns "cancel" when the ladder is exhausted.
export function nextRung(reason: CancelReason, declined: Rung[]): Rung {
  const ladder = LADDERS[reason];
  if (!ladder) return "cancel";
  return ladder.find((r) => !declined.includes(r)) ?? "cancel";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/mintarasgrinius/Documents/sss-app/Sss_test/sss5/supabase/functions && deno test --allow-all _shared/retention_test.ts`
Expected: PASS — 8 passed.

- [ ] **Step 5: Commit**

```bash
git add Sss_test/sss5/supabase/functions/_shared/retention.ts Sss_test/sss5/supabase/functions/_shared/retention_test.ts
git commit -m "feat: pure save-flow rung routing"
```

---

### Task 5: `retention-offer` edge function — reason, pause, discount, downgrade

**Files:**
- Create: `Sss_test/sss5/supabase/functions/retention-offer/index.ts`

**Interfaces:**
- Consumes: `nextRung`, `CancelReason`, `Rung` (Task 4); `stripe` (`_shared/stripe.ts`); `adminClient` (`_shared/db.ts`); `handlePreflight`, `jsonResponse` (`_shared/cors.ts`).
- Produces: `POST /functions/v1/retention-offer` with `Body: { action, reason?, declined? }` returning `{ ok, rung?, message?, checkout_url? }`.
- Consumed by Tasks 6 and 8.

- [ ] **Step 1: Write the function**

Model the auth and CORS preamble on `cancel-subscription/index.ts` — same `Bearer` check, same `userClient` construction, same `adminClient()` for writes.

```typescript
// POST /functions/v1/retention-offer
//
// App-side, JWT-authed. Runs the cancellation save-flow: records the stated
// reason, then executes whichever retention rung the user accepts.
//
// Body: { action: "record_reason" | "pause" | "discount" | "downgrade" | "lifetime_checkout",
//         reason?: CancelReason, declined?: Rung[] }
//
// Deliberately does NOT handle plain cancellation — that stays in
// cancel-subscription, so the path that works today cannot be destabilised.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { adminClient } from "../_shared/db.ts";
import { stripe } from "../_shared/stripe.ts";
import { nextRung, type CancelReason, type Rung } from "../_shared/retention.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAUSE_WEEKS = 4;

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return jsonResponse({ error: "Authentication required" }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: "Invalid or expired session — sign in again" }, 401);

  let body: { action?: string; reason?: CancelReason; declined?: Rung[] };
  try { body = await req.json(); } catch { body = {}; }
  const action = body.action ?? "";
  const reason = body.reason;
  const declined = body.declined ?? [];

  const db = adminClient();
  const { data: profile } = await db
    .from("users")
    .select("id, email, stripe_subscription_id, stripe_customer_id, plan_tier")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.stripe_subscription_id) {
    return jsonResponse({ error: "No subscription found for this account" }, 404);
  }

  // Reason is recorded BEFORE any offer is shown, so an abandoned modal still
  // yields the reason — the most valuable output of this whole flow.
  if (action === "record_reason") {
    if (!reason) return jsonResponse({ error: "reason required" }, 400);
    await db.from("events").insert({
      user_id: profile.id, email: profile.email,
      event_type: "cancel_reason_selected",
      metadata: { reason },
    });
    return jsonResponse({ ok: true, rung: nextRung(reason, declined) });
  }

  try {
    if (action === "pause") {
      const resumesAt = Math.floor(Date.now() / 1000) + PAUSE_WEEKS * 7 * 24 * 3600;
      await stripe.subscriptions.update(profile.stripe_subscription_id, {
        pause_collection: { behavior: "void", resumes_at: resumesAt },
      });
      await logOffer(db, profile, "pause", reason);
      return jsonResponse({ ok: true, message: `Paused for ${PAUSE_WEEKS} weeks.` });
    }

    if (action === "discount") {
      await stripe.subscriptions.update(profile.stripe_subscription_id, {
        discounts: [{ coupon: Deno.env.get("STRIPE_COUPON_SAVE50")! }],
      });
      await logOffer(db, profile, "discount", reason);
      return jsonResponse({ ok: true, message: "50% off your next renewal applied." });
    }

    if (action === "downgrade") {
      const sub = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
      const itemId = sub.items.data[0]?.id;
      if (!itemId) return jsonResponse({ error: "Subscription has no billable item" }, 502);
      await stripe.subscriptions.update(profile.stripe_subscription_id, {
        items: [{ id: itemId, price: Deno.env.get("STRIPE_PRICE_LITE")! }],
        proration_behavior: "none",
      });
      await db.from("users").update({ plan_tier: "lite" }).eq("id", profile.id);
      await logOffer(db, profile, "downgrade", reason);
      return jsonResponse({ ok: true, message: "Switched to the lighter plan." });
    }
  } catch (e) {
    console.error(`retention action ${action} failed:`, e);
    // Fall through to plain cancel client-side — never trap someone leaving.
    return jsonResponse({ error: "Could not apply that offer", detail: String(e) }, 502);
  }

  return jsonResponse({ error: `Unknown action: ${action}` }, 400);
});

// deno-lint-ignore no-explicit-any
async function logOffer(db: any, profile: { id: string; email: string }, rung: string, reason?: string) {
  await db.from("events").insert({
    user_id: profile.id, email: profile.email,
    event_type: "retention_offer_accepted",
    metadata: { rung, reason: reason ?? null },
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/mintarasgrinius/Documents/sss-app && deno check Sss_test/sss5/supabase/functions/retention-offer/index.ts`
Expected: exactly one error, at `_shared/stripe.ts:6:3` — the known stale-types mismatch (see Global Constraints). Any other or additional error is real.

- [ ] **Step 3: Create the Stripe objects these actions reference**

In the Stripe dashboard (test mode first), create:
- Coupon `50% off, duration: once` → put its id in `STRIPE_COUPON_SAVE50`
- Recurring price `$9.99 / 4 weeks` → put its id in `STRIPE_PRICE_LITE`

```bash
supabase secrets set --project-ref gmhbcxylqubhxozomhlt \
  STRIPE_COUPON_SAVE50=<coupon_id> \
  STRIPE_PRICE_LITE=<price_id>
```

- [ ] **Step 4: Deploy and smoke-test `record_reason`**

```bash
cd /Users/mintarasgrinius/Documents/sss-app
supabase functions deploy retention-offer --project-ref gmhbcxylqubhxozomhlt
```

Then from the browser console on `settings.html`, signed in as a test subscriber:

```javascript
await supabase.functions.invoke("retention-offer", { body: { action: "record_reason", reason: "too_expensive", declined: [] } })
```

Expected: `{ ok: true, rung: "discount" }`, and a new `cancel_reason_selected` row in the `events` table.

- [ ] **Step 5: Commit**

```bash
git add Sss_test/sss5/supabase/functions/retention-offer/index.ts
git commit -m "feat: retention-offer function with pause, discount and downgrade rungs"
```

---

### Task 6: Lifetime checkout session

**Files:**
- Modify: `Sss_test/sss5/supabase/functions/retention-offer/index.ts`

**Interfaces:**
- Consumes: `profile.stripe_customer_id` (Task 5).
- Produces: a Stripe Checkout Session carrying `metadata.app = "sss"` and `metadata.supabase_user_id` — both required by Task 7 to identify and fulfil the payment.

- [ ] **Step 1: Add the `lifetime_checkout` branch**

Insert inside the existing `try` block in `retention-offer/index.ts`, after the `downgrade` branch:

```typescript
    if (action === "lifetime_checkout") {
      if (!profile.stripe_customer_id) {
        return jsonResponse({ error: "No Stripe customer on this account" }, 404);
      }
      const appUrl = Deno.env.get("APP_URL")!;
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: profile.stripe_customer_id,
        line_items: [{ price: Deno.env.get("STRIPE_PRICE_LIFETIME")!, quantity: 1 }],
        success_url: `${appUrl}/settings.html?lifetime=success`,
        cancel_url: `${appUrl}/settings.html?lifetime=cancelled`,
        // The Stripe account is shared with another product. These two keys are
        // how the webhook recognises this payment as ours and knows who to
        // credit — a one-time payment has no subscription for ours() to check.
        metadata: { app: "sss", supabase_user_id: profile.id },
      });
      await db.from("events").insert({
        user_id: profile.id, email: profile.email,
        event_type: "lifetime_checkout_started",
        metadata: { reason: reason ?? null, checkout_session_id: session.id },
      });
      return jsonResponse({ ok: true, checkout_url: session.url });
    }
```

- [ ] **Step 2: Create the lifetime price and set the remaining secrets**

In Stripe (test mode), create a **one-time** price of **$79.00 USD**.

```bash
supabase secrets set --project-ref gmhbcxylqubhxozomhlt \
  STRIPE_PRICE_LIFETIME=<price_id> \
  APP_URL=https://app.stuffsosweet.com
```

(`app.stuffsosweet.com` is confirmed from `sss-app/CNAME`.)

- [ ] **Step 3: Typecheck and deploy**

```bash
cd /Users/mintarasgrinius/Documents/sss-app
deno check Sss_test/sss5/supabase/functions/retention-offer/index.ts
supabase functions deploy retention-offer --project-ref gmhbcxylqubhxozomhlt
```

Expected: `deno check` reports exactly one error, at `_shared/stripe.ts:6:3` (see Global Constraints) — nothing else.

- [ ] **Step 4: Verify a session is created**

From the browser console, signed in as a test subscriber:

```javascript
await supabase.functions.invoke("retention-offer", { body: { action: "lifetime_checkout", reason: "too_expensive" } })
```

Expected: `{ ok: true, checkout_url: "https://checkout.stripe.com/..." }`. Open it and confirm it shows **$79.00** as a one-time payment, not a subscription. Do **not** complete the payment yet — Task 7 builds the fulfilment.

- [ ] **Step 5: Commit**

```bash
git add Sss_test/sss5/supabase/functions/retention-offer/index.ts
git commit -m "feat: lifetime checkout session"
```

---

### Task 7: Fulfil lifetime purchases in the webhook

**Files:**
- Modify: `Sss_test/sss5/supabase/functions/stripe-webhook/index.ts` (event routing at ~lines 92-101; dedup insert at ~line 106)

**Interfaces:**
- Consumes: `metadata.app`, `metadata.supabase_user_id` from Task 6's Checkout Session.
- Produces: `users.lifetime_at` set; the live subscription cancelled.

- [ ] **Step 1: Handle the event before the subscription-only routing**

The existing routing resolves a `sub` and then calls `ours(sub)`. A one-time payment has no subscription, so this branch must return before that logic. Insert immediately after the `let inv: any = null;` declaration and **before** the `if (event.type === "invoice.paid" ...)` chain:

```typescript
    // One-time lifetime purchase. Handled before the subscription routing
    // because there is no subscription for ours() to inspect — the shared
    // Stripe account is disambiguated by metadata.app instead.
    if (event.type === "checkout.session.completed") {
      const cs = event.data.object as Stripe.Checkout.Session;
      if (cs.mode !== "payment") return ACK();
      if ((cs.metadata?.app ?? "") !== "sss") return ACK();   // another product's payment
      if (cs.payment_status !== "paid") return ACK();
      const uid = cs.metadata?.supabase_user_id;
      if (!uid) { console.error("lifetime checkout with no supabase_user_id", cs.id); return ACK(); }

      // Idempotency, same table and same first-writer-wins rule as every
      // other branch — Stripe retries this event.
      const { error: dupErr } = await db.from("stripe_events").insert({ id: event.id, type: event.type });
      if (dupErr) return new Response("ok (dup)", { status: 200 });

      // ORDER IS LOAD-BEARING: grant the entitlement first, cancel second.
      // A failure between the two leaves the user with access they have paid
      // for. The reverse would strand a paying customer with nothing.
      const { error: grantErr } = await db.from("users")
        .update({ lifetime_at: new Date().toISOString(), plan_tier: "standard" })
        .eq("id", uid);
      if (grantErr) {
        console.error("lifetime grant failed:", grantErr);
        throw new Error(`lifetime grant failed: ${grantErr.message}`);  // let the outer catch compensate and Stripe retry
      }

      const { data: u } = await db.from("users")
        .select("email, stripe_subscription_id").eq("id", uid).maybeSingle();
      if (u?.stripe_subscription_id) {
        try {
          await stripe.subscriptions.cancel(u.stripe_subscription_id);
        } catch (e) {
          // Entitlement is already granted, so the user is fine. Log loudly:
          // this leaves a live subscription that must be cancelled by hand.
          console.error("lifetime granted but subscription cancel failed:", u.stripe_subscription_id, e);
        }
      }

      await db.from("events").insert({
        user_id: uid, email: u?.email ?? null,
        event_type: "lifetime_purchased",
        metadata: { checkout_session_id: cs.id, amount_total: cs.amount_total },
      });
      return ACK();
    }
```

> **Correction (post-implementation):** the grant-failure branch above originally read
> `return new Response("grant failed", { status: 500 })`. That is wrong, and would have cost a
> customer $79: this webhook uses claim-then-compensate idempotency — an outer `try` wraps the
> handler, the `stripe_events` insert above claims the event, and the catch DELETES that claim so
> Stripe's retry reprocesses it. A `return` does not trigger the catch, so the claim survives,
> Stripe's retry gets `ok (dup)`, and the grant never happens: customer paid, owns nothing, Stripe
> dashboard shows green. The rule, stated plainly: **inside this block, before the entitlement
> lands the only safe failure is `throw`; after it lands, never throw** (see the subscription-cancel
> `try/catch` just above, which correctly swallows and logs instead of throwing, because by that
> point the user already has their entitlement).

- [ ] **Step 2: Update the file's header comment**

The comment at line 13-14 lists handled events. Add `checkout.session.completed` to it so the next reader is not misled.

- [ ] **Step 3: Enable the event in Stripe**

In the Stripe dashboard, add `checkout.session.completed` to the webhook endpoint's enabled events. Without this the branch never fires.

- [ ] **Step 4: Typecheck and deploy**

```bash
cd /Users/mintarasgrinius/Documents/sss-app
deno check Sss_test/sss5/supabase/functions/stripe-webhook/index.ts
supabase functions deploy stripe-webhook --project-ref gmhbcxylqubhxozomhlt
```

Expected: `deno check` reports exactly one error, at `_shared/stripe.ts:6:3` (see Global Constraints) — nothing else.

- [ ] **Step 5: Complete a real test-mode purchase**

Re-run Task 6 Step 4 to get a fresh `checkout_url`, open it, and pay with Stripe's test card `4242 4242 4242 4242`.

Then verify:

```bash
supabase db query --project-ref gmhbcxylqubhxozomhlt \
  "select id, email, lifetime_at, plan_tier, subscription_status from public.users where lifetime_at is not null"
```

(Note: `supabase db query --linked` needs a linked project, which this checkout lacks — see the Task 1 Step 3 correction.)

Expected: your test user has a non-null `lifetime_at`, and their Stripe subscription is cancelled.

- [ ] **Step 6: Verify idempotency**

In the Stripe dashboard, find the `checkout.session.completed` event and click **Resend**.

Expected: response `ok (dup)`, and `lifetime_at` is unchanged from Step 5 (not overwritten with a later timestamp).

- [ ] **Step 7: Verify the lifetime holder still has access**

As the test user (whose subscription is now cancelled and whose `current_period_end` may be in the past), start a new story.

Expected: succeeds — this is Task 3's gate change working end to end. **If this fails, Task 3 is incomplete; do not proceed.**

- [ ] **Step 8: Commit**

```bash
git add Sss_test/sss5/supabase/functions/stripe-webhook/index.ts
git commit -m "feat: fulfil lifetime purchases via checkout.session.completed"
```

---

### Task 8: The save-flow modal

**Files:**
- Modify: `sss-app/settings.html` (cancel button at ~line 181; `manageSub` at ~line 310; the `cancelSubBtn` click handler at ~line 332)

**Interfaces:**
- Consumes: `retention-offer` actions (Tasks 5, 6); `logEvent` from `assets/lib.js:159`, which already dual-writes to the `events` table and PostHog.
- Produces: the user-facing flow. The final decline calls the untouched `manageSub("cancel", …)`.

- [ ] **Step 1: Replace the confirm() handler with the modal**

Delete the existing handler:

```javascript
    $("cancelSubBtn").addEventListener("click", (e) => {
      if (!confirm("Cancel your subscription? You'll keep full access until the end of your current paid period.")) return;
      manageSub("cancel", e.currentTarget);
    });
```

and replace it with the save-flow. The rung ladder is duplicated here rather than imported, because `_shared/retention.ts` lives in the Deno function tree and is not served to the browser; the server remains authoritative via `record_reason`, which returns the rung to show.

```javascript
    // ── Cancellation save-flow ─────────────────────────
    // Reason capture, then at most two offers, branched on the reason.
    // Every screen keeps a visible "cancel anyway" affordance — a broken or
    // pushy flow must never trap someone who wants to leave.
    const REASON_LABELS = {
      too_expensive: "It's too expensive",
      not_using:     "I'm not using it enough",
      ran_out:       "I ran out of stories I want to read",
      broken:        "Something isn't working",
    };

    const RUNGS = {
      discount: {
        title: "Stay for half price",
        body: "Take 50% off your next renewal. Same 3 stories a month, nothing else changes.",
        cta: "Apply 50% off",
        action: "discount",
      },
      lifetime: {
        title: "Pay once, keep it forever",
        body: "One payment of $79 and your account stays open for good — 3 stories every month, no more renewals. That's less than two renewals.",
        cta: "Get lifetime access — $79",
        action: "lifetime_checkout",
      },
      pause: {
        title: "Pause instead?",
        body: "Put your subscription on hold for 4 weeks. You won't be charged, and everything is waiting when you come back.",
        cta: "Pause for 4 weeks",
        action: "pause",
      },
      downgrade: {
        title: "Try the lighter plan",
        body: "$9.99 every 4 weeks for 1 story a month. Keeps your library and your account open.",
        cta: "Switch to $9.99",
        action: "downgrade",
      },
      support: {
        title: "Let us fix it",
        body: "Tell us what broke and we'll sort it out. Replies usually land within a day.",
        cta: "Email support",
        action: "support",
      },
    };

    let flowReason = null;
    let flowDeclined = [];

    function closeFlow() {
      const el = $("saveFlow");
      if (el) el.remove();
    }

    function renderFlow(inner) {
      closeFlow();
      const wrap = document.createElement("div");
      wrap.id = "saveFlow";
      wrap.className = "save-flow-backdrop";
      wrap.innerHTML = `<div class="save-flow-card" role="dialog" aria-modal="true">${inner}</div>`;
      document.body.appendChild(wrap);
      return wrap;
    }

    function openReasonStep() {
      flowReason = null;
      flowDeclined = [];
      const opts = Object.entries(REASON_LABELS)
        .map(([k, label]) => `<button type="button" class="cta-secondary flow-reason" data-reason="${k}">${label}</button>`)
        .join("");
      const wrap = renderFlow(`
        <h3>Before you go</h3>
        <p>What's the main reason you're cancelling?</p>
        <div class="flow-reasons">${opts}</div>
        <button type="button" class="flow-dismiss" id="flowClose">Never mind, keep my subscription</button>
      `);
      wrap.querySelectorAll(".flow-reason").forEach((b) => {
        b.addEventListener("click", () => chooseReason(b.dataset.reason));
      });
      $("flowClose").addEventListener("click", closeFlow);
    }

    async function chooseReason(reason) {
      flowReason = reason;
      await logEvent("cancel_reason_selected", { metadata: { reason } });
      const { data, error } = await supabase.functions.invoke("retention-offer", {
        body: { action: "record_reason", reason, declined: flowDeclined },
      });
      // If the offer service is down, don't trap the user — go straight to cancel.
      if (error || !data?.ok) return finishCancel();
      showRung(data.rung);
    }

    function showRung(rung) {
      if (rung === "cancel" || !RUNGS[rung]) return finishCancel();
      const r = RUNGS[rung];
      logEvent("retention_offer_shown", { metadata: { reason: flowReason, rung } });
      const wrap = renderFlow(`
        <h3>${r.title}</h3>
        <p>${r.body}</p>
        <button type="button" class="cta-primary" id="flowAccept">${r.cta}</button>
        <button type="button" class="flow-dismiss" id="flowDecline">No thanks, cancel my subscription</button>
        <div class="save-status" id="flowStatus"></div>
      `);
      $("flowAccept").addEventListener("click", () => acceptRung(rung));
      $("flowDecline").addEventListener("click", () => declineRung(rung));
      return wrap;
    }

    async function acceptRung(rung) {
      const r = RUNGS[rung];
      if (rung === "support") {
        window.location.href = "mailto:hello@stuffsosweet.com?subject=Something%20isn%27t%20working";
        return;
      }
      const btn = $("flowAccept");
      btn.disabled = true; btn.textContent = "…";
      const { data, error } = await supabase.functions.invoke("retention-offer", {
        body: { action: r.action, reason: flowReason, declined: flowDeclined },
      });
      if (error || !data?.ok) {
        $("flowStatus").textContent = "That didn't go through. Please try again.";
        $("flowStatus").className = "save-status err";
        btn.disabled = false; btn.textContent = r.cta;
        return;
      }
      await logEvent("retention_offer_accepted", { metadata: { reason: flowReason, rung } });
      if (data.checkout_url) { window.location.href = data.checkout_url; return; }
      closeFlow();
      $("subStatus").textContent = data.message || "Done ✓";
      $("subStatus").className = "save-status ok";
      const { data: u2 } = await supabase.from("users")
        .select("subscription_status, current_period_end, cancel_at_period_end, stripe_subscription_id, lifetime_at, plan_tier")
        .eq("id", session.user.id).maybeSingle();
      renderSub(u2);
    }

    async function declineRung(rung) {
      await logEvent("retention_offer_declined", { metadata: { reason: flowReason, rung } });
      flowDeclined.push(rung);
      const { data, error } = await supabase.functions.invoke("retention-offer", {
        body: { action: "record_reason", reason: flowReason, declined: flowDeclined },
      });
      if (error || !data?.ok) return finishCancel();
      showRung(data.rung);
    }

    function finishCancel() {
      closeFlow();
      manageSub("cancel", $("cancelSubBtn"));
    }

    $("cancelSubBtn").addEventListener("click", openReasonStep);
```

> **Correction (post-implementation):** the policy narrated above (and the spec's original,
> unconditional "any failure falls through to cancel") is stale — the deployed API returns five
> distinct codes and they don't all mean the same thing. The implemented rule: `502` / `500` /
> `404` fall through to plain cancel **only** on `record_reason` (both the initial reason capture
> and each `declineRung` call) — the flow cannot start, and the user did press Cancel. On an
> **accept** action, every failure — including `502` — must show a failure screen with choices and
> must **never** auto-cancel; an unset Stripe secret returns `502` and is the expected state on
> first deploy, so auto-cancelling there would have made that the default behaviour of the
> discount and downgrade rungs. `409` always shows the server's own message and never cancels.
> `400` is a client bug: log it and fall through. The shipped frontend (`sss-app` commits
> `1000028..3db763d`) implements this with a request-generation token (so a stale response from an
> abandoned request can't retroactively cancel a fresh flow) and re-checks flow state after every
> `await` — meaningfully more than the snippet above shows; treat this snippet as the shape of the
> flow, not the final error-handling implementation.

- [ ] **Step 2: Add the modal styles**

Append to the page's existing `<style>` block, matching the surrounding conventions:

The palette is defined in `assets/style.css:6-20`. Note that `--card` is *translucent*
(`rgba(255,255,255,0.06)`) and would be nearly invisible over the modal backdrop — the card needs
the opaque `--bg-bottom` instead.

```css
    .save-flow-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,.62);
      display: flex; align-items: center; justify-content: center;
      padding: 1.25rem; z-index: 200; /* the bottom nav is z-index 100; 60 (this plan's
        original value) rendered the modal underneath it on mobile — shipped as 200 */
    }
    .save-flow-card {
      background: var(--bg-bottom); color: var(--text);
      border: 1px solid var(--card-hi); border-radius: 14px;
      padding: 1.5rem; max-width: 24rem; width: 100%;
      box-shadow: 0 12px 40px rgba(0,0,0,.5);
    }
    .save-flow-card h3 { margin: 0 0 .5rem; color: var(--gold); }
    .save-flow-card p { margin: 0 0 1rem; color: var(--muted); }
    .flow-reasons { display: flex; flex-direction: column; gap: .5rem; margin-bottom: 1rem; }
    .flow-dismiss {
      display: block; width: 100%; margin-top: .75rem; padding: .5rem;
      background: none; border: 0; text-decoration: underline;
      color: var(--faint); cursor: pointer; font: inherit;
    }
    .flow-dismiss:hover { color: var(--text); }
```

- [ ] **Step 3: Verify each branch by hand**

Serve the app locally and sign in as a test subscriber. Walk all four branches:

| Reason | Expect rung 1 | Then decline → rung 2 | Then decline |
|---|---|---|---|
| It's too expensive | Stay for half price | Pay once, keep it forever | cancels |
| I'm not using it enough | Pause instead? | Try the lighter plan | cancels |
| I ran out of stories | Pause instead? | — | cancels |
| Something isn't working | Let us fix it | — | cancels |

Confirm **lifetime never appears** in any branch except "too expensive".

- [ ] **Step 4: Verify the events landed**

```bash
supabase db query --project-ref gmhbcxylqubhxozomhlt \
  "select event_type, metadata from public.events
   where event_type in ('cancel_reason_selected','retention_offer_shown','retention_offer_accepted','retention_offer_declined')
   order by created_at desc limit 20"
```

(Note: `supabase db query --linked` needs a linked project, which this checkout lacks — see the Task 1 Step 3 correction.)

Expected: rows with `reason` and `rung` in `metadata`. Confirm the same events appear in PostHog (project SSS, 207201) — `logEvent` mirrors them automatically.

- [ ] **Step 5: Commit**

```bash
git add sss-app/settings.html
git commit -m "feat: cancellation save-flow modal"
```

---

### Task 9: Show lifetime state in Settings

Without this, `renderSub` returns early for a lifetime holder whose subscription was cancelled — the Subscription section vanishes and the user sees nothing confirming what they bought.

**Files:**
- Modify: `sss-app/settings.html` — `renderSub` (~line 288) and the profile query (~line 223)

- [ ] **Step 1: Add the new columns to the profile query**

At ~line 223, extend the select:

```javascript
        .select("display_name, notification_preference, marketing_email_opt_in, subscription_status, current_period_end, cancel_at_period_end, stripe_subscription_id, lifetime_at, plan_tier")
```

- [ ] **Step 2: Handle lifetime first in `renderSub`**

Insert at the top of `renderSub`, **before** the `if (!u || !u.stripe_subscription_id)` early return — otherwise a cancelled lifetime holder falls through it and sees nothing:

```javascript
      if (u && u.lifetime_at) {
        $("subSection").style.display = "";
        $("subStatusLine").textContent = "Lifetime access — you're all set. 3 stories every month, no renewals.";
        $("cancelSubBtn").style.display = "none";
        $("reactivateBtn").style.display = "none";
        return;
      }
```

- [ ] **Step 3: Show the plan name for downgraded users**

In the `else if (active)` branch, replace the status line so a `lite` user is not told they are on the standard plan:

```javascript
        const planName = u.plan_tier === "lite" ? "Lighter plan" : "Active";
        $("subStatusLine").textContent = `${planName} — renews on ${end}.`;
```

- [ ] **Step 4: Surface the post-checkout return**

Stripe returns the user to `settings.html?lifetime=success`. Add near the other init code, after `renderSub(user)`:

```javascript
    if (new URLSearchParams(location.search).get("lifetime") === "success") {
      $("subStatus").textContent = "Lifetime access unlocked ✓";
      $("subStatus").className = "save-status ok";
      history.replaceState({}, "", location.pathname);
    }
```

- [ ] **Step 5: Verify**

Sign in as the lifetime test user from Task 7.
Expected: the Subscription section is visible and reads "Lifetime access — you're all set", with no cancel button. Then load `settings.html?lifetime=success` and confirm the banner shows and the query string is stripped.

- [ ] **Step 6: Commit**

```bash
git add sss-app/settings.html
git commit -m "feat: lifetime and lite-plan states in settings"
```

---

### Task 10: Make the client-side quota hint tier-aware

The server is authoritative, but a mismatched UI hint ("2 left" when the server allows 0) is a support ticket.

**Files:**
- Modify: `sss-app/assets/lib.js:482-484` (the `MONTHLY_STORY_LIMIT` const and `gateNewStoryNav`)

- [ ] **Step 1: Replace the hardcoded constant with a per-user lookup**

Delete `const MONTHLY_STORY_LIMIT = 3;` at line 482 and add:

```javascript
/* Monthly story quota per plan tier. Mirrors storyLimitFor() in
 * supabase/functions/_shared/access.ts — keep the two in sync. This is a
 * display hint only; the server enforces the real limit. */
const STORY_LIMITS = { standard: 3, lite: 1 };
function storyLimitFor(planTier) { return STORY_LIMITS[planTier] ?? STORY_LIMITS.standard; }
```

- [ ] **Step 2: Read the tier and lifetime flag inside `gateNewStoryNav`**

After the existing session check and before the month-start calculation:

```javascript
  const { data: prof } = await supabase.from("users")
    .select("plan_tier, lifetime_at").eq("id", session.user.id).maybeSingle();
  const limit = storyLimitFor(prof?.plan_tier);
```

Then replace every remaining `MONTHLY_STORY_LIMIT` in the function with `limit`:

```javascript
  const used = count || 0;
  const left = Math.max(0, limit - used);
```

and in the tooltip:

```javascript
      a.setAttribute("title",
        `You've used all ${limit} of your stories this month. Quota resets on the 1st.`);
```

> **Flag (not fixed):** this string reads "You've used all 1 of your stories this month" for
> `lite` users — grammatically awkward, not just a `standard`-user edge case, since `lite`'s limit
> is 1. It carried over verbatim from this plan and has **not** been reworded in the shipped code;
> it needs rewording, but do not treat it as already fixed.

- [ ] **Step 3: Verify no stale reference remains**

Run: `cd /Users/mintarasgrinius/Documents/sss-app && grep -n "MONTHLY_STORY_LIMIT" sss-app/assets/lib.js`
Expected: no output.

- [ ] **Step 4: Verify in the browser**

As a `lite` test user (set via Task 5's downgrade, or directly in SQL), load any app page.
Expected: the rail nav reads `1 left` before any story that month, and dims after one.

- [ ] **Step 5: Commit**

```bash
git add sss-app/assets/lib.js
git commit -m "feat: tier-aware client-side quota hint"
```

---

### Task 11: End-to-end verification

**Files:** none — verification only.

- [ ] **Step 1: Run the full unit suite**

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test/sss5/supabase/functions
deno test --allow-all _shared/
```

Expected: 16 passed, 0 failed.

- [ ] **Step 2: Typecheck every touched function**

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test/sss5/supabase/functions
for f in retention-offer stripe-webhook start-authenticated-story-v2 start-authenticated-story submit-choice; do
  echo "=== $f ==="; deno check "$f/index.ts"; done
```

Expected: no errors for `start-authenticated-story-v2`, `start-authenticated-story`, and `submit-choice` (none of them touch Stripe). `retention-offer` and `stripe-webhook` each show exactly one error, at `_shared/stripe.ts:6:3` (see Global Constraints) — any other or additional error on either is real.

- [ ] **Step 3: Walk the four branches end to end in Stripe test mode**

For each, use a fresh test subscriber:

1. **too_expensive → accept discount.** Verify in Stripe that the subscription carries the 50%-off coupon and the next invoice preview is ~$23.
2. **too_expensive → decline discount → accept lifetime.** Verify `users.lifetime_at` is set, the subscription is cancelled, and story creation still works.
3. **not_using → accept pause.** Verify `pause_collection.resumes_at` is ~4 weeks out in Stripe.
4. **not_using → decline pause → accept downgrade.** Verify the subscription item is on the `$9.99` price and `users.plan_tier = 'lite'`.

- [ ] **Step 4: Verify the failure path does not trap anyone**

Temporarily set `STRIPE_COUPON_SAVE50` to a nonexistent id, deploy, then run the `too_expensive → accept discount` path.

Expected: the modal shows "That didn't go through. Please try again." and the decline button still cancels the subscription successfully. **Restore the correct coupon id and redeploy afterwards.**

- [ ] **Step 5: Confirm the deflection funnel is measurable**

In PostHog (project SSS, 207201), build a funnel: `cancel_reason_selected` → `retention_offer_shown` → `retention_offer_accepted`, broken down by the `reason` property.

Expected: the test-mode walkthroughs appear. This funnel is the deliverable — it is what tells you within a week whether day-0 cancels are a pricing problem or a value problem.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: end-to-end verification of the retention save-flow"
```

---

## Rollout note

Ship Tasks 1-3 first and let them sit for a day. They change the access gate for every paying user, and a mistake there locks people out of a product they have paid for. Tasks 4-11 only add a new path and are far lower risk.

Once real reason data lands, revisit the three open decisions in the spec: the $79 lifetime price, one-cycle vs permanent discount, and whether the renewal price itself should change — which would make the discount rung redundant.

## Deferred follow-ups

Recorded during implementation, deliberately not fixed in this branch:

- The same `if (dupErr) return 200` pattern (conflating "duplicate" with any insert error) exists in the pre-existing subscription branch of `stripe-webhook`. Recoverable there (a later `invoice.paid`/`customer.subscription.updated` re-syncs), so out of scope — but it is the same latent bug and worth a separate pass.
- Do not "improve" the lifetime grant with `.is("lifetime_at", null)`: a legitimate second purchase would then match zero rows, hit the throw, and retry-loop 500s at Stripe.
- `lifetime_at` is overwritten on a legitimate second lifetime purchase (the true acquisition date survives in `events`). A future pass should avoid offering the lifetime rung to an existing holder.
- Claim-before-work leaves a one-UPDATE-wide stuck-claim window if the isolate is killed mid-request. A durable fix is a status column on `stripe_events` (claimed → fulfilled) rather than presence-as-truth.
- No alert rule exists on the "FAILED TO RELEASE" log string.
- Move `isValidReason` / `sanitizeDeclined` into `_shared/retention.ts` so a fifth `CancelReason` stays covered by that module's tests automatically.
- `pause` abuse is rate-limited and now state-checked by the Task 6 backstop; re-verify once that review lands.
