import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useRef } from "react";
import { redirect, useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useBusyTimeout } from "../hooks/useBusyTimeout";
import { authenticate } from "../shopify.server";
import { syncShopPlan } from "../utils/appUrl.server.js";
import {
  BILLING_IS_TEST,
  confirmActivePlan,
  formatBillingDate,
  getCurrentPlan,
  getShopBillingContext,
  getTrialState,
  invalidatePlanCache,
  isDevelopmentStore,
  resolveBillingTest,
  setCachedPlan,
} from "../utils/billing.server.js";
import { PLANS, PLAN_FEATURES, PLAN_PRICING, TRIAL_DAYS } from "../utils/plans.js";

export const loader = async ({ request }) => {
  const { session, billing, admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  // Drives the trial copy on the Growth card and the "N days left" badge.
  const [trial, shopContext] = await Promise.all([
    getTrialState(admin),
    getShopBillingContext(admin, session.shop),
  ]);
  // Real charge on a real store. A Partner development store gets a test
  // charge, because Shopify greys out Approve on a real one there — see
  // resolveBillingTest. Kept identical to what the upgrade action passes to
  // appSubscriptionCreate so the page never describes a different charge from
  // the one the merchant is actually sent to approve.
  const isTest = BILLING_IS_TEST || shopContext.isDevelopmentStore;
  // True only for the manual env override, which is the case worth warning
  // about: it puts a *live* store on a charge that collects no money.
  const testChargeForced = BILLING_IS_TEST && !shopContext.isDevelopmentStore;

  // The trial end date exists only once a subscription does. Nothing here
  // projects a date for a trial that hasn't started: the merchant starts the
  // trial by approving the charge on Shopify's screen, and that screen is where
  // they first see the date. Showing one earlier reads as "your trial is
  // already running", which is not what happened. Formatted in the shop's own
  // timezone so it matches the date Shopify prints on the approval screen.
  const trialEndsOn = formatBillingDate(trial.trialEndsAt, shopContext.timeZone);
  const dates = { trialEndsOn, isDevStore: shopContext.isDevelopmentStore, testChargeForced };

  // ── Upgrade return ──────────────────────────────────────────────────────────
  // Shopify appends ?charge_id=... after the merchant approves the charge, but
  // the parameter alone proves nothing — confirm the subscription really is
  // active before granting Growth.
  if (url.searchParams.has("charge_id")) {
    invalidatePlanCache(session.shop);
    const { plan, confirmed } = await confirmActivePlan(billing, session.shop, { isTest });
    syncShopPlan(admin, session.shop, plan, true).catch(() => { });
    // The trial read at the top of this loader ran before the subscription
    // flipped to ACTIVE, so activeSubscriptions was still empty and there was
    // no end date to show on the very screen the merchant lands on after
    // approving. Re-read it now that the charge is confirmed.
    const activeTrial = plan === PLANS.GROWTH ? await getTrialState(admin) : trial;
    return {
      plan,
      trial: activeTrial,
      trialDays: TRIAL_DAYS,
      isTest,
      ...dates,
      trialEndsOn:
        formatBillingDate(activeTrial.trialEndsAt, shopContext.timeZone) ?? trialEndsOn,
      upgradeNotConfirmed: plan === PLANS.FREE,
      pendingConfirmation: plan === PLANS.GROWTH && !confirmed,
      // Only set on the return from Shopify's approval screen, and only once
      // the subscription is really active — drives the "plan is now active"
      // toast. A normal visit to this page must never fire it.
      justActivated: plan === PLANS.GROWTH,
    };
  }

  // ── Cancel return ───────────────────────────────────────────────────────────
  // The cancel action seeds the cache to FREE before redirecting here with
  // ?cancelled=1. Use the cache directly — don't call billing.check() which
  // may still show GROWTH if Shopify hasn't propagated the cancellation yet.
  if (url.searchParams.has("cancelled")) {
    const plan = await getCurrentPlan(billing, session.shop); // returns cached FREE
    syncShopPlan(admin, session.shop, plan, true).catch(() => { });
    return { plan, trial, trialDays: TRIAL_DAYS, isTest, ...dates };
  }

  // ── Normal page load ────────────────────────────────────────────────────────
  // Use the cache (30-min TTL, 60-min after upgrade). Only invalidate after known
  // billing events (upgrade / cancel), not on every visit — billing.check() 403s in
  // dev and wiping the cache here would reset the plan to Free on every navigation.
  const plan = await getCurrentPlan(billing, session.shop);
  syncShopPlan(admin, session.shop, plan, true).catch(() => { });
  return { plan, trial, trialDays: TRIAL_DAYS, isTest, ...dates };
};

// Turns Shopify's terse billing rejections into something a human can act on.
// The one that bites hardest is "The shop cannot accept the provided charge":
// Shopify refuses real charges on Partner development stores because no payment
// method can exist there, and the raw message gives no hint that the store type
// is the problem.
async function explainChargeError(raw, admin, shop, isTest) {
  const text = String(raw ?? "");

  if (/cannot accept the provided charge/i.test(text)) {
    // Should no longer be reachable on a development store — those now get a
    // test charge, which Shopify does accept. Kept in case the shop lookup
    // failed and the store was therefore treated as live.
    if (!isTest && (await isDevelopmentStore(admin, shop))) {
      return "Shopify rejected the charge because this is a development store, which can't hold a payment method. Reload and try again — the app bills development stores with a test charge, which Shopify does accept.";
    }
    return "Shopify won't accept a charge for this store right now. Check that the store has a valid payment method and an active Shopify plan, then try again.";
  }

  if (text.includes("403")) {
    return "Shopify rejected the billing request (403). Confirm the app is approved for billing and that its access scopes are up to date, then reinstall and try again.";
  }

  return text;
}

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
    const appHandle = process.env.SHOPIFY_APP_HANDLE || "metavogue";
    // Return into the app *inside* Shopify admin. Returning to the app's own
    // origin drops the shop/host context and dumps the merchant on the login
    // screen right after they have paid.
    const returnUrl = `https://admin.shopify.com/store/${shopHandle}/apps/${appHandle}/app/billing`;
    const pricing = PLAN_PRICING[PLANS.GROWTH];

    // One trial per shop — a merchant who cancels and re-subscribes pays from
    // day one. Shopify does not enforce this, so it's checked here.
    const { hasUsedTrial } = await getTrialState(admin);
    const trialDays = hasUsedTrial ? 0 : TRIAL_DAYS;

    // Real money on a real store. Only a Partner development store (where
    // Shopify refuses to process money at all, and would render Approve greyed
    // out) or the explicit SHOPIFY_BILLING_TEST override gets a test charge.
    const isTest = await resolveBillingTest(admin, session.shop);

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
        const raw = userErrors.map((u) => u.message).join(" ");
        console.error("[CustomVogue] appSubscriptionCreate userErrors:", JSON.stringify(userErrors));
        return { error: await explainChargeError(raw, admin, session.shop, isTest) };
      }

      if (!result?.confirmationUrl) {
        console.error("[CustomVogue] appSubscriptionCreate returned no confirmationUrl:", JSON.stringify(json).slice(0, 500));
        return { error: "Shopify did not return a confirmation URL. Please reload and try again." };
      }

      return { confirmationUrl: result.confirmationUrl };
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      console.error("[CustomVogue] appSubscriptionCreate error:", raw);
      return { error: await explainChargeError(raw, admin, session.shop, isTest) };
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
  const {
    plan,
    trial,
    trialDays,
    trialEndsOn,
    isDevStore,
    testChargeForced,
    justActivated,
    upgradeNotConfirmed,
    pendingConfirmation,
  } = useLoaderData();
  const upgradeFetcher = useFetcher();
  const cancelFetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTab = searchParams.get("tab") || "App Settings";

  const isGrowth = plan === PLANS.GROWTH;
  const trialEligible = !isGrowth && !trial?.hasUsedTrial;
  const inTrial = isGrowth && Boolean(trial?.inTrial);
  const daysLeft = trial?.trialDaysRemaining ?? 0;
  const upgradeError = upgradeFetcher.data?.error;
  const confirmationUrl = upgradeFetcher.data?.confirmationUrl;

  // Confirmation toast on the way back from Shopify's approval screen, the way
  // Shopify's own billing pages acknowledge an approved charge. Guarded by a
  // ref because ?charge_id stays in the URL: any revalidation of this route
  // would otherwise re-announce an activation that already happened. Wrapped
  // because a toast failing must never take the billing page down with it.
  const toastShown = useRef(false);
  useEffect(() => {
    if (!justActivated || toastShown.current) return;
    toastShown.current = true;
    try {
      shopify?.toast?.show("Your plan is now active", { duration: 4000 });
    } catch (e) {
      console.error("[CustomVogue] plan toast failed:", e instanceof Error ? e.message : e);
    }
  }, [justActivated, shopify]);

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

      {/* Trial banner — the one place the merchant is told, in plain words and
          with a real date, when the free trial stops being free. Shown for as
          long as the trial runs, not just on the hop back from approval. */}
      {inTrial && trialEndsOn && (
        <div style={styles.trialBanner}>
          <span style={styles.trialBannerIcon} aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </span>
          <span>
            {`Your free trial ends on ${trialEndsOn}.`}{" "}
            <span style={styles.trialBannerMuted}>
              {`You won't be charged until then — the first $${PLAN_PRICING[PLANS.GROWTH].amount} payment is taken on that date, and cancelling before it costs you nothing.`}
            </span>
          </span>
        </div>
      )}

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

      {/* SHOPIFY_BILLING_TEST=true on a store that is NOT a development store.
          Styled as a warning, not a notice: this means real merchants are
          approving charges that will never be billed. */}
      {testChargeForced && (
        <div style={styles.warningBanner}>
          <strong>Test charges are enabled</strong> (SHOPIFY_BILLING_TEST=true).
          Shopify shows a real approval screen but no money is collected. Unset
          this before going live.
        </div>
      )}

      {/* Only ever true on a Partner development store, so no live merchant
          sees this. Shopify will not process money on a development store, so
          the charge is a test one — which is precisely what keeps Approve
          clickable there instead of greyed out. Everything else about the flow
          (trial, end date, plan features) behaves exactly as it does live. */}
      {isDevStore && !isGrowth && (
        <div style={styles.noticeBanner}>
          <strong>Development store — this is a test charge.</strong>{" "}
          {`Shopify can't take real money on a development store, so the approval screen says "You will not be billed for this test charge". Approve works normally, the ${trialDays}-day trial and its end date are real, and nothing is charged. On a live store the same flow takes a real payment.`}
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
                ? trialEndsOn
                  ? `Free until ${trialEndsOn} — then $${PLAN_PRICING[PLANS.GROWTH].amount}/month`
                  : `Free until your trial ends — then $${PLAN_PRICING[PLANS.GROWTH].amount}/month`
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
            <div style={{ ...styles.planBtn, ...styles.currentBtn }}>Subscribed</div>
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
  warningBanner: {
    background: "#fffbeb",
    color: "#92400e",
    border: "1px solid #fcd34d",
    borderRadius: 6,
    padding: "10px 16px",
    fontSize: 13,
    marginBottom: 20,
    textAlign: "center",
    lineHeight: 1.5,
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
    // Reserve two lines on both cards: the Growth note now carries a date and
    // wraps, and without this the feature lists stop lining up side by side.
    minHeight: 30,
  },
  trialBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: "14px 16px",
    fontSize: 13,
    color: "#111827",
    lineHeight: 1.5,
    marginBottom: 20,
    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
  },
  trialBannerIcon: {
    color: "#2563eb",
    display: "flex",
    flexShrink: 0,
    marginTop: 1,
  },
  trialBannerMuted: {
    color: "#6b7280",
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
