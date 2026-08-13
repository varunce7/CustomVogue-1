import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { Link, redirect, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useBusyTimeout } from "../hooks/useBusyTimeout";
import connection from "../db.server.js";
import ProductField from "../models/ProductField.js";
import ShopOnboarding from "../models/ShopOnboarding.js";
import { authenticate } from "../shopify.server";
import { getShopAnalytics } from "../utils/analytics.server.js";
import { getCurrentPlan } from "../utils/billing.server.js";
import { redirectWithShopParams } from "../utils/embeddedRedirect.server.js";
import { clearAccordionMetafield } from "../utils/metafield.server.js";
import { FREE_PLAN_LIMITS, PLANS } from "../utils/plans.js";
import { getExistingProducts } from "../utils/products.server.js";

export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);

  // A shop that has never been through the welcome flow lands there first —
  // adding the theme block is what makes custom fields show on the storefront,
  // so it has to come before products and fields. The install params have to
  // travel with the redirect (see redirectWithShopParams), and a DB hiccup must
  // not lock anyone out of the dashboard, hence the swallowed error.
  try {
    await connection;
    const onboarded = await ShopOnboarding.exists({ _id: session.shop });
    if (!onboarded) return redirectWithShopParams(request, "/app/onboarding");
  } catch (e) {
    console.error("[CustomVogue] onboarding check error:", e instanceof Error ? e.message : e);
  }

  let existingProducts = [];
  let plan = PLANS.FREE;
  let analytics = null;

  try {
    [existingProducts, plan] = await Promise.all([
      getExistingProducts(session.shop),
      getCurrentPlan(billing, session.shop),
    ]);
  } catch (e) {
    console.error("[CustomVogue] home loader error:", e instanceof Error ? e.message : e);
  }

  try {
    if (plan === PLANS.GROWTH) {
      analytics = await getShopAnalytics(session.shop);
    }
  } catch (e) {
    console.error("[CustomVogue] analytics error:", e instanceof Error ? e.message : e);
  }

  return { existingProducts, plan, analytics };
};

// Tab switches (App Settings / How to use / Contact Us) navigate via
// setSearchParams({ tab }) on this same route, which by default reruns the
// loader above — a DB query plus Shopify billing/analytics API calls — on
// every click. None of that data changes when only `tab` changes, so skip
// revalidation for that case; it was making tab switches feel unresponsive.
export const shouldRevalidate = ({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }) => {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname) {
    const curParams = new URLSearchParams(currentUrl.search);
    const nextParams = new URLSearchParams(nextUrl.search);
    curParams.delete("tab");
    nextParams.delete("tab");
    if (curParams.toString() === nextParams.toString()) return false;
  }
  return defaultShouldRevalidate;
};

export const action = async ({ request }) => {
  const { session, admin, billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const _action = formData.get("_action");

  // Clear the storefront metafields for the given products so their custom
  // fields stop showing on the storefront after deletion. Fire-and-forget: the
  // DB delete must succeed even if the Admin API call fails.
  const clearMetafields = (productIds) =>
    Promise.all(
      productIds.map((id) =>
        clearAccordionMetafield(admin, id).catch((err) =>
          console.error(`[CustomVogue] clear metafield failed for ${id}:`, err.message)
        )
      )
    );

  if (_action === "delete") {
    const productId = formData.get("productId");
    await connection;
    await ProductField.deleteMany({ shop: session.shop, productId });
    await clearMetafields([productId]);
    return { deleted: productId };
  }

  if (_action === "deleteAll") {
    await connection;
    const productIds = await ProductField.distinct("productId", { shop: session.shop });
    await ProductField.deleteMany({ shop: session.shop });
    await clearMetafields(productIds);
    return { deletedAll: true };
  }

  if (_action === "deleteSelected") {
    const ids = JSON.parse(formData.get("productIds") ?? "[]");
    await connection;
    await ProductField.deleteMany({ shop: session.shop, productId: { $in: ids } });
    await clearMetafields(ids);
    return { deletedSelected: ids };
  }

  const productId = formData.get("productId");
  const productTitle = formData.get("productTitle") ?? "";
  const handle = formData.get("handle") ?? "";
  if (productId) {
    const plan = await getCurrentPlan(billing, session.shop);
    if (plan !== PLANS.GROWTH) {
      await connection;
      const isExisting = await ProductField.exists({ shop: session.shop, productId });
      if (!isExisting) {
        const existingProducts = await getExistingProducts(session.shop);
        if (existingProducts.length >= FREE_PLAN_LIMITS.maxProducts) {
          return {
            error: `Free plan supports up to ${FREE_PLAN_LIMITS.maxProducts} products. Upgrade to Growth for unlimited.`,
          };
        }
      }
    }
    return redirect(
      `/app/products/${encodeURIComponent(productId)}?productTitle=${encodeURIComponent(productTitle)}&handle=${encodeURIComponent(handle)}`
    );
  }
  return null;
};

const TABS = ["App Settings", "How to use", "Contact Us"];

const LANG_NAMES = {
  en: "English", fr: "Français", de: "Deutsch", es: "Español",
  it: "Italiano", pt: "Português", nl: "Nederlands",
  ja: "日本語", zh: "中文", ar: "العربية",
};

const HOW_TO_STEPS = [
  { num: "01", text: "Open App And Select Product To Add Custom Fields From App Settings Tab." },
  { num: "02", text: "Select One Or More Products That You Want To Edit Custom Fields And Click Select." },
  { num: "03", text: "The Selected Products Appear In A List. Click 'Edit Fields' On Any Product To Open Its Editor." },
  { num: "04", text: "In The Editor You Can Set A Display Style (Accordion Or Tabs) And Edit Each Field's Title And Description." },
  { num: "05", text: "Use The Add More Fields Button To Add Fields And The Close Button To Remove Them." },
  { num: "06", text: "Click Submit To Save. Open Your Storefront To Preview The Custom Fields On The Product Page." },
];

const QUICK_ACTIONS = [
  {
    to: "/app/bulk-apply",
    label: "Bulk Apply",
    desc: "Copy fields to multiple products",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
    free: false,
    color: "#2563eb",
  },
  {
    to: "/app/export",
    label: "CSV Export",
    desc: "Download all fields as CSV",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
      </svg>
    ),
    free: false,
    color: "#0891b2",
  },
  {
    to: "/app/import",
    label: "CSV Import",
    desc: "Upload fields from CSV file",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    ),
    free: false,
    color: "#7c3aed",
  },
  {
    to: "/app/custom-css",
    label: "Custom CSS",
    desc: "Inject styles without theme editor",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
      </svg>
    ),
    free: false,
    color: "#059669",
  },
  {
    to: "/app/analytics",
    label: "Analytics",
    desc: "Track field usage & interactions",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
    free: false,
    color: "#d97706",
  },
];

