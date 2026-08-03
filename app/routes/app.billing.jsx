import { redirect, useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useBusyTimeout } from "../hooks/useBusyTimeout";
import { authenticate } from "../shopify.server";
import { syncShopPlan } from "../utils/appUrl.server.js";
import {
  BILLING_IS_TEST,
  getCurrentPlan,
  invalidatePlanCache,
  setCachedPlan,
} from "../utils/billing.server.js";
import { PLANS, PLAN_FEATURES } from "../utils/plans.js";

export const loader = async ({ request }) => {
  const { session, billing, admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  // ── Upgrade return ──────────────────────────────────────────────────────────
  // Shopify appends ?charge_id=... ONLY after the merchant explicitly approves.
  // Trust it immediately and skip billing.check() entirely — the subscription
  // may not yet be "active" in Shopify's system at the moment we redirect back,
  // so calling billing.check() here can return false even though the user paid.
  if (url.searchParams.has("charge_id")) {
    invalidatePlanCache(session.shop);
    setCachedPlan(session.shop, PLANS.GROWTH);
    syncShopPlan(admin, session.shop, PLANS.GROWTH, true).catch(() => { });
    return { plan: PLANS.GROWTH };
  }

  // ── Cancel return ───────────────────────────────────────────────────────────
  // The cancel action seeds the cache to FREE before redirecting here with
  // ?cancelled=1. Use the cache directly — don't call billing.check() which
  // may still show GROWTH if Shopify hasn't propagated the cancellation yet.
  if (url.searchParams.has("cancelled")) {
    const plan = await getCurrentPlan(billing, session.shop); // returns cached FREE
    syncShopPlan(admin, session.shop, plan, true).catch(() => { });
    return { plan };
  }

  // ── Normal page load ────────────────────────────────────────────────────────
  // Use the cache (30-min TTL, 60-min after upgrade). Only invalidate after known
  // billing events (upgrade / cancel), not on every visit — billing.check() 403s in
  // dev and wiping the cache here would reset the plan to Free on every navigation.
  const plan = await getCurrentPlan(billing, session.shop);
  syncShopPlan(admin, session.shop, plan, true).catch(() => { });
  return { plan };
};

export const action = async ({ request }) => {
  const { billing, admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "upgrade") {
    // Dev bypass: Shopify billing API returns 403 for unpublished apps.
    // Simulate the "charge approved" redirect so the full upgrade flow can be tested locally.
    // eslint-disable-next-line no-undef
    if (process.env.NODE_ENV !== "production") {
      invalidatePlanCache(session.shop);
      setCachedPlan(session.shop, PLANS.GROWTH);
      syncShopPlan(admin, session.shop, PLANS.GROWTH, true).catch(() => { });
      return redirect("/app/billing?charge_id=dev_test");
    }

    const url = new URL(request.url);
    const returnUrl = `${url.origin}/app/billing`;

    try {
      // billing.request() creates the subscription then throws a Response:
      //  • XHR requests  → 401 + X-Shopify-API-Request-Failure-Reauthorize-Url header
      //    App Bridge intercepts that header and navigates window.top automatically.
      //  • Non-XHR       → redirect to exit-iframe path or directly to confirmationUrl
      await billing.request({
        plan: PLANS.GROWTH,
        isTest: BILLING_IS_TEST,
        returnUrl,
      });
      // billing.request() always throws before reaching here.
      return null;
    } catch (e) {
      // Re-throw the Response so React Router / App Bridge can handle it.
      if (e instanceof Response) throw e;

      // Real error (subscription creation failed, BillingError, etc.)
      const msg = e?.errorData?.[0]?.message
        ?? (e instanceof Error ? e.message : null)
        ?? "Billing request failed. Please reload and try again.";
      console.error("[CustomVogue] billing.request error:", msg, e?.errorData ?? []);
      return { error: msg };
    }
  }

  if (intent === "cancel") {
    try {
      const { appSubscriptions } = await billing.check({
        plans: [PLANS.GROWTH],
        isTest: BILLING_IS_TEST,
      });
      if (appSubscriptions?.length > 0) {
        await billing.cancel({
          subscriptionId: appSubscriptions[0].id,
          isTest: BILLING_IS_TEST,
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
  const { plan } = useLoaderData();
  const upgradeFetcher = useFetcher();
  const cancelFetcher = useFetcher();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTab = searchParams.get("tab") || "App Settings";

  const isGrowth = plan === PLANS.GROWTH;
  const upgradeError = upgradeFetcher.data?.error;
  // "submitting" while the request is in-flight; "loading" while the action
  // response is being processed; App Bridge intercepts the 401+header and
  // navigates window.top before React Router even sets state back to "idle".
  // Safety net: on success App Bridge navigates window.top away before state
  // resets (harmless if this fires mid-navigation), but on a dropped/hung
  // request these buttons would otherwise stay disabled forever.
  const isUpgrading = useBusyTimeout(upgradeFetcher.state !== "idle", 15000);
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
            {isGrowth && <span style={styles.currentBadge}>Current plan</span>}
          </div>
          <div style={styles.priceRow}>
            <span style={styles.priceAmount}>$4.99</span>
            <span style={styles.pricePer}>/month</span>
          </div>
          <p style={styles.trialNote}>Cancel anytime</p>
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
                {isUpgrading ? "Processing…" : "Select monthly — $4.99/mo"}
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
