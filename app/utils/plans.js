export const PLANS = {
  FREE: "Free",
  GROWTH: "Growth",
};

// Length of the free trial offered on Growth, in days. One trial per shop.
export const TRIAL_DAYS = 7;

// Single source of truth for what Growth costs. Must stay in step with the
// `billing` block in shopify.server.js.
export const PLAN_PRICING = {
  [PLANS.GROWTH]: {
    amount: 4.99,
    currencyCode: "USD",
    interval: "EVERY_30_DAYS",
  },
};

export const FREE_PLAN_LIMITS = {
  maxProducts: 100,
  maxFieldsPerProduct: 5,
};

export const PLAN_FEATURES = {
  [PLANS.FREE]: [
    "Up to 100 products with custom fields",
    "Up to 5 fields per product",
    "Accordion + Horizontal Tabs display",
    "Rich text editor (22 fonts, bold/italic/colors)",
    "Image embed & resize",
    "Theme block customization",
    "Live preview before saving",
    "Email support via contact form",
  ],
  [PLANS.GROWTH]: [
    "Unlimited products",
    "Unlimited fields per product",
    "Everything in Free",
    "Bulk Apply — copy fields across products",
    "CSV Import & Export",
    "Custom CSS injection — style without theme editor",
    "Analytics dashboard — field usage & growth insights",
    "Priority support + onboarding call",
  ],
};
