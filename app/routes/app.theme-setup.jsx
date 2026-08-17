import { Link, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { checkThemeSetup, getAddBlockUrl, getMainTheme } from "../utils/theme.server.js";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  let theme = null;
  let setup = { isOS2: false, blockDetected: false };
  let error = null;

  try {
    theme = await getMainTheme(admin);
    if (theme) {
      setup = await checkThemeSetup(admin, theme.id);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Could not read theme data.";
  }

  const addBlockUrl = getAddBlockUrl(session.shop);

  return { theme, setup, addBlockUrl, error };
};

export default function ThemeSetup() {
  const { theme, setup, addBlockUrl, error } = useLoaderData();
  const revalidator = useRevalidator();
  const [searchParams] = useSearchParams();
  const returnTab = searchParams.get("tab") || "App Settings";
  const isChecking = revalidator.state !== "idle";

  return (
    <div style={s.page}>
      <Link to={`/app?tab=${encodeURIComponent(returnTab)}`} style={s.backLink}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M12 5l-7 7 7 7" />
        </svg>
        Back
      </Link>

      <div style={s.card}>
        <div style={s.headerRow}>
          <div style={s.headerIcon}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </div>
          <div>
            <div style={s.headerTitle}>CustomVogue</div>
            <div style={s.headerSubtitle}>CONNECT YOUR THEME</div>
          </div>
        </div>

        {error ? (
          <div style={s.errorBanner}>{error}</div>
        ) : (
          <div style={{ ...s.checkBadge, ...(setup.isOS2 ? s.checkBadgeOk : s.checkBadgeWarn) }}>
            {setup.isOS2 ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Compatibility check passed
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {theme ? "Theme is not Online Store 2.0 — app blocks aren't supported" : "Could not detect your active theme"}
              </>
            )}
          </div>
        )}

        <h1 style={s.title}>Connect your theme</h1>
        <p style={s.desc}>
          Add the CustomVogue block to your product page template so the custom fields you create actually show up for shoppers.
        </p>

        <div style={s.stepsCard}>
          <div style={s.stepsHeader}>ADD THE BLOCK</div>

          <div style={s.step}>
            <div style={s.stepNum}>1</div>
            <div style={s.stepBody}>
              <div style={s.stepTitleRow}>
                <span style={s.stepTitle}>Open your theme editor</span>
                {addBlockUrl && (
                  <a href={addBlockUrl} target="_top" rel="noreferrer noopener" style={s.openBtn}>
                    Open Theme Editor
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                )}
              </div>
              <p style={s.stepDesc}>This link jumps straight to your Product template with the block ready to add.</p>
            </div>
          </div>

          <div style={s.step}>
            <div style={s.stepNum}>2</div>
            <div style={s.stepBody}>
              <span style={s.stepTitle}>Go to your Product page template</span>
              <p style={s.stepDesc}>Pick "Product" and select "Default product" from the page dropdown, if it isn't there already.</p>
            </div>
          </div>

          <div style={s.step}>
            <div style={s.stepNum}>3</div>
            <div style={s.stepBody}>
              <span style={s.stepTitle}>Add the CustomVogue block</span>
              <p style={s.stepDesc}>In the left-side section, click Product information → "Add block" → select the "Apps" tab → search "Custom Fields" → Save.</p>
            </div>
          </div>
        </div>

        <div style={{ ...s.statusCard, ...(setup.blockDetected ? s.statusCardOk : {}) }}>
          <div style={s.statusRow}>
            {setup.blockDetected ? (
              <span style={s.statusCheck}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><polyline points="16 9.5 10.75 15 8 12.25" />
                </svg>
              </span>
            ) : (
              <span style={s.statusDot} />
            )}
            <div>
              <div style={{ ...s.statusTitle, ...(setup.blockDetected ? s.statusTitleOk : {}) }}>
                {setup.blockDetected
                  ? "CustomVogue block detected in your theme"
                  : "CustomVogue block not detected yet"}
              </div>
              <div style={{ ...s.statusDesc, ...(setup.blockDetected ? s.statusDescOk : {}) }}>
                {setup.blockDetected
                  ? "Your product page is ready to display custom fields."
                  : "Follow the steps above, then click Re-check once you've saved."}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => revalidator.revalidate()}
            disabled={isChecking}
            style={{ ...s.recheckBtn, ...(isChecking ? { cursor: "not-allowed", opacity: 0.6 } : {}) }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            {isChecking ? "Checking…" : "Re-check theme"}
          </button>
        </div>
      </div>
    </div>
  );
}

