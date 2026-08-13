import mongoose from "mongoose";

// One row per shop, written the moment the merchant finishes (or skips) the
// welcome flow at /app/onboarding. Its absence is what sends a freshly
// installed shop to the welcome screen instead of straight to the dashboard,
// so onboarding is shown exactly once per install.
const shopOnboardingSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // shop domain, e.g. foo.myshopify.com
    completedAt: { type: Date, default: Date.now },
  },
  { _id: false, timestamps: false }
);

export default mongoose.models.ShopOnboarding ||
  mongoose.model("ShopOnboarding", shopOnboardingSchema);
