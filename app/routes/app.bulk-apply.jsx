import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { Link, useFetcher, useLoaderData } from "react-router";
import { useBusyTimeout } from "../hooks/useBusyTimeout";
import { authenticate } from "../shopify.server";
import { getCachedPlan, getCurrentPlan } from "../utils/billing.server.js";
import { mapWithConcurrency, writeAccordionMetafieldsBatch } from "../utils/metafield.server.js";
import { PLANS } from "../utils/plans.js";
import { getProductFields, saveProductFields } from "../utils/productFields.server.js";
import { getExistingProducts } from "../utils/products.server.js";

// Parallel Mongo writes / lookups per request. High enough to hide round-trip
// latency, low enough not to exhaust the connection pool.
const DB_CONCURRENCY = 8;

export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const [existingProducts, mplan] = await Promise.all([
    getExistingProducts(session.shop),
    getCurrentPlan(billing, session.shop),
  ]);
  return { existingProducts, plan: mplan };
};

export const action = async ({ request }) => {
  const { session, admin, billing } = await authenticate.admin(request);

  // Prefer cache-only plan check in action context — calling billing.check() from
  // an XHR action can trigger SDK side-effects (invalidateAccessToken) that break
  // subsequent admin.graphql() calls in the same request.
  const plan = getCachedPlan(session.shop) ?? await getCurrentPlan(billing, session.shop);
  if (plan !== PLANS.GROWTH) {
    return { error: "Bulk Apply requires the Growth plan." };
  }

  const formData = await request.formData();

  // Fetch all store products and return them for client-side "Select All"
  if (formData.get("intent") === "fetchAllProducts") {
    try {
      const products = await fetchAllShopifyProducts(admin);
      return { allProducts: products };
    } catch (e) {
      if (e instanceof Response) throw e;
      console.error("[CustomVogue] fetchAllProducts error:", e instanceof Error ? e.message : e);
      return { allProducts: [], error: "Failed to fetch products. Please try again." };
    }
  }

  const sourceId = formData.get("sourceId");
  const targetIds = formData.getAll("targetIds[]");
  const targetTitles = formData.getAll("targetTitles[]");

  if (!sourceId || targetIds.length === 0) {
    return { error: "Select a source product and at least one target product." };
  }

  const sourceFields = await getProductFields(sourceId, session.shop);
  if (sourceFields.length === 0) {
    return { error: "Source product has no custom fields to copy." };
  }

  const targets = [];
  for (let i = 0; i < targetIds.length; i++) {
    if (targetIds[i] === sourceId) continue;
    targets.push({ id: targetIds[i], title: targetTitles[i] || targetIds[i] });
  }

  let copied = 0;
  try {
    // Database writes run in parallel instead of one product at a time.
    const saved = await mapWithConcurrency(targets, DB_CONCURRENCY, async (target) => {
      const targetDocs = sourceFields.map((f, idx) => ({
        shop: session.shop,
        productId: target.id,
        productTitle: target.title,
        title: f.title,
        titleFont: f.titleFont ?? "",
        content: f.content ?? "",
        sortOrder: idx,
        displayStyle: f.displayStyle,
      }));

      // saveProductFields already returns the stored docs, so pass them straight
      // through — the old code re-read them from Mongo inside the metafield write.
      const docs = await saveProductFields(target.id, session.shop, targetDocs);
      return { productId: target.id, docs };
    });

    // Counted before the sync so a sync failure still reports the products that
    // were written, matching the old per-product loop's partial-success warning.
    copied = saved.length;

    // One batched sync for every product instead of a request each.
    await writeAccordionMetafieldsBatch(admin, saved);
  } catch (e) {
    if (e instanceof Response) throw e;
    console.error("[CustomVogue] Bulk Apply error:", e instanceof Error ? e.message : e);
    if (copied > 0) return { success: true, copied, warning: "Some products may not have synced." };
    return { error: e instanceof Error ? e.message : "Failed to apply fields. Please try again." };
  }

  return { success: true, copied };
};