const s = {
  page: {
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    maxWidth: 720,
    margin: "0 auto",
    padding: "24px 24px 48px",
  },
  backLink: {
    display: "inline-flex", alignItems: "center", gap: 6,
    color: "#6b7280", textDecoration: "none", cursor: "pointer",
    fontSize: 13, fontWeight: 500, marginBottom: 20,
    padding: "6px 12px", borderRadius: 8, border: "1px solid #e5e7eb",
    background: "#fff", boxShadow: "0 2px 20px rgba(0, 0, 0, 0.09)",
  },
  card: {
    background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
    padding: "24px 28px", boxShadow: "0 2px 20px rgba(0, 0, 0, 0.09)",
  },
  headerRow: { display: "flex", alignItems: "center", gap: 12, marginBottom: 20 },
  headerIcon: {
    width: 40, height: 40, borderRadius: 10, flexShrink: 0,
    background: "linear-gradient(135deg, #1d4ed8, #2563eb)",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  headerTitle: { fontSize: 15, fontWeight: 700, color: "#111827" },
  headerSubtitle: { fontSize: 11, fontWeight: 600, color: "#6b7280", letterSpacing: "0.05em" },
  checkBadge: {
    display: "inline-flex", alignItems: "center", gap: 8,
    fontSize: 12, fontWeight: 700, letterSpacing: "0.03em",
    padding: "6px 12px", borderRadius: 20, marginBottom: 16,
  },
  checkBadgeOk: { background: "#dcfce7", color: "#15803d" },
  checkBadgeWarn: { background: "#fef3c7", color: "#b45309" },
  errorBanner: {
    background: "#fee2e2", color: "#991b1b", border: "1px solid #fca5a5",
    borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 16,
  },
  title: { fontSize: 24, fontWeight: 700, color: "#111827", margin: "0 0 8px" },
  desc: { fontSize: 14, color: "#6b7280", margin: "0 0 20px", lineHeight: 1.6 },
  stepsCard: {
    border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden", marginBottom: 16,
  },
  stepsHeader: {
    fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.05em",
    background: "#f9fafb", padding: "10px 16px", borderBottom: "1px solid #e5e7eb",
  },
  step: {
    display: "flex", gap: 14, padding: "16px", borderBottom: "1px solid #f3f4f6",
  },
  stepNum: {
    width: 24, height: 24, borderRadius: "50%", background: "#111827", color: "#fff",
    fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  },
  stepBody: { flex: 1 },
  stepTitleRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
  stepTitle: { fontSize: 14, fontWeight: 600, color: "#111827" },
  stepDesc: { fontSize: 13, color: "#6b7280", margin: "4px 0 0", lineHeight: 1.5 },
  openBtn: {
    display: "inline-flex", alignItems: "center", gap: 6,
    background: "#111827", color: "#fff", textDecoration: "none",
    fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 6, whiteSpace: "nowrap",
  },
  statusCard: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
    flexWrap: "wrap", background: "#f9fafb", border: "1px solid #e5e7eb",
    borderRadius: 10, padding: "14px 16px",
  },
  statusCardOk: { background: "#f0fdf4", border: "1px solid #86efac" },
  statusRow: { display: "flex", alignItems: "flex-start", gap: 10 },
  statusDot: {
    width: 16, height: 16, borderRadius: "50%", border: "2px solid #d1d5db",
    marginTop: 2, flexShrink: 0,
  },
  statusCheck: { color: "#16a34a", display: "flex", flexShrink: 0, marginTop: 1 },
  statusTitle: { fontSize: 13, fontWeight: 600, color: "#111827" },
  statusTitleOk: { color: "#166534", fontWeight: 700 },
  statusDesc: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  statusDescOk: { color: "#3f6212" },
  recheckBtn: {
    display: "inline-flex", alignItems: "center", gap: 6,
    background: "#fff", color: "#374151", border: "1px solid #d1d5db",
    borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600,
    cursor: "pointer", whiteSpace: "nowrap",
  },
};
