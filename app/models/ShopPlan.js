import mongoose from "mongoose";

// Durable record of what plan a shop is on.
//
// The in-process cache in utils/billing.server.js dies with the process, and on
// Vercel every request can land on a different (often cold) lambda. Without a
// durable record, a merchant who has just paid gets downgraded to Free the
// moment billing.check() has a bad minute on a fresh instance. This collection
// is that record: written whenever we learn the plan for certain (upgrade
// confirmed, cancel, app_subscriptions/update webhook), and read only as a
// fallback when the live billing API can't be reached.
const shopPlanSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // shop domain, e.g. foo.myshopify.com
    plan: { type: String, required: true }, // "Free" | "Growth"
    subscriptionId: { type: String, default: null },
    // Last status seen from the subscription webhook: ACTIVE, CANCELLED,
    // FROZEN, EXPIRED, DECLINED, PENDING.
    status: { type: String, default: null },
    // Set for test charges so a test subscription is never mistaken for a
    // paying customer when auditing this collection.
    test: { type: Boolean, default: false },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false, timestamps: false }
);

export default mongoose.models.ShopPlan ||
  mongoose.model("ShopPlan", shopPlanSchema);
