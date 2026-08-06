import { authenticate } from "../shopify.server";
import connection from "../db.server.js";
import ProductField from "../models/ProductField.js";
import SessionModel from "../models/Session.js";
import ShopPlan from "../models/ShopPlan.js";
import { invalidatePlanCache } from "../utils/billing.server.js";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (session) {
    await connection;
    await Promise.all([
      ProductField.deleteMany({ shop }),
      SessionModel.deleteMany({ shop }),
      // Uninstalling cancels the subscription. Leaving a "Growth" record behind
      // would hand a free upgrade to whoever reinstalls on this domain, since
      // the record is what the app falls back to when billing.check() fails.
      ShopPlan.deleteOne({ _id: shop }),
    ]);
  }

  invalidatePlanCache(shop);

  return new Response();
};
