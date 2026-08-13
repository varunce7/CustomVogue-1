import { useState } from "react";
import { redirect, useFetcher, useLoaderData, useRevalidator } from "react-router";
import connection from "../db.server.js";
import ShopOnboarding from "../models/ShopOnboarding.js";
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

  return { theme, setup, addBlockUrl: getAddBlockUrl(session.shop), error };
};

// Marks onboarding done and drops the merchant on the dashboard. Reached from
// "Skip setup", "I'll do this later" and "Continue" alike — the flow is only
// ever meant to be shown once, whether or not the block was added here.
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  try {
    await connection;
    await ShopOnboarding.findByIdAndUpdate(
      session.shop,
      { completedAt: new Date() },
      { upsert: true, setDefaultsOnInsert: true },
    );
  } catch (e) {
    console.error("[CustomVogue] onboarding save error:", e instanceof Error ? e.message : e);
  }

  return redirect("/app");
};

const TOTAL_STEPS = 2;

function Brand() {
  return (
    <div style={s.brand}>
      <div style={s.brandIcon}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </div>
      <div>
        <div style={s.brandName}>MetaVogue</div>
        <div style={s.brandTag}>PRODUCT CUSTOM FIELDS</div>
      </div>
    </div>
  );
}

export default function Onboarding() {
  const { theme, setup, addBlockUrl, error } = useLoaderData();
  const revalidator = useRevalidator();
  const finishFetcher = useFetcher();
  // 0 = welcome splash, 1 = intro, 2 = connect your theme
  const [screen, setScreen] = useState(0);

  const isChecking = revalidator.state !== "idle";
  const finishing = finishFetcher.state !== "idle";
  const finish = () => finishFetcher.submit({}, { method: "post" });

  /* ══════════ WELCOME SPLASH ══════════ */
  if (screen === 0) {
    return (
      <div style={s.page}>
        <div style={{ ...s.card, ...s.welcomeCard }}>
          <div style={s.welcomeBrand}><Brand /></div>

          <svg width="260" height="160" viewBox="0 0 260 160" style={s.art} role="img" aria-label="Product page with custom fields">
            <circle cx="118" cy="74" r="56" fill="#eef2ff" />
            <circle cx="52" cy="118" r="4" fill="#c7d2fe" />
            <circle cx="196" cy="42" r="4" fill="#c7d2fe" />
            <circle cx="70" cy="40" r="3" fill="#dbeafe" />

            <rect x="16" y="52" width="56" height="20" rx="10" fill="#fff" stroke="#c7d2fe" />
            <rect x="26" y="60" width="36" height="4" rx="2" fill="#93c5fd" />

            <rect x="188" y="42" width="56" height="20" rx="10" fill="#fff" stroke="#c7d2fe" />
            <rect x="198" y="50" width="36" height="4" rx="2" fill="#93c5fd" />

            <rect x="188" y="96" width="56" height="20" rx="10" fill="#fff" stroke="#c7d2fe" />
            <rect x="198" y="104" width="36" height="4" rx="2" fill="#93c5fd" />

            <rect x="86" y="18" width="76" height="118" rx="10" fill="#fff" stroke="#2563eb" strokeWidth="1.5" />
            <circle cx="112" cy="30" r="2" fill="#cbd5e1" />
            <circle cx="120" cy="30" r="2" fill="#cbd5e1" />
            <circle cx="128" cy="30" r="2" fill="#cbd5e1" />
            <rect x="96" y="40" width="56" height="40" rx="6" fill="#eef2ff" />
            <path d="M114 52h12l6 4-3 5-3-2v13h-12V59l-3 2-3-5z" fill="#93c5fd" />
            <rect x="96" y="86" width="40" height="5" rx="2.5" fill="#2563eb" />
            <rect x="96" y="96" width="56" height="4" rx="2" fill="#e2e8f0" />
            <rect x="96" y="104" width="46" height="4" rx="2" fill="#e2e8f0" />
            <circle cx="101" cy="120" r="5" fill="#dbeafe" />
            <circle cx="113" cy="120" r="5" fill="#dbeafe" />
            <circle cx="125" cy="120" r="5" fill="#dbeafe" />
            <circle cx="137" cy="120" r="5" fill="#dbeafe" />
          </svg>

          <h1 style={s.welcomeTitle}>Welcome to MetaVogue</h1>
          <p style={s.welcomeDesc}>
            Have your product pages enriched and up and running in just a few minutes.
          </p>
          <button type="button" onClick={() => setScreen(1)} style={s.darkBtn}>Next</button>
        </div>
      </div>
    );
  }

  /* ══════════ STEPS ══════════ */
  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={s.stepHeader}>
          <Brand />
          <div style={s.stepHeaderRight}>
            <span style={s.stepCount}>Step {screen} of {TOTAL_STEPS}</span>
            <button type="button" onClick={finish} disabled={finishing} style={s.skipLink}>Skip setup</button>
          </div>
        </div>

        <div style={s.progress}>
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <div key={i} style={{ ...s.progressSeg, ...(i < screen ? s.progressSegDone : {}) }} />
          ))}
        </div>

        {/* ── Step 1: intro ── */}
        {screen === 1 && (
          <div style={s.introGrid}>
            <div>
              <div style={s.eyebrow}>WELCOME ABOARD</div>
              <h1 style={s.introTitle}>Every product deserves the full story.</h1>
              <p style={s.introDesc}>
                MetaVogue turns your product pages into structured, scannable, shopper-confident
                experiences. Materials. Sizing. Care. Shipping. All from one app.
              </p>
              <button type="button" onClick={() => setScreen(2)} style={s.darkBtn}>
                Let&apos;s set up your store →
              </button>
              <p style={s.introNote}>
                Setup takes 2 minutes. Nothing changes on your storefront until you&apos;re ready.
              </p>
            </div>

            <div>
              <div style={s.eyebrowMuted}>BEFORE VS AFTER</div>
              <div style={s.compareRow}>
                <div>
                  <div style={s.previewCard}>
                    <div style={s.previewTitle}>Cotton Shirt</div>
                    <div style={s.previewImg} />
                    <p style={s.previewPlain}>
                      100% Cotton. Available in S, M, L. Machine wash cold.
                    </p>
                  </div>
                  <div style={s.previewLabel}>Generic description</div>
                </div>

                <div>
                  <div style={{ ...s.previewCard, ...s.previewCardOk }}>
                    <div style={s.previewTitle}>Cotton Shirt</div>
                    <div style={s.previewImg} />
                    <div style={s.fieldRowOpen}>
                      <div style={s.fieldRowTitle}>Product Details</div>
                      <div style={s.fieldLine} />
                      <div style={{ ...s.fieldLine, width: "70%" }} />
                    </div>
                    <div style={s.fieldRow}><span>Size &amp; Fit</span><span style={s.chev}>+</span></div>
                    <div style={s.fieldRow}><span>Care Instructions</span><span style={s.chev}>+</span></div>
                    <div style={s.previewFooter}>Powered by MetaVogue</div>
                  </div>
                  <div style={{ ...s.previewLabel, ...s.previewLabelOk }}>Structured custom fields</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2: connect your theme ── */}
        {screen === 2 && (
          <div>
            {error ? (
              <div style={s.errorBanner}>{error}</div>
            ) : (
              <div style={{ ...s.checkBadge, ...(setup.isOS2 ? s.checkBadgeOk : s.checkBadgeWarn) }}>
                {setup.isOS2 ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    COMPATIBILITY CHECK PASSED
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    {theme ? "THEME IS NOT ONLINE STORE 2.0" : "COULD NOT DETECT YOUR ACTIVE THEME"}
                  </>
                )}
              </div>
            )}

            <h1 style={s.title}>Connect your theme</h1>
            <p style={s.desc}>
              Add the MetaVogue block to your product page template so customers actually see the
              custom fields you&apos;ll create.
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
                  <p style={s.stepDesc}>Pick &quot;Product&quot; and select &quot;Default product&quot; from the page dropdown, if it isn&apos;t there already.</p>
                </div>
              </div>

              <div style={s.step}>
                <div style={s.stepNum}>3</div>
                <div style={s.stepBody}>
                  <span style={s.stepTitle}>Add the MetaVogue block</span>
                  <p style={s.stepDesc}>In the left-side section, click Product information → &quot;Add block&quot; → select the &quot;Apps&quot; tab → search &quot;Custom Fields&quot; → Save.</p>
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
                      ? "MetaVogue block detected in your theme"
                      : "MetaVogue block not detected yet"}
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
        )}

        <div style={s.footerRow}>
          {screen === 1 ? (
            <div style={s.perks}>
              {["Free plan available", "Online Store 2.0 compatible", "No code required"].map((perk) => (
                <span key={perk} style={s.perk}>✓ {perk}</span>
              ))}
            </div>
          ) : (
            <div>
              <button type="button" onClick={() => setScreen(screen - 1)} style={s.backBtn}>← Back</button>
            </div>
          )}
          {screen === 2 && (
            <div style={s.footerRight}>
              <button type="button" onClick={finish} disabled={finishing} style={s.laterLink}>
                I&apos;ll do this later
              </button>
              <button
                type="button"
                onClick={finish}
                disabled={!setup.blockDetected || finishing}
                style={{ ...s.continueBtn, ...(!setup.blockDetected || finishing ? s.continueBtnOff : {}) }}
              >
                {finishing ? "Finishing…" : "Continue →"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const s = {
  page: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "24px 24px 48px",
  },
  card: {
    background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14,
    padding: "24px 32px 28px", maxWidth: 940, margin: "0 auto",
    boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
  },

  /* Brand */
  brand: { display: "flex", alignItems: "center", gap: 10 },
  brandIcon: {
    width: 30, height: 30, borderRadius: 8, flexShrink: 0,
    background: "linear-gradient(135deg, #1d4ed8, #2563eb)",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  brandName: { fontSize: 13, fontWeight: 700, color: "#111827", lineHeight: 1.2 },
  brandTag: { fontSize: 10, fontWeight: 600, color: "#6b7280", letterSpacing: "0.06em" },

  /* Welcome splash */
  welcomeCard: { maxWidth: 620, textAlign: "center", padding: "36px 32px 40px" },
  welcomeBrand: { display: "flex", justifyContent: "center", marginBottom: 24 },
  art: { display: "block", margin: "0 auto 20px" },
  welcomeTitle: { fontSize: 26, fontWeight: 800, color: "#111827", margin: "0 0 8px" },
  welcomeDesc: { fontSize: 14, color: "#6b7280", margin: "0 0 20px", lineHeight: 1.6 },

  /* Step chrome */
  stepHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" },
  stepHeaderRight: { display: "flex", alignItems: "center", gap: 14 },
  stepCount: { fontSize: 12, color: "#6b7280", fontWeight: 500 },
  skipLink: {
    background: "none", border: "none", padding: 0, cursor: "pointer",
    fontSize: 12, fontWeight: 600, color: "#2563eb",
  },
  progress: { display: "flex", gap: 8, margin: "14px 0 24px" },
  progressSeg: { flex: 1, height: 3, borderRadius: 2, background: "#e5e7eb" },
  progressSegDone: { background: "#2563eb" },

  /* Step 1 — intro */
  introGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, alignItems: "start" },
  eyebrow: { fontSize: 11, fontWeight: 700, color: "#2563eb", letterSpacing: "0.08em", marginBottom: 10 },
  eyebrowMuted: { fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.08em", marginBottom: 10 },
  introTitle: { fontSize: 28, fontWeight: 800, color: "#111827", margin: "0 0 12px", lineHeight: 1.25 },
  introDesc: { fontSize: 14, color: "#4b5563", margin: "0 0 20px", lineHeight: 1.7 },
  introNote: { fontSize: 12, color: "#9ca3af", margin: "14px 0 0", lineHeight: 1.5 },

  compareRow: { display: "grid", gridTemplateColumns: "1fr 1.25fr", gap: 14, alignItems: "start" },
  previewCard: {
    background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 12,
  },
  previewCardOk: { border: "1.5px solid #2563eb", boxShadow: "0 4px 14px rgba(37,99,235,0.12)" },
  previewTitle: { fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 8 },
  previewImg: { height: 46, borderRadius: 6, background: "#f1f5f9", marginBottom: 8 },
  previewPlain: { fontSize: 11, color: "#6b7280", margin: 0, lineHeight: 1.5 },
  fieldRowOpen: {
    background: "#eff6ff", border: "1px solid #dbeafe", borderRadius: 6,
    padding: "7px 8px", marginBottom: 6,
  },
  fieldRowTitle: { fontSize: 11, fontWeight: 700, color: "#1d4ed8", marginBottom: 5 },
  fieldLine: { height: 4, borderRadius: 2, background: "#bfdbfe", marginBottom: 4 },
  fieldRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    border: "1px solid #e5e7eb", borderRadius: 6, padding: "7px 8px",
    fontSize: 11, color: "#374151", marginBottom: 6,
  },
  chev: { color: "#9ca3af", fontWeight: 700 },
  previewFooter: { fontSize: 9, color: "#9ca3af", textAlign: "right" },
  previewLabel: { fontSize: 11, color: "#6b7280", textAlign: "center", marginTop: 8 },
  previewLabelOk: { color: "#2563eb", fontWeight: 600 },

  /* Step 2 — connect your theme */
  checkBadge: {
    display: "inline-flex", alignItems: "center", gap: 8,
    fontSize: 11, fontWeight: 700, letterSpacing: "0.05em",
    padding: "6px 12px", borderRadius: 20, marginBottom: 14,
  },
  checkBadgeOk: { background: "#dcfce7", color: "#15803d" },
  checkBadgeWarn: { background: "#fef3c7", color: "#b45309" },
  errorBanner: {
    background: "#fee2e2", color: "#991b1b", border: "1px solid #fca5a5",
    borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 16,
  },
  title: { fontSize: 26, fontWeight: 800, color: "#111827", margin: "0 0 8px" },
  desc: { fontSize: 14, color: "#6b7280", margin: "0 0 20px", lineHeight: 1.6 },
  stepsCard: { border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden", marginBottom: 16 },
  stepsHeader: {
    fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.05em",
    background: "#f9fafb", padding: "10px 16px", borderBottom: "1px solid #e5e7eb",
  },
  step: { display: "flex", gap: 14, padding: 16, borderBottom: "1px solid #f3f4f6" },
  stepNum: {
    width: 24, height: 24, borderRadius: "50%", background: "#111827", color: "#fff",
    fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  },
  stepBody: { flex: 1 },
  stepTitleRow: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
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

  /* Buttons / footer */
  darkBtn: {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    background: "#111827", color: "#fff", border: "none", borderRadius: 8,
    padding: "10px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer",
  },
  footerRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
    flexWrap: "wrap", borderTop: "1px solid #f3f4f6", marginTop: 24, paddingTop: 18,
  },
  footerRight: { display: "flex", alignItems: "center", gap: 16 },
  perks: { display: "flex", gap: 28, flexWrap: "wrap", flex: 1, justifyContent: "center" },
  perk: { fontSize: 12, color: "#6b7280" },
  backBtn: {
    background: "#fff", color: "#374151", border: "1px solid #d1d5db",
    borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer",
  },
  laterLink: {
    background: "none", border: "none", padding: 0, cursor: "pointer",
    fontSize: 13, fontWeight: 600, color: "#2563eb",
  },
  continueBtn: {
    background: "#2563eb", color: "#fff", border: "none", borderRadius: 8,
    padding: "9px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer",
  },
  continueBtnOff: { background: "#e5e7eb", color: "#9ca3af", cursor: "not-allowed" },
};
