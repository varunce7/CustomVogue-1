import connection from "../db.server.js";
import ShopPlan from "../models/ShopPlan.js";
import { PLANS } from "./plans.js";

// In-process plan cache — avoids a Shopify billing API call on every loader.
// Keyed by shop. Standard TTL is 30 minutes; after upgrade, extend to 60 minutes.
const planCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const CACHE_TTL_AFTER_UPGRADE = 60 * 60 * 1000; // 60 minutes (confirmed plan state)

// ── Real charges vs test charges ────────────────────────────────────────────
// Charges are REAL. Nothing infers test mode from NODE_ENV or from the store
// being a Partner development store — those inferences silently put live,
// paying merchants on test charges, which means Shopify never bills them and
// the app gives Growth away for free.
//
// The one and only way to get a test charge is to set SHOPIFY_BILLING_TEST=true
// in the environment. Never set it in production.
//
// Caveat when testing: Shopify will not accept a real charge on a development
// store — no payment method can exist there, so appSubscriptionCreate fails
// with "The shop cannot accept the provided charge". To walk the upgrade flow
// on a dev store, set SHOPIFY_BILLING_TEST=true locally (see app.billing.jsx,
// which turns that rejection into an explanatory message).
// eslint-disable-next-line no-undef
export const BILLING_IS_TEST = process.env.SHOPIFY_BILLING_TEST === "true";

// Whether a store is a Partner development store. No longer used to decide
// test vs real — kept so the upgrade action can explain *why* Shopify rejected
// a real charge. Cached because a store's plan doesn't change under us.
const devStoreCache = new Map();