export default function Index() {
  const { existingProducts, plan, analytics } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") || "App Settings";
  const setActiveTab = (tab) => setSearchParams({ tab });
  const [copied, setCopied] = useState(false);
  const [sessionProducts, setSessionProducts] = useState(() => {
    try {
      const saved = sessionStorage.getItem("cv_selected_products");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [emailError, setEmailError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const fetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const deleteAllFetcher = useFetcher();
  const contactFetcher = useFetcher();
  const [productSearch, setProductSearch] = useState("");
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const deleteSelectedFetcher = useFetcher();
  const shopify = useAppBridge();
  const [pickerOpening, setPickerOpening] = useState(false);

  // Safety net: if any of these fetchers never settle back to "idle" (dropped
  // network, an action throwing a non-Response error), the buttons they
  // disable would otherwise stay stuck forever.
  const fetcherBusy = useBusyTimeout(fetcher.state !== "idle");
  const deleteFetcherBusy = useBusyTimeout(deleteFetcher.state !== "idle");
  const deleteAllFetcherBusy = useBusyTimeout(deleteAllFetcher.state !== "idle");
  const deleteSelectedFetcherBusy = useBusyTimeout(deleteSelectedFetcher.state !== "idle");
  const contactFetcherBusy = useBusyTimeout(contactFetcher.state === "submitting");

  const isGrowth = plan === PLANS.GROWTH;
  const atProductLimit = !isGrowth && existingProducts.length >= FREE_PLAN_LIMITS.maxProducts;

  const existingIds = new Set(existingProducts.map((p) => p.id));
  const allProducts = [
    ...existingProducts,
    ...sessionProducts.filter((p) => !existingIds.has(p.id)),
  ];
  const filteredProducts = productSearch.trim()
    ? allProducts.filter((p) => p.title.toLowerCase().includes(productSearch.toLowerCase()))
    : allProducts;

  const handleSelectProduct = async () => {
    if (atProductLimit || pickerOpening) return;
    // Disable the button just long enough to prevent double-clicks while
    // resourcePicker() is being invoked; the native picker modal owns its
    // own loading UI once open, so we don't show a competing indicator.
    setPickerOpening(true);
    try {
      const selection = await shopify.resourcePicker({
        type: "product",
        action: "add",
        multiple: true,
        filter: { variants: false },
        selectionIds: existingProducts.map((p) => ({ id: p.id })),
      });
      if (!selection) return;
      const existingIdSet = new Set(existingProducts.map((p) => p.id));
      const picked = selection
        .filter((p) => !existingIdSet.has(p.id))
        // Capture `handle` from the picker so we can build a storefront URL
        // later without needing an Admin API call.
        .map((p) => ({ id: p.id, title: p.title, handle: p.handle ?? "" }));
      setSessionProducts(picked);
      try { sessionStorage.setItem("cv_selected_products", JSON.stringify(picked)); } catch { }
    } catch (e) {
      console.error("[CustomVogue] resourcePicker error:", e?.message ?? String(e));
    } finally {
      setPickerOpening(false);
    }
  };

  const handleEditProduct = (product) => {
    setEditingId(product.id);
    fetcher.submit({ _action: "edit", productId: product.id, productTitle: product.title, handle: product.handle ?? "" }, { method: "post" });
  };

  const handleDeleteConfirm = (product) => {
    deleteFetcher.submit(
      { _action: "delete", productId: product.id },
      { method: "post" }
    );
    setPendingDeleteId(null);
  };

  useEffect(() => {
    if (deleteFetcher.data?.deleted) {
      const deletedId = deleteFetcher.data.deleted;
      setSessionProducts((prev) => {
        const updated = prev.filter((p) => p.id !== deletedId);
        try { sessionStorage.setItem("cv_selected_products", JSON.stringify(updated)); } catch { }
        return updated;
      });
      shopify.toast.show("Product removed from list.", { duration: 3000 });
    }
  }, [deleteFetcher.data]);

  useEffect(() => {
    if (deleteAllFetcher.data?.deletedAll) {
      setSessionProducts([]);
      try { sessionStorage.removeItem("cv_selected_products"); } catch { }
      setConfirmDeleteAll(false);
      shopify.toast.show("All custom fields deleted.", { duration: 3000 });
    }
  }, [deleteAllFetcher.data]);

  useEffect(() => {
    if (deleteSelectedFetcher.data?.deletedSelected) {
      const ids = deleteSelectedFetcher.data.deletedSelected;
      setSessionProducts((prev) => {
        const updated = prev.filter((p) => !ids.includes(p.id));
        try { sessionStorage.setItem("cv_selected_products", JSON.stringify(updated)); } catch { }
        return updated;
      });
      setSelectedIds(new Set());
      shopify.toast.show(`${ids.length} product${ids.length !== 1 ? "s" : ""} removed.`, { duration: 3000 });
    }
  }, [deleteSelectedFetcher.data]);

  const handleCopy = () => {
    navigator.clipboard.writeText('<div class="customfields"></div>');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const EMAIL_REGEX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9\-]+(\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,}$/;

  const validateEmail = (val) => {
    const v = val.trim();
    if (!v) return "Email is required.";
    if (!v.includes("@")) return "Email must contain @.";
    const [local, ...domainParts] = v.split("@");
    const domain = domainParts.join("@");
    if (!local) return "Enter the part before @.";
    if (!domain || !domain.includes(".")) return "Enter a valid domain (e.g. name@example.com).";
    if (!EMAIL_REGEX.test(v)) return "Please enter a valid email address (e.g. name@example.com).";
    return "";
  };

  const handleEmailChange = (e) => setEmailError(validateEmail(e.target.value));
  const handleEmailBlur = (e) => setEmailError(validateEmail(e.target.value));

  const handleContactSubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const err = validateEmail(fd.get("email") ?? "");
    if (err) { setEmailError(err); return; }
    setEmailError("");
    contactFetcher.submit(fd, { method: "post", action: "/app/contact" });
  };

  const contactSuccess = contactFetcher.data?.success;
  const contactError = contactFetcher.data?.error;
  const contactSubmitting = contactFetcherBusy;

  const limitError =
    fetcher.data?.error ||
    (searchParams.get("limitReached") === "1"
      ? `Free plan supports up to ${FREE_PLAN_LIMITS.maxProducts} products. Upgrade to Growth for unlimited.`
      : null);

  useEffect(() => {
    if (!contactFetcher.data) return;
    if (contactFetcher.data.emailSent) {
      shopify.toast.show("Message sent! We'll get back to you soon.", { duration: 4000 });
    } else if (contactFetcher.data.success && !contactFetcher.data.emailSent) {
      shopify.toast.show("Message saved. (Email delivery failed — we'll still review it.)", { duration: 5000, isError: true });
    }
  }, [contactFetcher.data]);

  return (
    <>
      <div style={s.page}>
        <style>{`
        @keyframes cv-spin { to { transform: rotate(360deg); } }
        .cv-product-checkbox:focus { outline: none; }
        .cv-product-checkbox:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; border-radius: 3px; }
      `}</style>

        {/* ── Plan bar ── */}
        <div style={{ ...s.planBar, ...(isGrowth ? s.planBarGrowth : {}) }}>
          <div style={s.planBarLeft}>
            <span style={{ ...s.planBadge, ...(isGrowth ? s.planBadgeGrowth : s.planBadgeFree) }}>
              {isGrowth ? "✓ Growth Plan" : "Free Plan"}
            </span>
            {!isGrowth && (
              <span style={s.planLimit}>
                {existingProducts.length} / {FREE_PLAN_LIMITS.maxProducts} products used
              </span>
            )}
          </div>
          <Link to={`/app/billing?tab=${encodeURIComponent(activeTab)}`} style={{ ...s.planBarLink, ...(isGrowth ? s.planBarLinkGrowth : {}) }}>
            {isGrowth ? "Manage subscription" : "Upgrade to Growth →"}
          </Link>
        </div>

        {/* ── Product limit warning ── */}
        {atProductLimit && (
          <div style={s.limitBanner}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span><strong>Product limit reached.</strong> Free plan supports up to {FREE_PLAN_LIMITS.maxProducts} products. <Link to={`/app/billing?tab=${encodeURIComponent(activeTab)}`} style={s.limitLink}>Upgrade to Growth</Link> for unlimited.</span>
          </div>
        )}

        {/* ── Server-side product limit error (action block or direct-URL bypass attempt) ── */}
        {limitError && !atProductLimit && (
          <div style={s.errorBanner}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{limitError} <Link to={`/app/billing?tab=${encodeURIComponent(activeTab)}`} style={s.limitLink}>Upgrade to Growth</Link></span>
          </div>
        )}

        {/* ── Tab bar ── */}
        <div style={s.tabBar}>
          {TABS.map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{ ...s.tabBtn, ...(activeTab === tab ? s.tabBtnActive : {}) }}>
              {tab}
            </button>
          ))}
        </div>

        {/* ══════════ APP SETTINGS ══════════ */}
        {activeTab === "App Settings" && (
          <div style={s.tabContent}>

            {/* Stats strip */}
            {(() => {
              const totalFields = existingProducts.reduce((acc, p) => acc + (p.fieldCount ?? 0), 0);
              const stats = [
                { num: existingProducts.length, lbl: "Products with Custom Fields" },
                { num: totalFields, lbl: "Total Fields" },
                { num: existingProducts.length > 0 ? Math.round((totalFields / existingProducts.length) * 10) / 10 : 0, lbl: "Avg Fields / Product" },
                ...(isGrowth ? [{ num: analytics?.fieldsThisMonth ?? 0, lbl: "Added This Month" }] : []),
              ];
              return (
                <div style={s.statsGrid}>
                  {stats.map((st, i) => (
                    <div key={i} style={s.statCard}>
                      <div style={s.statNum}>{st.num}</div>
                      <div style={s.statLbl}>{st.lbl}</div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Hero banner */}
            <div style={s.hero}>
              <div style={s.heroIcon}>
                <img src="/logo.png" alt="MetaVogue" width="40" height="40" style={s.heroLogo} />
              </div>
              <div>
                <h1 style={s.heroTitle}>Add Product Custom Fields</h1>
                <p style={s.heroDesc}>
                  Select a product below to add rich accordion or tab fields to its storefront page.{" "}
                  <button onClick={() => setActiveTab("How to use")} style={s.heroLink}>How to use →</button>
                </p>
              </div>
            </div>

            {/* Quick actions */}
            <div style={s.featureGrid}>
              {QUICK_ACTIONS.map((action) => {
                const locked = !action.free && !isGrowth;
                const inner = (
                  <div style={{ ...s.featureCard, ...(locked ? s.featureCardLocked : {}), borderTopColor: action.color }}>
                    <div style={{ ...s.featureIconWrap, background: action.color + "18", color: action.color }}>
                      {action.icon}
                    </div>
                    <div style={s.featureLabel}>{action.label}{locked ? " 🔒" : ""}</div>
                    <div style={s.featureDesc}>{action.desc}</div>
                  </div>
                );
                return locked ? (
                  <div key={action.label} title="Growth plan required" style={{ cursor: "not-allowed", display: "flex", height: "100%" }}>{inner}</div>
                ) : (
                  <Link key={action.label} to={action.to} style={{ textDecoration: "none", display: "flex", height: "100%" }}>{inner}</Link>
                );
              })}
            </div>

            {/* Select products card */}
            <div style={s.card}>
              <div style={s.cardTitleRow}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                </svg>
                <span style={s.cardTitle}>Select Products</span>
              </div>
              <p style={s.cardDesc}>Open the Shopify product picker to choose which products to add custom fields to.</p>
              <div style={s.selectBtnRow}>
                {atProductLimit ? (
                  <button style={{ ...s.selectBtn, ...s.selectBtnDisabled }} disabled>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    Limit Reached — Upgrade to Add More
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSelectProduct}
                    disabled={pickerOpening}
                    style={{ ...s.selectBtn, ...(pickerOpening ? s.selectBtnDisabled : {}) }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    Select Products
                  </button>
                )}
              </div>
            </div>

            {/* Product list */}
            {allProducts.length > 0 && (
              <div style={s.card}>
                {/* Title row */}
                <div style={s.cardTitleRow}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                    <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                  </svg>
                  <span style={s.cardTitle}>Your Products</span>
                  <span style={s.productCount}>{allProducts.length} product{allProducts.length !== 1 ? "s" : ""}</span>
                </div>

                {/* Search + bulk-action controls */}
                <div style={s.productControls}>
                  <div style={s.searchWrap}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      type="text"
                      placeholder="Search products…"
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      style={s.searchInput}
                    />
                    {productSearch && (
                      <button onClick={() => setProductSearch("")} style={s.searchClear} title="Clear">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    )}
                  </div>

                  {selectedIds.size > 0 ? (
                    <button
                      style={s.deleteAllBtn}
                      onClick={() => deleteSelectedFetcher.submit(
                        { _action: "deleteSelected", productIds: JSON.stringify([...selectedIds]) },
                        { method: "post" }
                      )}
                      disabled={deleteSelectedFetcherBusy}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6M14 11v6" />
                        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                      </svg>
                      Delete Selected ({selectedIds.size})
                    </button>
                  ) : (
                    confirmDeleteAll ? (
                      <div style={s.deleteAllConfirm}>
                        <span style={{ fontSize: 12, color: "#374151", whiteSpace: "nowrap" }}>Delete all fields?</span>
                        <button
                          style={s.deleteAllConfirmBtn}
                          onClick={() => deleteAllFetcher.submit({ _action: "deleteAll" }, { method: "post" })}
                          disabled={deleteAllFetcherBusy}
                        >
                          Yes, Delete All
                        </button>
                        <button style={s.deleteAllCancelBtn} onClick={() => setConfirmDeleteAll(false)}>Cancel</button>
                      </div>
                    ) : (
                      <button style={s.deleteAllBtn} onClick={() => setConfirmDeleteAll(true)}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6M14 11v6" />
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                        </svg>
                        Delete All
                      </button>
                    )
                  )}
                </div>
                <div style={s.productList}>
                  {filteredProducts.length === 0 && productSearch && (
                    <div style={{ padding: "16px 0", textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
                      No products match &ldquo;{productSearch}&rdquo;
                    </div>
                  )}
                  {filteredProducts.map((product) => {
                    const isEditing = editingId === product.id && fetcherBusy;
                    const isDeleting = deleteFetcherBusy && pendingDeleteId === null && deleteFetcher.formData?.get("productId") === product.id;
                    const confirmingDelete = pendingDeleteId === product.id;

                    const isChecked = selectedIds.has(product.id);
                    return (
                      <div key={product.id} style={{ ...s.productRow, ...(isChecked ? s.productRowChecked : {}) }}>
                        <input
                          type="checkbox"
                          className="cv-product-checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            setSelectedIds((prev) => {
                              const next = new Set(prev);
                              e.target.checked ? next.add(product.id) : next.delete(product.id);
                              return next;
                            });
                          }}
                          style={s.productCheckbox}
                        />
                        <div style={s.productInfo}>
                          <span style={s.productTitle}>{product.title}</span>
                          {product.fieldCount != null && (
                            <span style={s.fieldBadge}>
                              {product.fieldCount} {product.fieldCount === 1 ? "field" : "fields"}
                            </span>
                          )}
                        </div>

                        <div style={s.rowActions}>
                          {confirmingDelete ? (
                            <>
                              <span style={s.confirmMsg}>Remove all fields?</span>
                              <button
                                style={s.confirmDeleteBtn}
                                onClick={() => handleDeleteConfirm(product)}
                                disabled={isDeleting}
                              >
                                Yes, Remove
                              </button>
                              <button style={s.cancelBtn} onClick={() => setPendingDeleteId(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                style={s.editBtn}
                                onClick={() => handleEditProduct(product)}
                                disabled={isEditing}
                              >
                                {isEditing ? (
                                  <span style={s.spinner} />
                                ) : (
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                  </svg>
                                )}
                                Edit Fields
                              </button>
                              <button
                                style={s.deleteBtn}
                                onClick={() => setPendingDeleteId(product.id)}
                                title="Remove product & delete its fields"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="3 6 5 6 21 6" />
                                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                  <path d="M10 11v6M14 11v6" />
                                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                                </svg>
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Analytics section */}
            <div style={aS.section}>
              <div style={aS.sectionHeader}>
                <div style={aS.sectionTitleRow}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                  <h2 style={aS.sectionTitle}>Analytics</h2>
                </div>
                {isGrowth && (
                  <Link to="/app/analytics" style={aS.fullLink}>View full dashboard →</Link>
                )}
              </div>

              {isGrowth && analytics ? (
                <>
                  <div style={aS.kpiRow}>
                    {[
                      { val: analytics.totalProducts, lbl: "Products with custom fields" },
                      { val: analytics.totalFields, lbl: "Total custom fields" },
                      { val: analytics.avgFieldsPerProduct, lbl: "Avg. fields / product" },
                      { val: analytics.totalClicks, lbl: "Shopper interactions" },
                    ].map((k, i) => (
                      <div key={i} style={aS.kpiCard}>
                        <div style={aS.kpiValue}>{k.val}</div>
                        <div style={aS.kpiLabel}>{k.lbl}</div>
                      </div>
                    ))}
                  </div>

                  <div style={aS.chartsRow}>
                    {analytics.top10.length > 0 && (
                      <div style={{ ...aS.card, flex: 2 }}>
                        <div style={aS.cardTitle}>Top products by field count</div>
                        <div style={aS.barList}>
                          {analytics.top10.map((p) => {
                            const maxCount = analytics.top10[0].count || 1;
                            return (
                              <div key={p.id} style={aS.barRow}>
                                <div style={aS.barLabel} title={p.title}>{p.title}</div>
                                <div style={aS.barTrack}>
                                  <div style={{ ...aS.barFill, width: `${Math.round((p.count / maxCount) * 100)}%` }} />
                                </div>
                                <div style={aS.barCount}>{p.count}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
                      <div style={aS.card}>
                        <div style={aS.cardTitle}>Display style</div>
                        <div style={aS.styleRow}>
                          <div style={aS.styleItem}>
                            <div style={aS.styleCount}>{analytics.displayStyles.accordion ?? 0}</div>
                            <div style={aS.styleLabel}>Accordion</div>
                          </div>
                          <div style={aS.styleDivider} />
                          <div style={aS.styleItem}>
                            <div style={aS.styleCount}>{analytics.displayStyles.tabs ?? 0}</div>
                            <div style={aS.styleLabel}>Tabs</div>
                          </div>
                        </div>
                      </div>

                      <div style={aS.card}>
                        <div style={aS.cardTitle}>Fields per product</div>
                        <div style={aS.distGrid}>
                          {Object.entries(analytics.fieldDistribution).map(([label, count]) => (
                            <div key={label} style={aS.distItem}>
                              <div style={aS.distCount}>{count}</div>
                              <div style={aS.distLabel}>{label} field{label !== "1" ? "s" : ""}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Most expanded */}
                  <div style={{ ...aS.card, marginTop: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <div style={aS.cardTitle}>Most expanded fields</div>
                    </div>
                    {analytics.topClicked.length === 0 ? (
                      <div style={aS.emptyClicks}>
                        No shopper interactions yet — data appears after visitors expand fields on the storefront.
                      </div>
                    ) : (
                      <div style={aS.barList}>
                        {analytics.topClicked.slice(0, 5).map((item) => {
                          const maxC = analytics.topClicked[0].count;
                          return (
                            <div key={item.fieldId} style={aS.barRow}>
                              <div style={aS.barLabel} title={item.fieldTitle || item.fieldId}>
                                {item.fieldTitle || item.fieldId}
                              </div>
                              <div style={aS.barTrack}>
                                <div style={{ ...aS.barFill, width: `${Math.round((item.count / maxC) * 100)}%`, background: "#7c3aed" }} />
                              </div>
                              <div style={aS.barCount}>{item.count}</div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div style={aS.gateBox}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 10 }}>
                    <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                  <div style={aS.gateText}>
                    Unlock Analytics on the Growth plan — track top products, field usage, and which fields shoppers expand most.
                  </div>
                  <Link to="/app/billing" style={aS.gateBtn}>View Plans &amp; Upgrade →</Link>
                </div>
              )}
            </div>

            {/* HTML snippet */}
            <div style={s.card}>
              <div style={s.cardTitleRow}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
                </svg>
                <span style={s.cardTitle}>Manual HTML Snippet</span>
              </div>
              <p style={s.cardDesc}>Copy this code and paste it into your product template where you want the custom fields to appear.</p>
              <div style={s.snippetRow}>
                <input readOnly value='<div class="customfields"></div>' style={s.snippetInput} />
                <button style={s.copyBtn} onClick={handleCopy}>
                  {copied ? (
                    <>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      Copy
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══════════ HOW TO USE ══════════ */}
        {activeTab === "How to use" && (
          <div style={s.tabContent}>
            <div style={s.howToHero}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div>
                <h2 style={s.howToHeroTitle}>How to Use CustomVogue</h2>
                <p style={s.howToHeroDesc}>Follow these 6 steps to add custom fields to your products</p>
              </div>
            </div>
            <div style={s.stepsGrid}>
              {HOW_TO_STEPS.map((step, i) => (
                <div key={step.num} style={s.stepCard}>
                  <div style={{ ...s.stepNumBadge, background: i < 3 ? "#2563eb" : "#7c3aed" }}>{step.num}</div>
                  <p style={s.stepText}>{step.text}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══════════ CONTACT US ══════════ */}
        {activeTab === "Contact Us" && (
          <div style={s.tabContent}>
            <div style={s.howToHero}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <div>
                <h2 style={s.howToHeroTitle}>Contact Support</h2>
                <p style={s.howToHeroDesc}>{isGrowth ? "Growth plan — Priority support, typically within 4 hours." : "Free plan — Email support via this form."}</p>
              </div>
            </div>

            <div style={s.card}>
              {contactSuccess ? (
                <div style={s.successBanner}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  Your query has been submitted. We'll get back to you soon.
                </div>
              ) : (
                <form onSubmit={handleContactSubmit}>
                  {contactError && <div style={s.errorBanner}>{contactError}</div>}
                  <div style={s.formRow}>
                    <div style={s.formGroup}>
                      <label style={s.formLabel}>Name *</label>
                      <input name="name" required placeholder="Your name" style={s.formInput} />
                    </div>
                    <div style={s.formGroup}>
                      <label style={s.formLabel}>Email *</label>
                      <input
                        name="email"
                        type="email"
                        placeholder="your@email.com"
                        onBlur={handleEmailBlur}
                        onChange={handleEmailChange}
                        style={{ ...s.formInput, ...(emailError ? s.formInputError : {}) }}
                      />
                      {emailError && <span style={s.fieldError}>{emailError}</span>}
                    </div>
                  </div>
                  <div style={s.formGroup}>
                    <label style={s.formLabel}>Subject *</label>
                    <input name="subject" required placeholder="What is your query about?" style={s.formInput} />
                  </div>
                  <div style={s.formGroup}>
                    <label style={s.formLabel}>Message *</label>
                    <textarea name="message" required rows={5} placeholder="Describe your question or issue…" style={s.formTextarea} />
                  </div>
                  {isGrowth && (
                    <div style={s.priorityNote}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                      Growth plan — Priority support. We typically respond within 4 hours.
                    </div>
                  )}
                  <button type="submit" style={s.submitBtn} disabled={contactSubmitting}>
                    {contactSubmitting ? "Sending…" : "Send Message"}
                  </button>
                </form>
              )}
            </div>

            {isGrowth && (
              <div style={s.bookingCard}>
                <div style={s.bookingLeft}>
                  <div style={s.bookingIconWrap}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                      <line x1="16" y1="2" x2="16" y2="6" />
                      <line x1="8" y1="2" x2="8" y2="6" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                  </div>
                  <div>
                    <div style={s.bookingTitle}>Schedule an Onboarding Call</div>
                    <div style={s.bookingDesc}>Get a 1-on-1 setup session with our team — exclusively for Growth plan members.</div>
                  </div>
                </div>
                <a
                  href="https://calendly.com/nisarg-patel-xillentech/30min"
                  target="_top"
                  rel="noreferrer noopener"
                  style={s.bookingBtn}
                >
                  Book a Call
                </a>
              </div>
            )}

            <div style={{ ...s.card, marginTop: 0 }}>
              <div style={s.contactInfoRow}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" />
                </svg>
                <span style={s.contactInfoLabel}>Email:</span>
                <a href="mailto:nisarg.patel@xillentech.com" target="_top" rel="noreferrer noopener" style={s.contactLink}>
                  nisarg.patel@xillentech.com
                </a>
              </div>
              <div style={{ ...s.contactInfoRow, marginBottom: 0 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
                <span style={s.contactInfoLabel}>Developer:</span>
                <span style={s.contactInfoValue}>Xillentech</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const s = {
  page: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    maxWidth: "86%",
    margin: "0 auto",
    padding: "24px 32px 48px",
  },

  /* Plan bar */
  planBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    padding: "12px 20px",
    marginBottom: 16,
  },
  planBarGrowth: {
    background: "linear-gradient(135deg, #eff6ff 0%, #f0fdf4 100%)",
    borderColor: "#bfdbfe",
  },
  planBarLeft: { display: "flex", alignItems: "center", gap: 12 },
  planBadge: { fontSize: 13, fontWeight: 700, padding: "4px 12px", borderRadius: 20, letterSpacing: "0.02em" },
  planBadgeFree: { background: "#e5e7eb", color: "#374151" },
  planBadgeGrowth: { background: "linear-gradient(135deg, #dbeafe, #d1fae5)", color: "#1d4ed8" },
  planLimit: { fontSize: 14, color: "#6b7280" },
  planBarLink: { fontSize: 14, color: "#2563eb", textDecoration: "none", fontWeight: 600 },
  planBarLinkGrowth: { color: "#059669" },

  /* Limit banner */
  limitBanner: {
    display: "flex", alignItems: "flex-start", gap: 10,
    background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8,
    padding: "12px 16px", fontSize: 14, color: "#92400e", marginBottom: 16, lineHeight: 1.5,
  },
  limitLink: { color: "#2563eb", fontWeight: 600 },

  /* Tabs */
  tabBar: {
    display: "flex",
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: 4,
    gap: 4,
    marginBottom: 24,
  },
  tabBtn: {
    flex: 1,
    padding: "10px 20px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: 15,
    fontWeight: 500,
    color: "#6b7280",
    borderRadius: 8,
    transition: "all 0.15s",
  },
  tabBtnActive: {
    background: "#fff",
    color: "#111827",
    fontWeight: 600,
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
  },
  tabContent: { paddingTop: 4 },

  /* Stats grid */
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(0, 1fr))",
    gap: 12,
    marginBottom: 20,
  },
  statCard: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "18px 16px",
    textAlign: "center",
    boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
  },
  statNum: { fontSize: 32, fontWeight: 800, color: "#111827", lineHeight: 1, marginBottom: 6 },
  statLbl: { fontSize: 13, color: "#6b7280", fontWeight: 500 },

  /* Hero banner */
  hero: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    background: "linear-gradient(135deg, #1d4ed8 0%, #2563eb 55%, #3b82f6 100%)",
    borderRadius: 14,
    padding: "20px 24px",
    marginBottom: 20,
    boxShadow: "0 4px 20px rgba(37,99,235,0.25)",
  },
  heroIcon: {
    width: 52, height: 52,
    background: "rgba(255,255,255,0.15)",
    borderRadius: 12,
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
    border: "1px solid rgba(255,255,255,0.2)",
  },
  heroLogo: { display: "block", borderRadius: 10 },
  heroTitle: { fontSize: 20, fontWeight: 700, color: "#fff", margin: "0 0 4px" },
  heroDesc: { fontSize: 14, color: "rgba(255,255,255,0.8)", margin: 0 },
  heroLink: {
    background: "none", border: "none", color: "#fff", cursor: "pointer",
    fontSize: 14, textDecoration: "underline", padding: 0, fontWeight: 600,
  },

  /* Feature grid (quick actions) */
  featureGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: 12,
    marginBottom: 20,
  },
  featureCard: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderTop: "3px solid #2563eb",
    borderRadius: 10,
    padding: "16px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    flex: 1,
    boxSizing: "border-box",
    boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
    transition: "transform 0.15s, box-shadow 0.15s",
  },
  featureCardLocked: {
    opacity: 0.5,
    background: "#f9fafb",
  },
  featureIconWrap: {
    width: 38, height: 38,
    borderRadius: 8,
    display: "flex", alignItems: "center", justifyContent: "center",
    marginBottom: 2,
  },
  featureLabel: { fontSize: 14, fontWeight: 700, color: "#111827" },
  featureDesc: { fontSize: 12, color: "#6b7280", lineHeight: 1.4 },

  /* Cards */
  card: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "22px 24px",
    marginBottom: 16,
    boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
  },
  cardTitleRow: {
    display: "flex", alignItems: "center", gap: 8, marginBottom: 12,
  },
  cardTitle: { fontSize: 16, fontWeight: 700, color: "#111827", flex: 1 },
  cardDesc: { fontSize: 14, color: "#6b7280", marginBottom: 14, lineHeight: 1.6 },
  productCount: {
    fontSize: 12, fontWeight: 600, color: "#6b7280",
    background: "#f3f4f6", borderRadius: 20, padding: "2px 10px",
  },

  /* Select button */
  selectBtnRow: {
    display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
  },
  selectBtn: {
    display: "inline-flex", alignItems: "center", gap: 8,
    background: "linear-gradient(135deg, #1d4ed8, #2563eb)",
    color: "#fff", border: "none", borderRadius: 8,
    padding: "11px 24px", fontSize: 15, cursor: "pointer", fontWeight: 600,
    boxShadow: "0 3px 10px rgba(37,99,235,0.3)",
  },
  selectBtnDisabled: { background: "#9ca3af", cursor: "not-allowed", boxShadow: "none", border: "none", color: "#fff" },

  /* Product list */
  productList: { display: "flex", flexDirection: "column", gap: 8 },
  productRow: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "12px 16px", border: "none", borderRadius: 8,
    background: "#f9fafb", transition: "background 0.15s",
  },
  productRowChecked: {
    background: "#eff6ff",
  },
  productCheckbox: {
    width: 16, height: 16, cursor: "pointer", accentColor: "#2563eb", flexShrink: 0,
    outline: "none",
  },
  productInfo: { display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 },
  productTitle: {
    fontSize: 15, color: "#111827", fontWeight: 500,
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  },
  fieldBadge: {
    background: "#dbeafe", color: "#1d4ed8",
    fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 20, whiteSpace: "nowrap",
  },
  rowActions: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
  editBtn: {
    display: "inline-flex", alignItems: "center", gap: 6,
    background: "linear-gradient(135deg, #1d4ed8, #2563eb)",
    color: "#fff", border: "none", borderRadius: 7,
    padding: "7px 16px", fontSize: 13, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap",
    boxShadow: "0 2px 6px rgba(37,99,235,0.3)",
  },
  editBtnLoading: {
    background: "#6b7280", cursor: "not-allowed", boxShadow: "none",
  },
  spinner: {
    display: "inline-block", width: 12, height: 12,
    border: "2px solid rgba(255,255,255,0.3)",
    borderTopColor: "#fff", borderRadius: "50%",
    animation: "cv-spin 0.7s linear infinite",
  },
  deleteBtn: {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 32, height: 32, border: "1px solid #fca5a5", borderRadius: 7,
    background: "#fff5f5", color: "#dc2626", cursor: "pointer", flexShrink: 0,
  },
  confirmMsg: { fontSize: 13, color: "#dc2626", fontWeight: 500, whiteSpace: "nowrap" },
  confirmDeleteBtn: {
    display: "inline-flex", alignItems: "center", gap: 5,
    background: "#dc2626", color: "#fff", border: "none", borderRadius: 7,
    padding: "7px 14px", fontSize: 13, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap",
  },
  cancelBtn: {
    display: "inline-flex", alignItems: "center",
    background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb", borderRadius: 7,
    padding: "7px 14px", fontSize: 13, cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap",
  },

  /* Product controls (search + delete all) */
  productControls: {
    display: "flex", alignItems: "center", gap: 10,
    marginBottom: 14, flexWrap: "wrap",
  },
  searchWrap: {
    display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 160,
    border: "1px solid #e5e7eb", borderRadius: 8, padding: "6px 10px",
    background: "#f9fafb",
  },
  searchInput: {
    flex: 1, border: "none", outline: "none", background: "transparent",
    fontSize: 13, color: "#111827",
  },
  searchClear: {
    display: "flex", alignItems: "center", justifyContent: "center",
    border: "none", background: "transparent", cursor: "pointer",
    color: "#9ca3af", padding: 0,
  },
  deleteAllBtn: {
    display: "inline-flex", alignItems: "center", gap: 6,
    background: "#fff5f5", color: "#dc2626", border: "1px solid #fca5a5",
    borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600,
    cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
  },
  deleteAllConfirm: {
    display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0,
    background: "#fff5f5", border: "1px solid #fca5a5", borderRadius: 8,
    padding: "6px 12px",
  },
  deleteAllConfirmBtn: {
    display: "inline-flex", alignItems: "center", gap: 5,
    background: "#dc2626", color: "#fff", border: "none", borderRadius: 6,
    padding: "5px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap",
  },
  deleteAllCancelBtn: {
    display: "inline-flex", alignItems: "center",
    background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb", borderRadius: 6,
    padding: "5px 12px", fontSize: 12, cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap",
  },

  /* Snippet */
  snippetRow: { display: "flex", gap: 8, alignItems: "center" },
  snippetInput: {
    flex: 1, border: "1px solid #d1d5db", borderRadius: 6,
    padding: "9px 12px", fontSize: 14, color: "#374151",
    background: "#f9fafb", fontFamily: "monospace",
  },
  copyBtn: {
    display: "inline-flex", alignItems: "center", gap: 6,
    background: "#111827", color: "#fff", border: "none", borderRadius: 7,
    padding: "9px 18px", fontSize: 14, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap",
  },

  /* How to use */
  howToHero: {
    display: "flex", alignItems: "center", gap: 14,
    background: "linear-gradient(135deg, #1d4ed8, #2563eb)",
    borderRadius: 12, padding: "18px 22px", marginBottom: 20,
    boxShadow: "0 4px 16px rgba(37,99,235,0.25)",
  },
  howToHeroTitle: { fontSize: 20, fontWeight: 700, color: "#fff", margin: "0 0 3px" },
  howToHeroDesc: { fontSize: 14, color: "rgba(255,255,255,0.8)", margin: 0 },
  stepsGrid: {
    display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14,
  },
  stepCard: {
    background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
    padding: "20px 18px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
    display: "flex", flexDirection: "column", gap: 12,
  },
  stepNumBadge: {
    width: 36, height: 36, borderRadius: 10,
    color: "#fff", fontSize: 14, fontWeight: 800,
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0, alignSelf: "flex-start",
  },
  stepText: { fontSize: 14, color: "#374151", margin: 0, lineHeight: 1.6 },

  /* Contact */
  formRow: { display: "flex", gap: 16, marginBottom: 14 },
  formGroup: { flex: 1, marginBottom: 14 },
  formLabel: { display: "block", fontSize: 14, fontWeight: 600, color: "#374151", marginBottom: 6 },
  formInput: {
    width: "100%", border: "1px solid #d1d5db", borderRadius: 7,
    padding: "10px 12px", fontSize: 15, color: "#111827", boxSizing: "border-box",
  },
  formInputError: {
    border: "1px solid #f87171", outline: "none",
    boxShadow: "0 0 0 3px rgba(239,68,68,0.15)",
  },
  fieldError: {
    display: "block", fontSize: 12, color: "#dc2626",
    marginTop: 4, fontWeight: 500,
  },
  formTextarea: {
    width: "100%", border: "1px solid #d1d5db", borderRadius: 7,
    padding: "10px 12px", fontSize: 15, color: "#111827", boxSizing: "border-box",
    resize: "vertical", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  priorityNote: {
    display: "flex", alignItems: "center", gap: 8,
    background: "#dbeafe", color: "#1e40af", borderRadius: 8,
    padding: "10px 14px", fontSize: 14, marginBottom: 16,
  },
  submitBtn: {
    display: "inline-flex", alignItems: "center", gap: 8,
    background: "linear-gradient(135deg, #1d4ed8, #2563eb)",
    color: "#fff", border: "none", borderRadius: 8,
    padding: "11px 28px", fontSize: 15, fontWeight: 600, cursor: "pointer",
    boxShadow: "0 3px 10px rgba(37,99,235,0.3)",
  },
  successBanner: {
    display: "flex", alignItems: "center", gap: 10,
    background: "#d1fae5", color: "#065f46", borderRadius: 8,
    padding: "13px 16px", fontSize: 15, fontWeight: 500,
  },
  errorBanner: {
    background: "#fee2e2", color: "#991b1b", borderRadius: 8,
    padding: "11px 14px", fontSize: 14, marginBottom: 14,
  },
  contactInfoRow: {
    display: "flex", alignItems: "center", gap: 10, marginBottom: 10,
  },
  contactInfoLabel: { fontSize: 15, fontWeight: 600, color: "#374151" },
  contactInfoValue: { fontSize: 15, color: "#6b7280" },
  contactLink: { fontSize: 15, color: "#2563eb", textDecoration: "none", fontWeight: 500 },

  /* Booking card */
  bookingCard: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: 16, flexWrap: "wrap",
    background: "linear-gradient(135deg, #eff6ff, #dbeafe)",
    border: "1px solid #bfdbfe", borderRadius: 12,
    padding: "20px 24px", marginBottom: 16,
  },
  bookingLeft: { display: "flex", alignItems: "center", gap: 16, flex: 1, minWidth: 0 },
  bookingIconWrap: {
    width: 48, height: 48, borderRadius: 12,
    background: "#fff", border: "1px solid #bfdbfe",
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  },
  bookingTitle: { fontSize: 15, fontWeight: 700, color: "#1e3a8a", marginBottom: 4 },
  bookingDesc: { fontSize: 13, color: "#3b82f6", lineHeight: 1.5 },
  bookingBtn: {
    display: "inline-flex", alignItems: "center", gap: 8,
    background: "#2563eb", color: "#fff", textDecoration: "none",
    border: "none", borderRadius: 8, padding: "10px 22px",
    fontSize: 14, fontWeight: 600, whiteSpace: "nowrap",
    boxShadow: "0 2px 8px rgba(37,99,235,0.3)",
    flexShrink: 0,
  },

};

const aS = {
  section: {
    border: "1px solid #e5e7eb", borderRadius: 12,
    padding: "22px 24px", background: "#fff", marginBottom: 16,
    boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
  },
  sectionHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18,
  },
  sectionTitleRow: { display: "flex", alignItems: "center", gap: 8 },
  sectionTitle: { fontSize: 18, fontWeight: 700, color: "#111827", margin: 0 },
  fullLink: { fontSize: 14, color: "#7c3aed", textDecoration: "none", fontWeight: 600 },
  kpiRow: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 },
  kpiCard: {
    border: "1px solid #e5e7eb", borderRadius: 10,
    padding: "14px 16px", background: "#f9fafb",
    display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center",
    textAlign: "center",
  },
  kpiValue: { fontSize: 28, fontWeight: 800, color: "#111827", lineHeight: 1, marginBottom: 4 },
  kpiLabel: { fontSize: 13, color: "#6b7280", lineHeight: 1.4 },
  chartsRow: { display: "flex", gap: 12, alignItems: "stretch", flexWrap: "wrap" },
  card: {
    border: "1px solid #e5e7eb", borderRadius: 10, padding: "16px", background: "#f9fafb",
  },
  cardTitle: { fontSize: 14, fontWeight: 700, color: "#374151", marginBottom: 12 },
  barList: { display: "flex", flexDirection: "column", gap: 9 },
  barRow: { display: "flex", alignItems: "center", gap: 8 },
  barLabel: {
    width: 140, fontSize: 13, color: "#374151",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0,
  },
  barTrack: { flex: 1, height: 10, background: "#e5e7eb", borderRadius: 5, overflow: "hidden" },
  barFill: { height: "100%", background: "#2563eb", borderRadius: 5 },
  barCount: { width: 28, textAlign: "right", fontSize: 13, fontWeight: 700, color: "#374151", flexShrink: 0 },
  styleRow: { display: "flex", alignItems: "center", justifyContent: "space-around" },
  styleItem: { flex: 1, textAlign: "center" },
  styleCount: { fontSize: 26, fontWeight: 700, color: "#111827" },
  styleLabel: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  styleDivider: { width: 1, height: 44, background: "#e5e7eb" },
  distGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  distItem: {
    background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8,
    padding: "10px 8px", textAlign: "center",
  },
  distCount: { fontSize: 20, fontWeight: 700, color: "#111827" },
  distLabel: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  clickBadge: {
    fontSize: 12, fontWeight: 600, color: "#7c3aed",
    background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 20, padding: "3px 10px",
  },
  emptyClicks: {
    fontSize: 13, color: "#9ca3af", padding: "10px 0", lineHeight: 1.6,
  },
  gateBox: {
    textAlign: "center", padding: "32px 20px",
    background: "#f9fafb", borderRadius: 10, border: "1px dashed #d1d5db",
    display: "flex", flexDirection: "column", alignItems: "center",
  },
  gateText: {
    fontSize: 14, color: "#6b7280", marginBottom: 18, maxWidth: 380, lineHeight: 1.6,
  },
  gateBtn: {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "10px 22px", background: "linear-gradient(135deg, #7c3aed, #6d28d9)",
    color: "#fff", borderRadius: 8, fontSize: 14, fontWeight: 600, textDecoration: "none",
    boxShadow: "0 3px 10px rgba(124,58,237,0.3)",
  },
};
