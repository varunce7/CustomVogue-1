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
