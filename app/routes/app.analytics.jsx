import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopAnalytics } from "../utils/analytics.server.js";
import { getCurrentPlan } from "../utils/billing.server.js";
import { PLANS } from "../utils/plans.js";

export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const plan = await getCurrentPlan(billing, session.shop);
  if (plan !== PLANS.GROWTH) return { plan, stats: null };
  const stats = await getShopAnalytics(session.shop);
  return { plan, stats };
};

// ── Donut chart (pure SVG, no deps) ─────────────────────────────────────────
function DonutChart({ segments, size = 160, thickness = 24, label, sublabel }) {
  const r = size / 2 - thickness / 2;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * r;
  const total = segments.reduce((s, g) => s + (g.value || 0), 0) || 1;
  let rot = -90;

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ display: "block" }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f0f0f0" strokeWidth={thickness} />
        {segments.filter(g => g.value > 0).map((g, i) => {
          const pct = g.value / total;
          const dash = pct * C;
          const el = (
            <circle
              key={i}
              cx={cx} cy={cy} r={r}
              fill="none"
              stroke={g.color}
              strokeWidth={thickness}
              strokeDasharray={`${dash} ${C}`}
              strokeLinecap="butt"
              transform={`rotate(${rot} ${cx} ${cy})`}
            />
          );
          rot += pct * 360;
          return el;
        })}
      </svg>
      {label !== undefined && (
        <div style={{
          position: "absolute", top: "50%", left: "50%",
          transform: "translate(-50%,-50%)", textAlign: "center", pointerEvents: "none",
        }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#111827", lineHeight: 1 }}>{label}</div>
          {sublabel && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3 }}>{sublabel}</div>}
        </div>
      )}
    </div>
  );
}

