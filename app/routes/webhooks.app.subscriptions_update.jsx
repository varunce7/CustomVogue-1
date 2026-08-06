import { authenticate, unauthenticated } from "../shopify.server";
import { syncShopPlan } from "../utils/appUrl.server.js";
import { invalidatePlanCache, setCachedPlan, writeStoredPlan } from "../utils/billing.server.js";
import { PLANS } from "../utils/plans.js";

// Statuses that mean the merchant is entitled to Growth right now.
const GRANTING = new Set(["ACTIVE"]);

// Statuses that mean entitlement is over: they cancelled, declined, the
// subscription lapsed, or Shopify froze it because a payment failed. Without
// this webhook the app would keep serving Growth features until the cached
// plan expired and something happened to re-check.
const REVOKING = new Set(["CANCELLED", "DECLINED", "EXPIRED", "FROZEN"]);

export const action = async ({ request }) => {
  const { payload, shop, topic } = await authenticate.webhook(request);

  const subscription = payload?.app_subscription ?? {};
  const status = String(subscription.status ?? "").toUpperCase();
  const name = subscription.name ?? "";

  console.log(
    `Received ${topic} webhook for ${shop} — "${name}" is ${status || "(no status)"}`
  );

  // PENDING means the approval screen was created but not acted on yet. It says
  // nothing about entitlement, so leave the current plan alone.
  let plan = null;
  if (GRANTING.has(status)) plan = PLANS.GROWTH;
  else if (REVOKING.has(status)) plan = PLANS.FREE;

  if (!plan) return new Response();

  // The durable record is the point of this handler: this webhook lands on a
  // different instance from the one serving the merchant's pages, so writing to
  // the in-process cache here reaches nobody. Persist first, always.
  await writeStoredPlan(shop, plan, {
    status,
    subscriptionId: subscription.admin_graphql_api_id ?? null,
  });

  // Best-effort in-process update — only helps if this instance later serves a
  // page for the same shop, but it costs nothing.
  invalidatePlanCache(shop);
  setCachedPlan(shop, plan, {
    status,
    subscriptionId: subscription.admin_graphql_api_id ?? null,
  });

  // Mirror onto the shop metafield the storefront reads, so a cancellation
  // stops Growth-only rendering on the storefront too, not just in the admin.
  try {
    const { admin } = await unauthenticated.admin(shop);
    await syncShopPlan(admin, shop, plan, true);
  } catch (e) {
    // An uninstall races this webhook: the offline session is already gone, so
    // there is nothing to authenticate with. Not an error worth failing on —
    // returning non-2xx would make Shopify retry a webhook that can never work.
    console.error(
      "[CustomVogue] subscriptions_update metafield sync failed:",
      e instanceof Error ? e.message : String(e),
    );
  }

  return new Response();
};
