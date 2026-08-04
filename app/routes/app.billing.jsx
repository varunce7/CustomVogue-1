import { useEffect } from "react";
import { redirect, useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useBusyTimeout } from "../hooks/useBusyTimeout";
import { authenticate } from "../shopify.server";
import { syncShopPlan } from "../utils/appUrl.server.js";
import {
  confirmActivePlan,
  getCurrentPlan,
  getTrialState,
  invalidatePlanCache,
  setCachedPlan,
  shouldUseTestCharge,
} from "../utils/billing.server.js";
import { PLANS, PLAN_FEATURES, PLAN_PRICING, TRIAL_DAYS } from "../utils/plans.js";

export const loader = async ({ request }) => {
  const { session, billing, admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  // Drives the trial copy on the Growth card and the "N days left" badge.
  const trial = await getTrialState(admin);
  // True on development stores too, not just NODE_ENV=development.
  const isTest = await shouldUseTestCharge(admin, session.shop);

  // ── Upgrade return ──────────────────────────────────────────────────────────
  // Shopify appends ?charge_id=... after the merchant approves the charge, but
  // the parameter alone proves nothing — confirm the subscription really is
  // active before granting Growth.
  if (url.searchParams.has("charge_id")) {
    invalidatePlanCache(session.shop);
    const { plan, confirmed } = await confirmActivePlan(billing, session.shop);
    syncShopPlan(admin, session.shop, plan, true).catch(() => { });
    return {
      plan,
      trial,
      trialDays: TRIAL_DAYS,
      isTest,
      upgradeNotConfirmed: plan === PLANS.FREE,
      pendingConfirmation: plan === PLANS.GROWTH && !confirmed,
    };
  }

  // ── Cancel return ───────────────────────────────────────────────────────────
  // The cancel action seeds the cache to FREE before redirecting here with
  // ?cancelled=1. Use the cache directly — don't call billing.check() which
  // may still show GROWTH if Shopify hasn't propagated the cancellation yet.
  if (url.searchParams.has("cancelled")) {
    const plan = await getCurrentPlan(billing, session.shop); // returns cached FREE
    syncShopPlan(admin, session.shop, plan, true).catch(() => { });
    return { plan, trial, trialDays: TRIAL_DAYS, isTest };
  }

  // ── Normal page load ────────────────────────────────────────────────────────
  // Use the cache (30-min TTL, 60-min after upgrade). Only invalidate after known
  // billing events (upgrade / cancel), not on every visit — billing.check() 403s in
  // dev and wiping the cache here would reset the plan to Free on every navigation.
  const plan = await getCurrentPlan(billing, session.shop);
  syncShopPlan(admin, session.shop, plan, true).catch(() => { });
  return { plan, trial, trialDays: TRIAL_DAYS, isTest };
};

export const action = async ({ request }) => {
  const { billing, admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "upgrade") {
    // Deliberately NOT billing.request(). That helper creates the subscription
    // and then throws a bare 401 carrying an App Bridge redirect header, which
    // React Router hands straight to the ErrorBoundary — the merchant just sees
    // a blank "Handling response" page and the redirect never happens.
    // Creating the subscription directly gives us the confirmationUrl as plain
    // data, which the client can navigate the top frame to.
    const shopHandle = session.shop.replace(/\.myshopify\.com$/, "");
    // The app's handle in admin URLs (admin.shopify.com/store/<shop>/apps/<handle>).
    // eslint-disable-next-line no-undef
    const appHandle = process.env.SHOPIFY_APP_HANDLE || "customvogue";
    // Return into the app *inside* Shopify admin. Returning to the app's own
    // origin drops the shop/host context and dumps the merchant on the login
    // screen right after they have paid.
    const returnUrl = `https://admin.shopify.com/store/${shopHandle}/apps/${appHandle}/app/billing`;
    const pricing = PLAN_PRICING[PLANS.GROWTH];

    // One trial per shop — a merchant who cancels and re-subscribes pays from
    // day one. Shopify does not enforce this, so it's checked here.
    const { hasUsedTrial } = await getTrialState(admin);
    const trialDays = hasUsedTrial ? 0 : TRIAL_DAYS;

    // A real charge on a development store can't be approved — Shopify disables
    // the Approve button because no payment method can exist there.
    const isTest = await shouldUseTestCharge(admin, session.shop);

    try {
      const response = await admin.graphql(
        `#graphql
        mutation createAppSubscription(
          $name: String!
          $returnUrl: URL!
          $test: Boolean!
          $trialDays: Int!
          $lineItems: [AppSubscriptionLineItemInput!]!
        ) {
          appSubscriptionCreate(
            name: $name
            returnUrl: $returnUrl
            test: $test
            trialDays: $trialDays
            lineItems: $lineItems
          ) {
            confirmationUrl
            appSubscription { id status trialDays }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            name: PLANS.GROWTH,
            returnUrl,
            test: isTest,
            trialDays,
            lineItems: [
              {
                plan: {
                  appRecurringPricingDetails: {
                    price: { amount: pricing.amount, currencyCode: pricing.currencyCode },
                    interval: pricing.interval,
                  },
                },
              },
            ],
          },
        }
      );

      const json = await response.json();
      const result = json.data?.appSubscriptionCreate;
      const userErrors = result?.userErrors ?? [];

      if (userErrors.length > 0) {
        const msg = userErrors.map((u) => u.message).join(" ");
        console.error("[CustomVogue] appSubscriptionCreate userErrors:", JSON.stringify(userErrors));
        return { error: msg };
      }

      if (!result?.confirmationUrl) {
        console.error("[CustomVogue] appSubscriptionCreate returned no confirmationUrl:", JSON.stringify(json).slice(0, 500));
        return { error: "Shopify did not return a confirmation URL. Please reload and try again." };
      }

      return { confirmationUrl: result.confirmationUrl };
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      // The usual setup failure: this store/app isn't allowed to create charges.
      if (msg.includes("403")) {
        msg = "Shopify rejected the billing request (403). The app must be installed on a development store, or approved for billing, before subscriptions can be created.";
      }
      console.error("[CustomVogue] appSubscriptionCreate error:", msg);
      return { error: msg };
    }
  }

  if (intent === "cancel") {
    try {
      const { appSubscriptions } = await billing.check({
        plans: [PLANS.GROWTH],
        isTest: true, // match test subscriptions too, else dev stores can't cancel
      });
      if (appSubscriptions?.length > 0) {
        await billing.cancel({
          subscriptionId: appSubscriptions[0].id,
          isTest: true,
          prorate: true,
        });
      }
    } catch (e) {
      console.error("[CustomVogue] billing cancel error:", e.message);
    }
    // Seed FREE in cache so the ?cancelled=1 loader path reads it without
    // calling billing.check() (which may not reflect the cancellation yet).
    invalidatePlanCache(session.shop);
    setCachedPlan(session.shop, PLANS.FREE);
    syncShopPlan(admin, session.shop, PLANS.FREE, true).catch(() => { });
    return redirect("/app/billing?cancelled=1");
  }

  return null;
};

const CHECK = "✓";

export default function BillingPage() {
  const { plan, trial, trialDays, isTest, upgradeNotConfirmed, pendingConfirmation } = useLoaderData();
  const upgradeFetcher = useFetcher();
  const cancelFetcher = useFetcher();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTab = searchParams.get("tab") || "App Settings";

  const isGrowth = plan === PLANS.GROWTH;
  const trialEligible = !isGrowth && !trial?.hasUsedTrial;
  const inTrial = isGrowth && Boolean(trial?.inTrial);
  const daysLeft = trial?.trialDaysRemaining ?? 0;
  const upgradeError = upgradeFetcher.data?.error;
  const confirmationUrl = upgradeFetcher.data?.confirmationUrl;

  // The charge approval page must replace the whole admin window, not load
  // inside the app's iframe. App Bridge intercepts window.open(url, "_top");
  // the assignment is a fallback for when it isn't listening.
  useEffect(() => {
    if (!confirmationUrl || typeof window === "undefined") return;
    try {
      window.open(confirmationUrl, "_top");
    } catch {
      window.top.location.href = confirmationUrl;
    }
  }, [confirmationUrl]);
  // "submitting" while the request is in-flight; "loading" while the action
  // response is being processed; App Bridge intercepts the 401+header and
  // navigates window.top before React Router even sets state back to "idle".
  // Safety net: on success App Bridge navigates window.top away before state
  // resets (harmless if this fires mid-navigation), but on a dropped/hung
  // request these buttons would otherwise stay disabled forever.
  const isUpgrading = useBusyTimeout(upgradeFetcher.state !== "idle" || Boolean(confirmationUrl), 15000);
  const isCancelling = useBusyTimeout(cancelFetcher.state !== "idle", 15000);

  const handleBack = () => {
    // Always navigate explicitly rather than history.back(-1): this page can
    // accumulate same-looking history entries from server redirects after
    // upgrade/cancel (?charge_id=..., ?cancelled=1), which made "-1" sometimes
    // land on another identical-looking Billing entry instead of leaving the page.
    navigate(`/app?tab=${encodeURIComponent(returnTab)}`);
  };

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <button type="button" onClick={handleBack} style={styles.backLink}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
          Back
        </button>
        <h1 style={styles.heading}>Choose your plan</h1>
        <p style={styles.subheading}>Start free, upgrade when you need more.</p>
      </div>

      {upgradeError && (
        <div style={styles.errorBanner}>{upgradeError}</div>
      )}

      {upgradeNotConfirmed && (
        <div style={styles.errorBanner}>
          {"We couldn't confirm an active subscription for this store, so you're still on Free. If you just approved the charge, wait a moment and reload."}
        </div>
      )}

      {pendingConfirmation && (
        <div style={styles.noticeBanner}>
          {"Growth is active. We couldn't reach Shopify to double-check the subscription just now, so it will be re-verified on your next visit."}
        </div>
      )}

      {isTest && (
        <div style={styles.noticeBanner}>
          Test mode — Shopify will show a real approval screen, but no money is charged.
        </div>
      )}

      {/* Plan cards */}
      <div style={styles.cardsRow}>
        {/* Free Plan */}
        <div style={{ ...styles.card, ...(isGrowth ? {} : styles.cardActive) }}>
          <div style={styles.cardHeader}>
            <span style={styles.planName}>Free</span>
            {!isGrowth && <span style={styles.currentBadge}>Current plan</span>}
          </div>
          <div style={styles.priceRow}>
            <span style={styles.priceAmount}>$0</span>
            <span style={styles.pricePer}>/month</span>
          </div>
          <p style={styles.trialNote}>&nbsp;</p>
          <ul style={styles.featureList}>
            {PLAN_FEATURES[PLANS.FREE].map((f) => (
              <li key={f} style={styles.featureItem}>
                <span style={styles.checkIcon}>{CHECK}</span>
                {f}
              </li>
            ))}
          </ul>
          {isGrowth ? (
            <cancelFetcher.Form method="post">
              <input type="hidden" name="intent" value="cancel" />
              <button
                type="submit"
                style={{ ...styles.planBtn, ...styles.cancelBtn }}
                disabled={isCancelling}
              >
                {isCancelling ? "Processing…" : "Downgrade to Free"}
              </button>
            </cancelFetcher.Form>
          ) : (
            <div style={{ ...styles.planBtn, ...styles.currentBtn }}>Current plan</div>
          )}
        </div>

        {/* Growth Plan */}
        <div style={{ ...styles.card, ...(isGrowth ? styles.cardActive : styles.cardGrowth) }}>
          {!isGrowth && <div style={styles.popularBadge}>Most Popular</div>}
          <div style={styles.cardHeader}>
            <span style={styles.planName}>Growth</span>
            {isGrowth && (
              <span style={{ ...styles.currentBadge, ...(inTrial ? styles.trialBadge : {}) }}>
                {inTrial
                  ? `Trial — ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`
                  : "Current plan"}
              </span>
            )}
          </div>
          <div style={styles.priceRow}>
            <span style={styles.priceAmount}>${PLAN_PRICING[PLANS.GROWTH].amount}</span>
            <span style={styles.pricePer}>/month</span>
          </div>
          <p style={{ ...styles.trialNote, ...(trialEligible || inTrial ? styles.trialNoteHighlight : {}) }}>
            {trialEligible
              ? `${trialDays}-day free trial, then $${PLAN_PRICING[PLANS.GROWTH].amount}/month`
              : inTrial
                ? `Free until your trial ends — then $${PLAN_PRICING[PLANS.GROWTH].amount}/month`
                : "Cancel anytime"}
          </p>
          <ul style={styles.featureList}>
            {PLAN_FEATURES[PLANS.GROWTH].map((f) => (
              <li key={f} style={styles.featureItem}>
                <span style={{ ...styles.checkIcon, color: "#2563eb" }}>{CHECK}</span>
                {f}
              </li>
            ))}
          </ul>
          {isGrowth ? (
            <div style={{ ...styles.planBtn, ...styles.currentBtn }}>Current plan</div>
          ) : (
            <upgradeFetcher.Form method="post">
              <input type="hidden" name="intent" value="upgrade" />
              <button
                type="submit"
                style={{ ...styles.planBtn, ...styles.upgradeBtn }}
                disabled={isUpgrading}
              >
                {isUpgrading
                  ? "Processing…"
                  : trialEligible
                    ? `Start ${trialDays}-day free trial`
                    : `Select monthly — $${PLAN_PRICING[PLANS.GROWTH].amount}/mo`}
              </button>
            </upgradeFetcher.Form>
          )}
        </div>
      </div>

      {/* Comparison table */}
      <div style={styles.tableWrap}>
        <h2 style={styles.tableHeading}>Full plan comparison</h2>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Feature</th>
              <th style={{ ...styles.th, textAlign: "center" }}>Free</th>
              <th style={{ ...styles.th, textAlign: "center", color: "#2563eb" }}>Growth</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["Products with custom fields", "Up to 100", "Unlimited"],
              ["Fields per product", "Up to 5", "Unlimited"],
              ["Display styles (Accordion + Tabs)", "✓", "✓"],
              ["Rich text editor", "✓", "✓"],
              ["Image embed & resize", "✓", "✓"],
              ["Bulk Apply", "—", "✓"],
              ["Live preview", "✓", "✓"],
              ["CSV Import", "—", "✓"],
              ["CSV Export", "—", "✓"],
              ["Custom CSS injection", "—", "✓"],
              ["Analytics dashboard", "—", "✓"],
              ["Support", "Email", "Priority + call"],
            ].map(([feature, free, growth]) => (
              <tr key={feature} style={styles.tr}>
                <td style={styles.td}>{feature}</td>
                <td style={{ ...styles.td, textAlign: "center", color: free === "—" ? "#9ca3af" : "#111827" }}>
                  {free}
                </td>
                <td style={{ ...styles.td, textAlign: "center", color: growth === "—" ? "#9ca3af" : "#2563eb", fontWeight: growth !== "—" ? 600 : 400 }}>
                  {growth}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const styles = {
  page: {
    fontFamily: "sans-serif",
    maxWidth: 880,
    margin: "0 auto",
    padding: "32px 24px",
  },
  header: {
    textAlign: "center",
    marginBottom: 40,
  },
  backLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: "#6b7280",
    textDecoration: "none",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    marginBottom: 20,
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid #e5e7eb",
    background: "#fff",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },
  heading: {
    fontSize: 32,
    fontWeight: 700,
    color: "#111827",
    margin: "0 0 8px",
  },
  subheading: {
    fontSize: 16,
    color: "#6b7280",
    margin: 0,
  },
  errorBanner: {
    background: "#fee2e2",
    color: "#991b1b",
    border: "1px solid #fca5a5",
    borderRadius: 6,
    padding: "12px 16px",
    fontSize: 14,
    marginBottom: 20,
    textAlign: "center",
  },
  noticeBanner: {
    background: "#eff6ff",
    color: "#1e40af",
    border: "1px solid #bfdbfe",
    borderRadius: 6,
    padding: "10px 16px",
    fontSize: 13,
    marginBottom: 20,
    textAlign: "center",
  },
  confirmBanner: {
    background: "#d1fae5",
    color: "#065f46",
    border: "1px solid #6ee7b7",
    borderRadius: 8,
    padding: "14px 20px",
    fontSize: 14,
    marginBottom: 20,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    fontWeight: 500,
  },
  confirmLink: {
    display: "inline-block",
    background: "#059669",
    color: "#fff",
    padding: "8px 20px",
    borderRadius: 6,
    fontWeight: 700,
    fontSize: 14,
    textDecoration: "none",
  },
  cardsRow: {
    display: "flex",
    gap: 24,
    marginBottom: 48,
    justifyContent: "center",
    flexWrap: "wrap",
    alignItems: "stretch",
  },
  card: {
    flex: "1 1 320px",
    maxWidth: 380,
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "28px 28px 24px",
    background: "#fff",
    position: "relative",
    display: "flex",
    flexDirection: "column",
  },
  cardActive: {
    border: "2px solid #111827",
    boxShadow: "0 4px 20px rgba(0,0,0,0.1)",
  },
  cardGrowth: {
    border: "2px solid #2563eb",
    boxShadow: "0 4px 20px rgba(37,99,235,0.15)",
  },
  popularBadge: {
    position: "absolute",
    top: -12,
    left: "50%",
    transform: "translateX(-50%)",
    background: "#2563eb",
    color: "#fff",
    fontSize: 11,
    fontWeight: 700,
    padding: "3px 12px",
    borderRadius: 12,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  planName: {
    fontSize: 20,
    fontWeight: 700,
    color: "#111827",
  },
  currentBadge: {
    background: "#f3f4f6",
    color: "#374151",
    fontSize: 11,
    fontWeight: 600,
    padding: "3px 10px",
    borderRadius: 12,
  },
  priceRow: {
    display: "flex",
    alignItems: "baseline",
    gap: 4,
    marginBottom: 4,
  },
  priceAmount: {
    fontSize: 40,
    fontWeight: 800,
    color: "#111827",
    lineHeight: 1,
  },
  pricePer: {
    fontSize: 14,
    color: "#6b7280",
  },
  trialBadge: {
    background: "#dcfce7",
    color: "#15803d",
  },
  trialNoteHighlight: {
    color: "#15803d",
    fontWeight: 600,
  },
  trialNote: {
    fontSize: 12,
    color: "#9ca3af",
    margin: "0 0 20px",
  },
  featureList: {
    listStyle: "none",
    padding: 0,
    margin: "0 0 24px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    flex: 1,
  },
  featureItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    fontSize: 14,
    color: "#374151",
    lineHeight: 1.4,
  },
  checkIcon: {
    color: "#16a34a",
    fontWeight: 700,
    flexShrink: 0,
    marginTop: 1,
  },
  planBtn: {
    display: "block",
    width: "100%",
    padding: "11px 0",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    textAlign: "center",
    cursor: "pointer",
    border: "none",
    boxSizing: "border-box",
  },
  upgradeBtn: {
    background: "#2563eb",
    color: "#fff",
  },
  currentBtn: {
    background: "#f3f4f6",
    color: "#6b7280",
    cursor: "default",
  },
  cancelBtn: {
    background: "#fff",
    color: "#6b7280",
    border: "1px solid #d1d5db",
    width: "100%",
  },
  tableWrap: {
    borderRadius: 12,
    border: "1px solid #e5e7eb",
    overflow: "hidden",
  },
  tableHeading: {
    fontSize: 18,
    fontWeight: 700,
    color: "#111827",
    margin: 0,
    padding: "20px 24px 16px",
    borderBottom: "1px solid #e5e7eb",
    background: "#f9fafb",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
  },
  th: {
    padding: "12px 24px",
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
    background: "#f9fafb",
    borderBottom: "1px solid #e5e7eb",
    textAlign: "left",
  },
  tr: {
    borderBottom: "1px solid #f3f4f6",
  },
  td: {
    padding: "12px 24px",
    fontSize: 14,
    color: "#374151",
  },
};