export async function isDevelopmentStore(admin, shop) {
  if (shop && devStoreCache.has(shop)) return devStoreCache.get(shop);

  try {
    const response = await admin.graphql(
      `#graphql
      query shopPlan {
        shop { plan { partnerDevelopment } }
      }`
    );
    const json = await response.json();
    const isDev = Boolean(json.data?.shop?.plan?.partnerDevelopment);
    if (shop) devStoreCache.set(shop, isDev);
    return isDev;
  } catch (e) {
    console.error(
      "[CustomVogue] isDevelopmentStore failed:",
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
}

// What to pass as isTest when *reading* subscriptions. The API treats this as
// `isTest || !subscription.test`, so `true` matches both test and real
// subscriptions while `false` silently ignores test ones — which would show a
// merchant Free right after they approved a test charge. Always be permissive
// here; a merchant cannot create a test subscription themselves.
const CHECK_INCLUDES_TEST = true;

// ── Durable plan record (MongoDB) ───────────────────────────────────────────
// planCache lives in one lambda's memory. On Vercel the next request routinely
// lands on a different, cold instance, so memory alone cannot answer "did this
// shop pay?" — and answering FREE by mistake locks a paying merchant out of the
// features they just bought. ShopPlan is the durable answer, read only when the
// live billing API is unreachable.

// Avoids rewriting the same value on every request. Memory-only, so a cold
// instance simply writes once more than strictly necessary.
const lastPersisted = new Map();

export async function readStoredPlan(shop) {
  if (!shop) return null;
  try {
    await connection;
    const doc = await ShopPlan.findById(shop).lean();
    return doc?.plan ?? null;
  } catch (e) {
    console.error(
      "[CustomVogue] readStoredPlan failed:",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

export async function writeStoredPlan(shop, plan, extra = {}) {
  if (!shop || !plan) return;
  // Only skip when there is nothing else to record — status/subscriptionId from
  // a webhook must still land even if the plan itself hasn't moved.
  if (lastPersisted.get(shop) === plan && Object.keys(extra).length === 0) return;
  try {
    await connection;
    await ShopPlan.findByIdAndUpdate(
      shop,
      { plan, updatedAt: new Date(), test: BILLING_IS_TEST, ...extra },
      { upsert: true, setDefaultsOnInsert: true },
    );
    lastPersisted.set(shop, plan);
  } catch (e) {
    // Never let a bookkeeping failure break a page load or a webhook ack.
    lastPersisted.delete(shop);
    console.error(
      "[CustomVogue] writeStoredPlan failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

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
      isTest: CHECK_INCLUDES_TEST,
    });
    const plan = hasActivePayment ? PLANS.GROWTH : PLANS.FREE;
    if (shop) {
      planCache.set(shop, { plan, at: Date.now(), ttl: CACHE_TTL });
      // Live API answered, so this is authoritative — refresh the durable copy.
      // Fire-and-forget: the merchant shouldn't wait on Mongo to see the page.
      writeStoredPlan(shop, plan).catch(() => { });
    }
    return plan;
  } catch (e) {
    const msg = e instanceof Error ? e.message : (e?.message ?? JSON.stringify(e));
    // 403 right after OAuth is expected — billing API needs a moment to propagate
    if (!msg.includes("403")) {
      console.error("[CustomVogue] billing.check failed:", msg);
    }
    // Prefer: stale cache → durable record → caller-supplied fallback → FREE.
    // The durable record is what stops a paying merchant being shown Free on a
    // cold instance when the billing API happens to be unavailable.
    const stale = planCache.get(shop);
    if (stale?.plan) return stale.plan;

    const stored = await readStoredPlan(shop);
    if (stored) {
      // Short TTL: this is a fallback, not a fresh reading. Re-check soon.
      if (shop) planCache.set(shop, { plan: stored, at: Date.now(), ttl: CACHE_TTL });
      return stored;
    }

    return fallbackPlan ?? PLANS.FREE;
  }
}

export function invalidatePlanCache(shop) {
  planCache.delete(shop);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Subscription statuses that mean the merchant approved the charge at some
// point, so the trial attached to it was genuinely handed over.
// (Statuses are PENDING, ACTIVE, DECLINED, EXPIRED, FROZEN, CANCELLED.)
const TRIAL_CONSUMING_STATUSES = new Set(["ACTIVE", "FROZEN", "CANCELLED", "EXPIRED"]);

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
    // Only a subscription the merchant actually approved consumes the trial.
    // PENDING means they opened the approval screen and never confirmed;
    // DECLINED means they rejected it. Counting either would burn the trial of
    // someone who never got a single day of it.
    const hasUsedTrial = all.some(
      (s) => (s.trialDays ?? 0) > 0 && TRIAL_CONSUMING_STATUSES.has(s.status),
    );

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
// hence the retry loop. Budget ~5s: activation is usually sub-second, but it is
// not unusual for it to take a few, and giving up too early is what makes a
// merchant land back in the app on Free right after paying.
export async function confirmActivePlan(billing, shop, { attempts = 5, delayMs = 1000 } = {}) {
  let checkFailed = false;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { hasActivePayment } = await billing.check({
        plans: [PLANS.GROWTH],
        isTest: CHECK_INCLUDES_TEST,
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
    // next page load re-checks rather than trusting this for an hour. Not
    // persisted either — an unverified grant should not outlive this instance.
    planCache.set(shop, { plan: PLANS.GROWTH, at: Date.now(), ttl: CACHE_TTL });
    return { plan: PLANS.GROWTH, confirmed: false };
  }

  // Checks succeeded and consistently reported no active subscription — the
  // merchant most likely declined the charge.
  //
  // Deliberately the SHORT ttl, and deliberately not persisted: the other way
  // to reach here is a merchant who did approve but whose subscription hadn't
  // flipped to ACTIVE inside our retry budget. Pinning FREE for an hour (or
  // writing it to the durable record) would lock someone who has genuinely paid
  // out of the features until the cache expired. A short TTL means their next
  // page load re-checks and picks the subscription up.
  if (shop) planCache.set(shop, { plan: PLANS.FREE, at: Date.now(), ttl: CACHE_TTL });
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
// Also persists, because the merchant's very next request may well be served by
// a different instance whose memory knows nothing about the event.
export function setCachedPlan(shop, plan, extra = {}) {
  if (shop && plan) {
    planCache.set(shop, { plan, at: Date.now(), ttl: CACHE_TTL_AFTER_UPGRADE });
    writeStoredPlan(shop, plan, extra).catch(() => { });
  }
}
