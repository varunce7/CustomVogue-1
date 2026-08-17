import { useState } from "react";
import { Link, useFetcher, useLoaderData } from "react-router";
import { useBusyTimeout } from "../hooks/useBusyTimeout";
import { authenticate } from "../shopify.server";
import { getCurrentPlan } from "../utils/billing.server.js";
import { PLANS } from "../utils/plans.js";
import {
  ensureCustomCssDefinition,
  getCustomCss,
  saveCustomCss,
} from "../utils/customCss.server.js";

export const loader = async ({ request }) => {
  const { session, admin, billing } = await authenticate.admin(request);
  const plan = await getCurrentPlan(billing, session.shop);
  if (plan !== PLANS.GROWTH) return { plan, css: "" };

  await ensureCustomCssDefinition(admin);
  const { shopId, css } = await getCustomCss(admin);
  return { plan, css, shopId };
};

export const action = async ({ request }) => {
  const { session, admin, billing } = await authenticate.admin(request);
  const plan = await getCurrentPlan(billing, session.shop);
  if (plan !== PLANS.GROWTH) return { error: "Growth plan required." };

  const formData = await request.formData();
  const css = formData.get("css") ?? "";
  const shopId = formData.get("shopId") ?? "";

  try {
    await saveCustomCss(admin, shopId, css);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
};

export default function CustomCssPage() {
  const { plan, css: initialCss, shopId } = useLoaderData();
  const fetcher = useFetcher();
  const [css, setCss] = useState(initialCss ?? "");

  const isGrowth = plan === PLANS.GROWTH;
  const isSaving = useBusyTimeout(fetcher.state === "submitting");
  const result = fetcher.data;

  return (
    <div style={s.page}>

      {/* Back */}
      <Link to="/app" style={s.backLink}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M12 5l-7 7 7 7" />
        </svg>
        Back to App
      </Link>

      {/* Hero */}
      <div style={s.hero}>
        <div style={s.heroIcon}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        </div>
        <div>
          <h1 style={s.heroTitle}>Custom CSS</h1>
          <p style={s.heroDesc}>Inject custom styles into your storefront — no theme editor needed.</p>
        </div>
        <div style={s.heroBadge}>Growth</div>
      </div>

      {!isGrowth ? (
        /* Gate for Free users */
        <div style={s.gateBox}>
          <div style={s.gateIcon}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h2 style={s.gateTitle}>Growth Plan Required</h2>
          <p style={s.gateDesc}>
            Custom CSS injection is available on the Growth plan ($4.99/month). Upgrade to write custom styles that apply globally to your Custom Fields block.
          </p>
          <Link to="/app/billing" style={s.upgradeBtn}>
            View Plans & Upgrade
          </Link>
        </div>
      ) : (
        /* Editor */
        <fetcher.Form method="post" style={s.form}>
          <input type="hidden" name="shopId" value={shopId} />

          {/* Banners */}
          {result?.success && (
            <div style={s.successBanner}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              Custom CSS saved and live on your storefront.
            </div>
          )}
          {result?.error && (
            <div style={s.errorBanner}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {result.error}
            </div>
          )}

          <div style={s.editorCard}>
            <div style={s.editorHeader}>
              <div style={s.editorDots}>
                <span style={{ ...s.dot, background: "#ff5f57" }} />
                <span style={{ ...s.dot, background: "#febc2e" }} />
                <span style={{ ...s.dot, background: "#28c840" }} />
              </div>
              <span style={s.editorLabel}>custom.css</span>
              <span style={s.charCount}>{css.length} chars</span>
            </div>
            <textarea
              name="css"
              value={css}
              onChange={(e) => setCss(e.target.value)}
              style={s.editor}
              placeholder={`/* Target the Custom Fields block */
.cv-block-wrapper {
  border-radius: 12px;
  overflow: hidden;
}

/* Style accordion titles */
.cv-accordion-trigger {
  font-family: 'Georgia', serif;
  letter-spacing: 0.5px;
}

/* Change active tab underline color */
.cv-tab-btn.cv-tab-active {
  color: #e63946;
}`}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div style={s.footer}>
            <div style={s.hints}>
              <div style={s.hintItem}>
                <code style={s.code}>.cv-block-wrapper</code> — outer container
              </div>
              <div style={s.hintItem}>
                <code style={s.code}>.cv-accordion-trigger</code> — accordion header row
              </div>
              <div style={s.hintItem}>
                <code style={s.code}>.cv-accordion-content</code> — accordion body
              </div>
              <div style={s.hintItem}>
                <code style={s.code}>.cv-tab-btn</code> — tab button
              </div>
              <div style={s.hintItem}>
                <code style={s.code}>.cv-tab-btn.cv-tab-active</code> — active tab
              </div>
            </div>

            <button type="submit" disabled={isSaving} style={{ ...s.saveBtn, ...(isSaving ? s.saveBtnDisabled : {}) }}>
              {isSaving ? (
                <>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite" }}>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Saving…
                </>
              ) : (
                <>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" />
                  </svg>
                  Save CSS
                </>
              )}
            </button>
          </div>
        </fetcher.Form>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const s = {
  page: {
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    maxWidth: 820,
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
  },
  hero: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    marginBottom: 24,
    padding: "18px 22px",
    background: "linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #334155 100%)",
    borderRadius: 12,
    color: "#fff",
  },
  heroIcon: {
    width: 50,
    height: 50,
    background: "rgba(255,255,255,0.12)",
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  heroTitle: {
    fontSize: 21,
    fontWeight: 700,
    margin: "0 0 3px",
    color: "#fff",
    flex: 1,
  },
  heroDesc: {
    fontSize: 13,
    margin: 0,
    color: "rgba(255,255,255,0.65)",
  },
  heroBadge: {
    padding: "4px 12px",
    background: "linear-gradient(135deg, #f59e0b, #d97706)",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 700,
    color: "#fff",
    flexShrink: 0,
  },
  gateBox: {
    textAlign: "center",
    padding: "60px 40px",
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
  },
  gateIcon: { marginBottom: 16 },
  gateTitle: { fontSize: 20, fontWeight: 700, color: "#111827", marginBottom: 10 },
  gateDesc: { fontSize: 14, color: "#6b7280", maxWidth: 420, margin: "0 auto 24px" },
  upgradeBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 24px",
    background: "linear-gradient(135deg, #f59e0b, #d97706)",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    textDecoration: "none",
  },
  form: { display: "flex", flexDirection: "column", gap: 0 },
  successBanner: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "#d1fae5",
    color: "#065f46",
    border: "1px solid #6ee7b7",
    borderRadius: 8,
    padding: "11px 16px",
    fontSize: 14,
    fontWeight: 500,
    marginBottom: 16,
  },
  errorBanner: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "#fee2e2",
    color: "#991b1b",
    border: "1px solid #fca5a5",
    borderRadius: 8,
    padding: "11px 16px",
    fontSize: 14,
    marginBottom: 16,
  },
  editorCard: {
    border: "1px solid #1e293b",
    borderRadius: 10,
    overflow: "hidden",
    boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
  },
  editorHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 16px",
    background: "#1e293b",
  },
  editorDots: { display: "flex", gap: 6, marginRight: 8 },
  dot: { width: 12, height: 12, borderRadius: "50%", display: "block" },
  editorLabel: { flex: 1, fontSize: 12, color: "#94a3b8", fontFamily: "monospace" },
  charCount: { fontSize: 11, color: "#64748b" },
  editor: {
    display: "block",
    width: "100%",
    minHeight: 360,
    background: "#0f172a",
    color: "#e2e8f0",
    border: "none",
    padding: "20px",
    fontFamily: "'Fira Code', 'Cascadia Code', 'Courier New', monospace",
    fontSize: 13,
    lineHeight: 1.7,
    resize: "vertical",
    outline: "none",
    boxSizing: "border-box",
    tabSize: 2,
  },
  footer: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 20,
    marginTop: 16,
  },
  hints: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    flex: 1,
  },
  hintItem: {
    fontSize: 12,
    color: "#6b7280",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  code: {
    background: "#f3f4f6",
    border: "1px solid #e5e7eb",
    borderRadius: 4,
    padding: "1px 6px",
    fontFamily: "monospace",
    fontSize: 11,
    color: "#374151",
  },
  saveBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 22px",
    background: "linear-gradient(135deg, #0f172a, #1e293b)",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    flexShrink: 0,
    boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
  },
  saveBtnDisabled: {
    opacity: 0.6,
    cursor: "not-allowed",
  },
};
