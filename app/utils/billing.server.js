import { PLANS } from "./plans.js";

// In-process plan cache — avoids a Shopify billing API call on every loader.
// Keyed by shop. Standard TTL is 30 minutes; after upgrade, extend to 60 minutes.
const planCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const CACHE_TTL_AFTER_UPGRADE = 60 * 60 * 1000; // 60 minutes (confirmed plan state)

// Use test billing in development, but switch to real subscriptions in production.
export const BILLING_IS_TEST = process.env.NODE_ENV !== "production";

export async function getCurrentPlan(billing, shop, fallbackPlan = null) {
  if (shop) {
    const cached = planCache.get(shop);
    if (cached && Date.now() - cached.at < cached.ttl) {
      return cached.plan;
    }
  }

  try {
    const { hasActivePayment } = await billing.check({
      plans: [PLANS.GROWTH],
      isTest: BILLING_IS_TEST,
    });
    const plan = hasActivePayment ? PLANS.GROWTH : PLANS.FREE;
    if (shop) planCache.set(shop, { plan, at: Date.now(), ttl: CACHE_TTL });
    return plan;
  } catch (e) {
    const msg = e instanceof Error ? e.message : (e?.message ?? JSON.stringify(e));
    // 403 right after OAuth is expected — billing API needs a moment to propagate
    if (!msg.includes("403")) {
      console.error("[CustomVogue] billing.check failed:", msg);
    }
    // Prefer: stale cache → caller-supplied fallback → FREE
    const stale = planCache.get(shop);
    return stale?.plan ?? fallbackPlan ?? PLANS.FREE;
  }
}

export function invalidatePlanCache(shop) {
  planCache.delete(shop);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Trial eligibility and, if a trial is running, how much of it is left.
// Shopify does NOT stop a shop taking a second trial by cancelling and
// re-subscribing, so eligibility is derived from the shop's own subscription
// history: if this app ever created a subscription carrying trial days for
// them, they've had their trial.
export async function getTrialState(admin) {
  try {
    const response = await admin.graphql(
      `#graphql
      query trialState {
        currentAppInstallation {
          activeSubscriptions { id status trialDays createdAt }
          allSubscriptions(first: 50) { nodes { id status trialDays createdAt } }
        }
      }`
    );
    const json = await response.json();
    const installation = json.data?.currentAppInstallation;
    if (!installation) throw new Error("no currentAppInstallation in response");

    const all = installation.allSubscriptions?.nodes ?? [];
    const hasUsedTrial = all.some((s) => (s.trialDays ?? 0) > 0);

    // Trial days run from creation, so the trial ends at createdAt + trialDays.
    const active = installation.activeSubscriptions?.[0] ?? null;
    let trialDaysRemaining = 0;
    if (active && (active.trialDays ?? 0) > 0) {
      const endsAt = new Date(active.createdAt).getTime() + active.trialDays * DAY_MS;
      trialDaysRemaining = Math.max(0, Math.ceil((endsAt - Date.now()) / DAY_MS));
    }

    return { hasUsedTrial, trialDaysRemaining, inTrial: trialDaysRemaining > 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[CustomVogue] getTrialState failed:", msg);
    // Can't read the history — offer the trial rather than block a legitimate
    // upgrade. Worst case a shop gets a second trial after an API outage.
    return { hasUsedTrial: false, trialDaysRemaining: 0, inTrial: false, unknown: true };
  }
}

// Called when returning from Shopify's charge-approval screen. A ?charge_id in
// the URL is not proof of payment on its own — anyone can type one — so ask the
// billing API whether a subscription is genuinely active before granting Growth.
// Shopify can take a moment to flip the subscription to ACTIVE after approval,
// hence the short retry loop.
export async function confirmActivePlan(billing, shop, { attempts = 3, delayMs = 700 } = {}) {
  let checkFailed = false;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { hasActivePayment } = await billing.check({
        plans: [PLANS.GROWTH],
        isTest: BILLING_IS_TEST,
      });
      if (hasActivePayment) {
        setCachedPlan(shop, PLANS.GROWTH);
        return { plan: PLANS.GROWTH, confirmed: true };
      }
    } catch (e) {
      // The API itself errored (403/429/network) — that is not the same as
      // "the merchant did not pay", so remember it and decide below.
      checkFailed = true;
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[CustomVogue] confirmActivePlan check failed:", msg);
    }

    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (checkFailed) {
    // Never lock a merchant who just paid out of the plan because our own
    // verification call was unavailable. Grant it, but on the short TTL so the
    // next page load re-checks rather than trusting this for an hour.
    planCache.set(shop, { plan: PLANS.GROWTH, at: Date.now(), ttl: CACHE_TTL });
    return { plan: PLANS.GROWTH, confirmed: false };
  }

  // Checks succeeded and consistently reported no active subscription.
  setCachedPlan(shop, PLANS.FREE);
  return { plan: PLANS.FREE, confirmed: false };
}

// Cache-only read — never calls billing.check(). Use inside actions to avoid
// triggering the SDK's invalidateAccessToken side-effect when billing returns 401.
export function getCachedPlan(shop) {
  const cached = planCache.get(shop);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.plan;
  return null;
}

// Explicitly seed the cache after a known billing event (e.g., upgrade approved)
// with an extended TTL so subsequent page loads don't immediately re-check.
// This prevents the plan from reverting to FREE if Shopify hasn't fully propagated yet.
export function setCachedPlan(shop, plan) {
  if (shop && plan) {
    planCache.set(shop, { plan, at: Date.now(), ttl: CACHE_TTL_AFTER_UPGRADE });
  }
}