function Legend({ items }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, justifyContent: "center" }}>
      {items.map((item, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 12, height: 12, borderRadius: 3, background: item.color, flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "#374151", flex: 1 }}>{item.label}</span>
          <span style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{item.value}</span>
          <span style={{ fontSize: 12, color: "#9ca3af", minWidth: 34, textAlign: "right" }}>{item.pct}%</span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ text = "No data yet." }) {
  return (
    <div style={s.empty}>
      <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>{text}</p>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function AnalyticsPage() {
  const { plan, stats } = useLoaderData();

  if (plan !== PLANS.GROWTH) {
    return (
      <div style={s.page}>
        <Link to="/app" style={s.backLink}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
          Back to App
        </Link>
        <div style={s.gateBox}>
          <div style={{ marginBottom: 16 }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h2 style={s.gateTitle}>Growth Plan Required</h2>
          <p style={s.gateDesc}>Analytics is available on the Growth plan ($4.99/month). Unlock field usage, shopper interactions, title insights, and more.</p>
          <Link to="/app/billing" style={s.upgradeBtn}>View Plans &amp; Upgrade</Link>
        </div>
      </div>
    );
  }

  const {
    totalFields, totalProducts, avgFieldsPerProduct,
    fieldsThisMonth, fieldsLast7Days, monthGrowth,
    top10, fieldDistribution, displayStyles,
    topClicked, totalClicks,
    topTitles, topProductClicks,
  } = stats;

  const maxTop10 = top10.length > 0 ? top10[0].count : 1;
  const maxClicks = topClicked.length > 0 ? topClicked[0].count : 1;
  const maxTitles = topTitles.length > 0 ? topTitles[0].productCount : 1;
  const maxProdClicks = topProductClicks.length > 0 ? topProductClicks[0].clicks : 1;

  const accordionCount = displayStyles.accordion ?? 0;
  const tabsCount = displayStyles.tabs ?? 0;
  const totalStyle = accordionCount + tabsCount;
  const totalStyleDenom = totalStyle || 1;

  // Donut: display style
  const styleSegments = [
    { label: "Accordion", value: accordionCount, color: "#2563eb" },
    { label: "Tabs", value: tabsCount, color: "#7c3aed" },
  ];

  // Donut: field distribution buckets
  const distEntries = Object.entries(fieldDistribution);
  const distColors = ["#2563eb", "#059669", "#d97706", "#0891b2", "#7c3aed", "#e11d48"];
  const distTotal = distEntries.reduce((s, [, c]) => s + c, 0);
  const distTotalDenom = distTotal || 1;
  const distSegments = distEntries.map(([label, count], i) => ({
    label: `${label} field${label !== "1" ? "s" : ""}`,
    value: count,
    color: distColors[i % distColors.length],
  }));

  const kpis = [
    { val: totalProducts, lbl: "Products with fields", color: "#2563eb", bg: "#eff6ff", icon: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" },
    { val: totalFields, lbl: "Total custom fields", color: "#7c3aed", bg: "#f5f3ff", icon: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" },
    { val: avgFieldsPerProduct, lbl: "Avg fields / product", color: "#059669", bg: "#f0fdf4", icon: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 11l3 3 3-3M12 7v7" },
    { val: fieldsThisMonth, lbl: "Added this month", color: "#d97706", bg: "#fff7ed", sub: monthGrowth !== null ? `${monthGrowth >= 0 ? "+" : ""}${monthGrowth}% vs last month` : null, subColor: monthGrowth >= 0 ? "#16a34a" : "#dc2626", icon: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z" },
    { val: fieldsLast7Days, lbl: "Added last 7 days", color: "#0891b2", bg: "#ecfeff", icon: "M13 2L3 14h9l-1 8 10-12h-9l1-8z" },
    { val: totalClicks, lbl: "Shopper interactions", color: "#e11d48", bg: "#fff1f2", icon: "M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5" },
  ];

  return (
    <div style={s.page}>
      <Link to="/app" style={s.backLink}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M12 5l-7 7 7 7" />
        </svg>
        Back to App
      </Link>

      {/* Hero */}
      <div style={s.hero}>
        <div style={s.heroIcon}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={s.heroTitle}>Analytics Dashboard</h1>
          <p style={s.heroDesc}>Field usage, shopper behaviour, and title insights across your store.</p>
        </div>
        <div style={s.heroBadge}>Growth</div>
      </div>

      {/* KPI row */}
      <div style={s.kpiRow}>
        {kpis.map((k, i) => (
          <div key={i} style={s.kpiCard}>
            <div style={{ ...s.kpiIcon, background: k.bg, color: k.color }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d={k.icon} />
              </svg>
            </div>
            <div style={{ ...s.kpiValue, color: k.color }}>{k.val}</div>
            <div style={s.kpiLabel}>{k.lbl}</div>
            {k.sub && <div style={{ ...s.kpiSub, color: k.subColor }}>{k.sub}</div>}
          </div>
        ))}
      </div>

      {/* ── Donut charts row ── */}
      <div style={s.twoCol}>
        {/* Display style donut */}
        <div style={s.card}>
          <div style={s.cardHeader}>
            <div style={{ ...s.cardIconWrap, background: "#eff6ff" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <h2 style={s.cardTitle}>Display style breakdown</h2>
              <p style={s.cardHint}>How merchants have configured their product field display.</p>
            </div>
          </div>
          <div style={s.donutRow}>
            <DonutChart
              segments={styleSegments}
              size={160}
              thickness={26}
              label={totalStyle}
              sublabel="products"
            />
            <Legend items={styleSegments.map(g => ({
              ...g,
              pct: Math.round((g.value / totalStyleDenom) * 100),
            }))} />
          </div>
        </div>

        {/* Field distribution donut */}
        <div style={s.card}>
          <div style={s.cardHeader}>
            <div style={{ ...s.cardIconWrap, background: "#ecfeff" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0891b2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><polyline points="8 12 12 16 16 12" /><line x1="12" y1="8" x2="12" y2="16" />
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <h2 style={s.cardTitle}>Fields per product distribution</h2>
              <p style={s.cardHint}>How many fields each product has configured.</p>
            </div>
          </div>
          <div style={s.donutRow}>
            <DonutChart
              segments={distSegments}
              size={160}
              thickness={26}
              label={distTotal}
              sublabel="products"
            />
            <Legend items={distSegments.map(g => ({
              ...g,
              pct: Math.round((g.value / distTotalDenom) * 100),
            }))} />
          </div>
        </div>
      </div>

      {/* Most reused field titles */}
      <div style={s.card}>
        <div style={s.cardHeader}>
          <div style={{ ...s.cardIconWrap, background: "#eff6ff" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <h2 style={s.cardTitle}>Most reused field titles</h2>
            <p style={s.cardHint}>Which field names appear across the most products — revealing your most common content patterns.</p>
          </div>
          <span style={s.cardBadge}>{topTitles.length} unique titles</span>
        </div>
        {topTitles.length === 0 ? <EmptyState /> : (
          <div style={s.barList}>
            {topTitles.map((t, i) => {
              const maxPc = topTitles[0].productCount || 1;
              return (
                <div key={t.title} style={{ ...s.barRow, gridTemplateColumns: "130px 1fr 130px", gap: 16 }}>
                  <div style={s.barLeft}>
                    <div style={s.rankBadge}>{i + 1}</div>
                    <div style={s.barLabel} title={t.title}>{t.title}</div>
                  </div>
                  <div style={s.barTrack}>
                    <div style={{ ...s.barFill, width: `${Math.round((t.productCount / maxPc) * 100)}%`, background: "linear-gradient(90deg,#2563eb,#60a5fa)" }} />
                  </div>
                  <div style={{ ...s.barRight, gap: 3 }}>
                    <span style={{ ...s.barNum, fontSize: 13 }}>{t.productCount}</span>
                    <span style={{ ...s.barUnit, fontSize: 11 }}>products</span>
                    <span style={{ color: "#d1d5db", fontSize: 11 }}>·</span>
                    <span style={{ fontSize: 11, color: "#9ca3af", whiteSpace: "nowrap" }}>{t.totalInstances} instances</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Most expanded fields */}
      <div style={s.card}>
        <div style={s.cardHeader}>
          <div style={{ ...s.cardIconWrap, background: "#f5f3ff" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5" />
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <h2 style={s.cardTitle}>Most expanded fields</h2>
            <p style={s.cardHint}>Fields shoppers click or expand most on your storefront — shows which content drives the most curiosity.</p>
          </div>
          <span style={{ ...s.cardBadge, background: "#f5f3ff", color: "#7c3aed", borderColor: "#ddd6fe" }}>
            {totalClicks.toLocaleString()} interactions
          </span>
        </div>
        {topClicked.length === 0 ? (
          <div style={s.empty}>
            <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>No interactions yet. Data appears once shoppers expand accordion items or click tabs on your storefront.</p>
          </div>
        ) : (
          <div style={s.barList}>
            {topClicked.map((item, i) => (
              <div key={item.fieldId} style={{ ...s.barRow, gridTemplateColumns: "130px 1fr 90px", gap: 16 }}>
                <div style={s.barLeft}>
                  <div style={s.rankBadge}>{i + 1}</div>
                  <div style={s.barLabel} title={item.fieldTitle || item.fieldId}>{item.fieldTitle || item.fieldId}</div>
                </div>
                <div style={s.barTrack}>
                  <div style={{ ...s.barFill, width: `${Math.round((item.count / maxClicks) * 100)}%`, background: "linear-gradient(90deg,#7c3aed,#a78bfa)" }} />
                </div>
                <div style={s.barRight}>
                  <span style={s.barNum}>{item.count}</span>
                  <span style={s.barUnit}>clicks</span>
                  {item.expandCount > 0 && <span style={s.expandTag}>▶ {item.expandCount}</span>}
                  {item.tabCount > 0 && <span style={s.tabTag}>⊞ {item.tabCount}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={s.twoCol}>
        {/* Top products by field count */}
        <div style={s.card}>
          <div style={s.cardHeader}>
            <div style={{ ...s.cardIconWrap, background: "#f0fdf4" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
              </svg>
            </div>
            <h2 style={s.cardTitle}>Top products by field count</h2>
          </div>
          {top10.length === 0 ? <EmptyState /> : (
            <div style={s.barList}>
              {top10.map((p, i) => (
                <div key={p.id} style={s.barRow}>
                  <div style={s.barLeft}>
                    <div style={s.rankBadge}>{i + 1}</div>
                    <div style={s.barLabel} title={p.title}>{p.title}</div>
                  </div>
                  <div style={s.barTrack}>
                    <div style={{ ...s.barFill, width: `${Math.round((p.count / maxTop10) * 100)}%`, background: "linear-gradient(90deg,#059669,#34d399)" }} />
                  </div>
                  <div style={s.barRight}>
                    <span style={s.barNum}>{p.count}</span>
                    <span style={s.barUnit}>fields</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Most interactive products */}
        <div style={s.card}>
          <div style={s.cardHeader}>
            <div style={{ ...s.cardIconWrap, background: "#fff7ed" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <h2 style={s.cardTitle}>Most interactive products</h2>
              <p style={s.cardHint}>Product pages with the most shopper clicks on their custom fields.</p>
            </div>
          </div>
          {topProductClicks.length === 0 ? <EmptyState text="No interaction data yet." /> : (
            <div style={s.barList}>
              {topProductClicks.map((p, i) => (
                <div key={p.productId} style={s.barRow}>
                  <div style={s.barLeft}>
                    <div style={s.rankBadge}>{i + 1}</div>
                    <div style={s.barLabel} title={p.title}>{p.title}</div>
                  </div>
                  <div style={s.barTrack}>
                    <div style={{ ...s.barFill, width: `${Math.round((p.clicks / maxProdClicks) * 100)}%`, background: "linear-gradient(90deg,#d97706,#fbbf24)" }} />
                  </div>
                  <div style={s.barRight}>
                    <span style={s.barNum}>{p.clicks}</span>
                    <span style={s.barUnit}>clicks</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Summary */}
      <div style={s.card}>
        <div style={s.cardHeader}>
          <div style={{ ...s.cardIconWrap, background: "#fff7ed" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h2 style={s.cardTitle}>Summary</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 32px" }}>
          {[
            { lbl: "Total products", val: totalProducts },
            { lbl: "Total fields", val: totalFields },
            { lbl: "Avg. fields / product", val: avgFieldsPerProduct },
            { lbl: "Added this month", val: fieldsThisMonth },
            { lbl: "Added last 7 days", val: fieldsLast7Days },
            { lbl: "Unique field titles", val: topTitles.length },
            { lbl: "Shopper clicks", val: totalClicks },
          ].map((row) => (
            <div key={row.lbl} style={s.summaryRow}>
              <span style={s.summaryLbl}>{row.lbl}</span>
              <span style={s.summaryVal}>{row.val}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const s = {
  page: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    maxWidth: 1040, margin: "0 auto", padding: "28px 24px 56px",
  },
  backLink: {
    display: "inline-flex", alignItems: "center", gap: 6,
    color: "#6b7280", textDecoration: "none", fontSize: 13, fontWeight: 500, cursor: "pointer", marginBottom: 24,
    marginBottom: 20, padding: "6px 12px", borderRadius: 8,
    border: "1px solid #e5e7eb", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },
  hero: {
    display: "flex", alignItems: "center", gap: 16, marginBottom: 24,
    padding: "20px 24px",
    background: "linear-gradient(135deg,#1d4ed8 0%,#2563eb 55%,#3b82f6 100%)",
    borderRadius: 14, color: "#fff", boxShadow: "0 4px 20px rgba(37,99,235,0.3)",
  },
  heroIcon: {
    width: 52, height: 52, background: "rgba(255,255,255,0.15)", borderRadius: 12,
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0, border: "1px solid rgba(255,255,255,0.2)",
  },
  heroTitle: { fontSize: 22, fontWeight: 700, margin: "0 0 3px", color: "#fff" },
  heroDesc: { fontSize: 13, margin: 0, color: "rgba(255,255,255,0.75)" },
  heroBadge: {
    padding: "4px 14px", background: "linear-gradient(135deg,#f59e0b,#d97706)",
    borderRadius: 20, fontSize: 11, fontWeight: 700, color: "#fff",
    flexShrink: 0, boxShadow: "0 2px 8px rgba(245,158,11,0.4)",
  },
  kpiRow: { display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 12, marginBottom: 20 },
  kpiCard: {
    background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
    padding: "16px 14px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
  },
  kpiIcon: {
    width: 34, height: 34, borderRadius: 8,
    display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 10,
  },
  kpiValue: { fontSize: 28, fontWeight: 800, lineHeight: 1, marginBottom: 4 },
  kpiLabel: { fontSize: 12, color: "#6b7280", lineHeight: 1.4 },
  kpiSub: { fontSize: 11, fontWeight: 600, marginTop: 4 },

  card: {
    background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14,
    padding: "22px 24px", marginBottom: 16, boxShadow: "0 1px 6px rgba(0,0,0,0.05)",
  },
  cardHeader: { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 },
  cardIconWrap: {
    width: 34, height: 34, borderRadius: 8, marginTop: 2,
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  cardTitle: { fontSize: 15, fontWeight: 700, color: "#111827", margin: "0 0 3px" },
  cardHint: { fontSize: 12, color: "#9ca3af", margin: 0, lineHeight: 1.5 },
  cardBadge: {
    fontSize: 12, fontWeight: 600, color: "#2563eb",
    background: "#eff6ff", border: "1px solid #bfdbfe",
    borderRadius: 20, padding: "4px 12px", flexShrink: 0, whiteSpace: "nowrap",
  },

  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 0 },

  donutRow: { display: "flex", alignItems: "center", gap: 32, padding: "8px 0" },

  barList: { display: "flex", flexDirection: "column", gap: 8 },
  barRow: {
    display: "grid", gridTemplateColumns: "24% 1fr auto",
    alignItems: "center", gap: 12,
    padding: "10px 16px", borderRadius: 10,
    background: "#f9fafb", border: "1px solid #f3f4f6",
  },
  barLeft: {
    display: "flex", alignItems: "center", gap: 8, minWidth: 0,
  },
  rankBadge: {
    width: 22, height: 22, borderRadius: 6, background: "#e5e7eb",
    color: "#6b7280", fontSize: 10, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  barLabel: {
    flex: 1, minWidth: 0, fontSize: 12, fontWeight: 500, color: "#111827",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  barTrack: { height: 10, background: "#e5e7eb", borderRadius: 6, overflow: "hidden", minWidth: 0 },
  barFill: { height: "100%", borderRadius: 6, transition: "width 0.4s ease" },
  barRight: { display: "flex", alignItems: "center", flexWrap: "nowrap", gap: 4, justifyContent: "flex-end" },
  barNum: { fontSize: 14, fontWeight: 700, color: "#111827" },
  barUnit: { fontSize: 12, color: "#6b7280" },
  barDot: { fontSize: 12, color: "#d1d5db", margin: "0 2px" },
  expandTag: {
    fontSize: 10, color: "#7c3aed", background: "#ede9fe",
    borderRadius: 4, padding: "2px 6px", fontWeight: 600, whiteSpace: "nowrap", marginLeft: 4,
  },
  tabTag: {
    fontSize: 10, color: "#0891b2", background: "#cffafe",
    borderRadius: 4, padding: "2px 6px", fontWeight: 600, whiteSpace: "nowrap",
  },

  empty: {
    display: "flex", flexDirection: "column", alignItems: "center",
    textAlign: "center", padding: "24px 16px",
    background: "#f9fafb", borderRadius: 8, border: "1px dashed #e5e7eb",
  },

  summaryRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "9px 0", borderBottom: "1px solid #f3f4f6",
  },
  summaryLbl: { fontSize: 13, color: "#6b7280" },
  summaryVal: { fontSize: 14, fontWeight: 700, color: "#111827" },

  gateBox: { textAlign: "center", padding: "60px 40px", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 14 },
  gateTitle: { fontSize: 20, fontWeight: 700, color: "#111827", margin: "0 0 10px" },
  gateDesc: { fontSize: 14, color: "#6b7280", maxWidth: 400, margin: "0 auto 24px", lineHeight: 1.6 },
  upgradeBtn: {
    display: "inline-flex", alignItems: "center", gap: 8,
    padding: "11px 26px", background: "linear-gradient(135deg,#f59e0b,#d97706)",
    color: "#fff", borderRadius: 8, fontSize: 14, fontWeight: 600, textDecoration: "none",
    boxShadow: "0 3px 10px rgba(245,158,11,0.35)",
  },
};
