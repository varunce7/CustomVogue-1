import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getCurrentPlan } from "../utils/billing.server.js";
import { PLANS } from "../utils/plans.js";
import ProductField from "../models/ProductField.js";
import connection from "../db.server.js";

export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const plan = await getCurrentPlan(billing, session.shop);

  if (plan !== PLANS.GROWTH) {
    return { plan, fields: [], fieldCount: 0 };
  }

  await connection;
  const fields = await ProductField.find({ shop: session.shop })
    .sort({ productTitle: 1, sortOrder: 1 })
    .select("productId productTitle displayStyle title titleFont content sortOrder")
    .lean();

  return {
    plan,
    fieldCount: fields.length,
    fields: fields.map((f) => ({
      productId: f.productId,
      productTitle: f.productTitle ?? "",
      displayStyle: f.displayStyle ?? "accordion",
      title: f.title ?? "",
      titleFont: f.titleFont ?? "",
      content: f.content ?? "",
      sortOrder: f.sortOrder ?? 0,
    })),
  };
};

function stripHtml(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

function csvEscape(val) {
  // Always quote every value so LibreOffice/Excel never mis-detect spaces as delimiters.
  const s = String(val ?? "").replace(/"/g, '""');
  return `"${s}"`;
}

function downloadCSV(fields) {
  const header = `"productId","productTitle","displayStyle","fieldTitle","titleFont","content","sortOrder"`;
  const rows = fields.map((f) =>
    [
      csvEscape(f.productId),
      csvEscape(f.productTitle),
      csvEscape(f.displayStyle),
      csvEscape(f.title),
      csvEscape(f.titleFont),
      csvEscape(stripHtml(f.content)),
      csvEscape(f.sortOrder),
    ].join(",")
  );
  // UTF-8 BOM (﻿) tells LibreOffice/Excel to auto-detect comma delimiter.
  const csv = "﻿" + [header, ...rows].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "custom-fields-export.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function ExportPage() {
  const data = useLoaderData();
  const isGrowth = data?.plan === PLANS.GROWTH;

  return (
    <div style={s.page}>
      {/* Back button */}
      <Link to="/app" style={s.backBtn}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M12 5l-7 7 7 7" />
        </svg>
        Back to App
      </Link>

      {/* Hero */}
      <div style={s.hero}>
        <div style={s.heroIcon}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={s.heroTitle}>CSV Export</h1>
          <p style={s.heroDesc}>Download all your custom fields as a CSV file for backup or migration.</p>
        </div>
        <div style={s.heroBadge}>Growth</div>
      </div>

      {!isGrowth ? (
        <div style={s.gateBox}>
          <div style={s.gateIconWrap}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h2 style={s.gateTitle}>Growth Plan Required</h2>
          <p style={s.gateDesc}>CSV Export is available on the Growth plan ($4.99/month). Upgrade to download and back up your custom fields.</p>
          <Link to="/app/billing" style={s.upgradeBtn}>View Plans &amp; Upgrade</Link>
        </div>
      ) : (
        <>
          {/* Stat + Download card */}
          <div style={s.card}>
            <div style={s.statRow}>
              <div style={s.statLeft}>
                <div style={s.statIconWrap}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                </div>
                <div>
                  <div style={s.statLabel}>Total Custom Fields</div>
                  <div style={s.statSub}>Ready to export</div>
                </div>
              </div>
              <div style={s.statBadge}>{data.fieldCount}</div>
            </div>

            <div style={s.divider} />

            {data.fieldCount === 0 ? (
              <div style={s.emptyState}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 8 }}>
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <p style={s.emptyText}>No fields to export yet.</p>
                <p style={s.emptySub}>Add custom fields to your products first, then come back to export.</p>
              </div>
            ) : (
              <button
                onClick={() => downloadCSV(data.fields)}
                style={s.downloadBtn}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download CSV
              </button>
            )}
          </div>

          {/* Format reference card */}
          <div style={s.infoCard}>
            <div style={s.infoHeader}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span style={s.infoTitle}>CSV Format</span>
            </div>
            <code style={s.formatCode}>
              productId, productTitle, displayStyle, fieldTitle, titleFont, content, sortOrder
            </code>
            <p style={s.infoDesc}>
              The <code style={s.inlineCode}>content</code> column contains HTML from the rich text editor.
              Use this file with the{" "}
              <Link to="/app/import" style={s.inlineLink}>CSV Import</Link> feature to migrate fields between stores.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

const s = {
  page: {
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    maxWidth: 700,
    margin: "0 auto",
    padding: "28px 24px 56px",
  },
  backBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: "#6b7280",
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 500,
    marginBottom: 20,
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid #e5e7eb",
    background: "#fff",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
    transition: "border-color 0.15s",
  },
  hero: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    marginBottom: 24,
    padding: "20px 24px",
    background: "linear-gradient(135deg, #1d4ed8 0%, #2563eb 55%, #3b82f6 100%)",
    borderRadius: 14,
    color: "#fff",
    boxShadow: "0 4px 20px rgba(37,99,235,0.3)",
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
    border: "1px solid rgba(255,255,255,0.2)",
  },
  heroTitle: {
    fontSize: 22,
    fontWeight: 700,
    margin: "0 0 3px",
    color: "#fff",
  },
  heroDesc: {
    fontSize: 13,
    margin: 0,
    color: "rgba(255,255,255,0.72)",
  },
  heroBadge: {
    padding: "4px 14px",
    background: "linear-gradient(135deg, #f59e0b, #d97706)",
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: "0.5px",
    flexShrink: 0,
    boxShadow: "0 2px 8px rgba(245,158,11,0.4)",
  },
  card: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    padding: "22px 24px",
    marginBottom: 16,
    boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
  },
  statRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  statLeft: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  statIconWrap: {
    width: 42,
    height: 42,
    background: "#eff6ff",
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  statLabel: {
    fontSize: 14,
    fontWeight: 600,
    color: "#111827",
    marginBottom: 2,
  },
  statSub: {
    fontSize: 12,
    color: "#9ca3af",
  },
  statBadge: {
    fontSize: 28,
    fontWeight: 800,
    color: "#1d4ed8",
    letterSpacing: "-1px",
  },
  divider: {
    height: 1,
    background: "#f3f4f6",
    marginBottom: 20,
  },
  downloadBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    padding: "13px 0",
    background: "linear-gradient(135deg, #1d4ed8, #2563eb)",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 600,
    textDecoration: "none",
    boxShadow: "0 3px 12px rgba(37,99,235,0.35)",
    letterSpacing: "0.2px",
    cursor: "pointer",
  },
  emptyState: {
    textAlign: "center",
    padding: "20px 0 8px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
    fontWeight: 600,
    color: "#374151",
    margin: "0 0 4px",
  },
  emptySub: {
    fontSize: 13,
    color: "#9ca3af",
    margin: 0,
  },
  infoCard: {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "18px 22px",
  },
  infoHeader: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    marginBottom: 12,
  },
  infoTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
  },
  formatCode: {
    display: "block",
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 6,
    padding: "10px 14px",
    fontSize: 12,
    color: "#1d4ed8",
    fontFamily: "'Fira Code', 'Cascadia Code', monospace",
    marginBottom: 12,
    wordBreak: "break-all",
    letterSpacing: "0.2px",
  },
  infoDesc: {
    fontSize: 13,
    color: "#6b7280",
    margin: 0,
    lineHeight: 1.6,
  },
  inlineCode: {
    background: "#f3f4f6",
    border: "1px solid #e5e7eb",
    borderRadius: 3,
    padding: "1px 5px",
    fontFamily: "monospace",
    fontSize: 12,
    color: "#374151",
  },
  inlineLink: {
    color: "#2563eb",
    fontWeight: 500,
    textDecoration: "none",
  },
  gateBox: {
    textAlign: "center",
    padding: "60px 40px",
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
  },
  gateIconWrap: { marginBottom: 16 },
  gateTitle: { fontSize: 20, fontWeight: 700, color: "#111827", marginBottom: 10, margin: "0 0 10px" },
  gateDesc: { fontSize: 14, color: "#6b7280", maxWidth: 420, margin: "0 auto 24px", lineHeight: 1.6 },
  upgradeBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "11px 26px",
    background: "linear-gradient(135deg, #f59e0b, #d97706)",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    textDecoration: "none",
    boxShadow: "0 3px 10px rgba(245,158,11,0.35)",
  },
};