async function fetchAllShopifyProducts(admin) {
  const products = [];
  let cursor = null;
  do {
    const res = await admin.graphql(
      `#graphql
      query getProducts($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id title }
        }
      }`,
      { variables: { cursor } }
    );
    const json = await res.json();
    const page = json.data?.products;
    products.push(...(page?.nodes ?? []).map((p) => ({ id: p.id, title: p.title })));
    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return products;
}

export default function BulkApply() {
  const { existingProducts, plan } = useLoaderData();
  const isGrowth = plan === PLANS.GROWTH;

  if (!isGrowth) {
    return (
      <div style={s.page}>
        <Link to="/app" style={s.backLink}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
          Back to App
        </Link>
        <div style={s.gateWrap}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚡</div>
          <h2 style={s.gateTitle}>Growth Plan Required</h2>
          <p style={s.gateDesc}>Bulk Apply is available on the Growth plan ($4.99/month). Upgrade to copy custom fields across multiple products at once.</p>
          <Link to="/app/billing" style={s.gateBtn}>Upgrade to Growth →</Link>
        </div>
      </div>
    );
  }
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const allFetcher = useFetcher();

  const [sourceProduct, setSourceProduct] = useState(null);
  const [targetProducts, setTargetProducts] = useState([]);

  const isLoadingAll = useBusyTimeout(allFetcher.state !== "idle");

  const handleSelectAll = () => {
    const fd = new FormData();
    fd.append("intent", "fetchAllProducts");
    allFetcher.submit(fd, { method: "post" });
  };

  useEffect(() => {
    if (allFetcher.data?.allProducts) {
      const filtered = allFetcher.data.allProducts.filter((p) => p.id !== sourceProduct?.id);
      setTargetProducts(filtered);
    }
  }, [allFetcher.data]);

  const handlePickSource = async () => {
    const result = await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: false,
      filter: { variants: false },
    });
    if (result?.selection?.[0]) {
      const p = result.selection[0];
      setSourceProduct({ id: p.id, title: p.title });
      setTargetProducts((prev) => prev.filter((t) => t.id !== p.id));
    }
  };

  const handlePickTargets = async () => {
    const result = await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: true,
      filter: { variants: false },
    });
    if (result?.selection?.length > 0) {
      const picked = result.selection
        .map((p) => ({ id: p.id, title: p.title }))
        .filter((p) => p.id !== sourceProduct?.id);
      setTargetProducts(picked);
    }
  };

  const removeTarget = (id) =>
    setTargetProducts((prev) => prev.filter((p) => p.id !== id));

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!sourceProduct || targetProducts.length === 0) return;

    const fd = new FormData();
    fd.append("sourceId", sourceProduct.id);
    targetProducts.forEach((p) => fd.append("targetIds[]", p.id));
    targetProducts.forEach((p) => fd.append("targetTitles[]", p.title));
    fetcher.submit(fd, { method: "post" });
  };

  const isSubmitting = useBusyTimeout(fetcher.state === "submitting");
  const result = fetcher.data;
  const canSubmit = sourceProduct && targetProducts.length > 0 && !isSubmitting;

  return (
    <div style={s.page}>

      {/* Back link */}
      <Link to="/app" style={s.backLink}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M19 12H5M12 5l-7 7 7 7" />
        </svg>
        Back to App
      </Link>

      {/* Hero header */}
      <div style={s.hero}>
        <div style={s.heroIcon}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <path d="M14 17h7M17 14v7" />
          </svg>
        </div>
        <div>
          <h1 style={s.heroTitle}>Bulk Apply</h1>
          <p style={s.heroDesc}>Copy one product's custom fields to multiple products at once.</p>
        </div>
      </div>

      {/* Banners */}
      {result?.success && (
        <div style={s.successBanner}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          Fields copied to<strong style={{ margin: "0 -2px" }}>{result.copied}</strong> product{result.copied !== 1 ? "s" : ""} successfully!
        </div>
      )}
      {result?.warning && (
        <div style={{ ...s.errorBanner, background: "#fef9c3", borderColor: "#fde047", color: "#854d0e" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          {result.warning}
        </div>
      )}
      {result?.error && (
        <div style={s.errorBanner}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {result.error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {/* Step 1 */}
        <div style={s.card}>
          <div style={s.stepHeader}>
            <div style={{ ...s.stepBadge, background: sourceProduct ? "#10b981" : "#2563eb" }}>
              {sourceProduct ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : "1"}
            </div>
            <div>
              <div style={s.stepTitle}>Pick source product</div>
              <div style={s.stepDesc}>Fields from this product will be copied to all targets.</div>
            </div>
          </div>

          {sourceProduct ? (
            <div style={s.selectedBox}>
              <div style={s.selectedMeta}>
                <div style={s.selectedDot} />
                <span style={s.selectedName}>{sourceProduct.title}</span>
              </div>
              <button type="button" onClick={handlePickSource} style={s.changeBtn}>
                Change
              </button>
            </div>
          ) : (
            <button type="button" onClick={handlePickSource} style={s.primaryBtn}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              Select source product
            </button>
          )}
        </div>

        {/* Connector */}
        <div style={s.connector}>
          <div style={s.connectorLine} />
          <div style={s.connectorArrow}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
          <div style={s.connectorLine} />
        </div>

        {/* Step 2 */}
        <div style={{ ...s.card, ...(sourceProduct ? {} : s.cardMuted) }}>
          <div style={s.stepHeader}>
            <div style={{ ...s.stepBadge, background: targetProducts.length > 0 ? "#10b981" : sourceProduct ? "#2563eb" : "#d1d5db" }}>
              {targetProducts.length > 0 ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : "2"}
            </div>
            <div>
              <div style={s.stepTitle}>Pick target products</div>
              <div style={s.stepDesc}>These products will receive a copy of the source fields.</div>
            </div>
          </div>

          <div style={s.targetBtnRow}>
            <button
              type="button"
              onClick={handlePickTargets}
              disabled={!sourceProduct}
              style={{ ...s.primaryBtn, ...(sourceProduct ? {} : s.btnDisabled) }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              {targetProducts.length > 0 ? `${targetProducts.length} selected — change` : "Select target products"}
            </button>

            <button
              type="button"
              onClick={handleSelectAll}
              disabled={!sourceProduct || isLoadingAll}
              style={{ ...s.selectAllBtn, ...(!sourceProduct || isLoadingAll ? s.btnDisabled : {}) }}
            >
              {isLoadingAll ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite" }}>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Loading…
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" /><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                  </svg>
                  Select all products
                </>
              )}
            </button>
          </div>

          {targetProducts.length > 0 && (
            <div style={s.targetList}>
              {targetProducts.map((p) => (
                <div key={p.id} style={s.targetRow}>
                  <div style={s.targetDot} />
                  <span style={s.targetName}>{p.title}</span>
                  <button
                    type="button"
                    onClick={() => removeTarget(p.id)}
                    style={s.removeBtn}
                    title="Remove"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Summary */}
        {sourceProduct && targetProducts.length > 0 && (
          <div style={s.summaryBox}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            Will copy fields from <strong style={{ margin: "0 -4px" }}>{sourceProduct.title}</strong> to{" "}
            <strong style={{ margin: "0 -4px" }}>{targetProducts.length} product{targetProducts.length !== 1 ? "s" : ""}</strong>.
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={!canSubmit}
          style={{ ...s.submitBtn, ...(!canSubmit ? s.btnDisabled : {}) }}
        >
          {isSubmitting ? (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite" }}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              Applying…
            </>
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Apply Fields
            </>
          )}
        </button>
      </form>

      {/* Existing products */}
      {existingProducts.length > 0 && (
        <div style={s.hintBox}>
          <div style={s.hintHeader}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span style={s.hintTitle}>Products with custom fields ({existingProducts.length})</span>
          </div>
          <p style={s.hintDesc}>You can use any of these as a source product.</p>
          <div style={s.hintChips}>
            {existingProducts.slice(0, 6).map((p) => (
              <span key={p.id} style={s.chip}>
                {p.title}
                <span style={s.chipCount}>{p.fieldCount}</span>
              </span>
            ))}
            {existingProducts.length > 6 && (
              <span style={s.chip}>+{existingProducts.length - 6} more</span>
            )}
          </div>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const s = {
  gateWrap: {
    textAlign: "center",
    padding: "64px 24px",
    maxWidth: 480,
    margin: "0 auto",
  },
  gateTitle: { fontSize: 20, fontWeight: 700, color: "#111827", margin: "0 0 10px" },
  gateDesc: { fontSize: 14, color: "#6b7280", maxWidth: 420, margin: "0 auto 24px", lineHeight: 1.6 },
  gateBtn: {
    display: "inline-block",
    background: "#2563eb",
    color: "#fff",
    padding: "10px 24px",
    borderRadius: 8,
    fontWeight: 700,
    fontSize: 14,
    textDecoration: "none",
  },
  page: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    maxWidth: 680,
    margin: "0 auto",
    padding: "28px 24px 48px",
  },
  backLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: "#6b7280",
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 500,
    marginBottom: 20,
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #e5e7eb",
    background: "#fff",
    transition: "background 0.15s",
  },
  hero: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    marginBottom: 24,
    padding: "20px 24px",
    background: "linear-gradient(135deg, #1d4ed8 0%, #2563eb 50%, #3b82f6 100%)",
    borderRadius: 12,
    color: "#fff",
  },
  heroIcon: {
    width: 52,
    height: 52,
    background: "rgba(255,255,255,0.15)",
    borderRadius: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  heroTitle: {
    fontSize: 22,
    fontWeight: 700,
    margin: "0 0 4px",
    color: "#fff",
  },
  heroDesc: {
    fontSize: 14,
    margin: 0,
    color: "rgba(255,255,255,0.8)",
  },
  successBanner: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "#d1fae5",
    color: "#065f46",
    border: "1px solid #6ee7b7",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 500,
    marginBottom: 20,
  },
  errorBanner: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "#fee2e2",
    color: "#991b1b",
    border: "1px solid #fca5a5",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 14,
    marginBottom: 20,
  },
  card: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "20px 22px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
  },
  cardMuted: {
    opacity: 0.6,
    pointerEvents: "none",
  },
  stepHeader: {
    display: "flex",
    alignItems: "flex-start",
    gap: 14,
    marginBottom: 16,
  },
  stepBadge: {
    width: 32,
    height: 32,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
    fontWeight: 700,
    color: "#fff",
    flexShrink: 0,
    transition: "background 0.2s",
  },
  stepTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: "#111827",
    marginBottom: 2,
  },
  stepDesc: {
    fontSize: 13,
    color: "#6b7280",
  },
  connector: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 0,
    margin: "4px 0",
    height: 36,
  },
  connectorLine: {
    width: 2,
    flex: 1,
    background: "#e5e7eb",
  },
  connectorArrow: {
    color: "#9ca3af",
    lineHeight: 1,
  },
  targetBtnRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  primaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "9px 18px",
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  selectAllBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    padding: "9px 16px",
    background: "#fff",
    color: "#2563eb",
    border: "1.5px solid #2563eb",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnDisabled: {
    background: "#d1d5db",
    color: "#9ca3af",
    cursor: "not-allowed",
  },
  selectedBox: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "11px 14px",
    background: "#f0fdf4",
    border: "1.5px solid #86efac",
    borderRadius: 8,
  },
  selectedMeta: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  selectedDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#10b981",
    flexShrink: 0,
  },
  selectedName: {
    fontSize: 14,
    fontWeight: 600,
    color: "#111827",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  changeBtn: {
    padding: "5px 12px",
    background: "#fff",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    color: "#374151",
    flexShrink: 0,
  },
  targetList: {
    marginTop: 14,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  targetRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 12px",
    background: "#f8faff",
    border: "1px solid #dbeafe",
    borderRadius: 8,
  },
  targetDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "#3b82f6",
    flexShrink: 0,
  },
  targetName: {
    flex: 1,
    fontSize: 14,
    color: "#1e40af",
    fontWeight: 500,
  },
  removeBtn: {
    background: "none",
    border: "none",
    color: "#9ca3af",
    cursor: "pointer",
    padding: "2px 4px",
    display: "flex",
    alignItems: "center",
    borderRadius: 4,
    flexShrink: 0,
  },
  summaryBox: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "#eff6ff",
    border: "1px solid #bfdbfe",
    borderRadius: 8,
    padding: "11px 16px",
    fontSize: 14,
    color: "#1e40af",
    margin: "16px 0",
  },
  submitBtn: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 28px",
    background: "linear-gradient(135deg, #1d4ed8, #2563eb)",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(37,99,235,0.35)",
    marginTop: 4,
  },
  hintBox: {
    marginTop: 32,
    padding: "18px 20px",
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
  },
  hintHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  hintTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
  },
  hintDesc: {
    fontSize: 13,
    color: "#6b7280",
    margin: "0 0 12px",
  },
  hintChips: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: "4px 12px",
    fontSize: 12,
    color: "#374151",
    fontWeight: 500,
  },
  chipCount: {
    background: "#e5e7eb",
    borderRadius: 10,
    padding: "1px 7px",
    fontSize: 11,
    color: "#6b7280",
    fontWeight: 600,
  },
};
