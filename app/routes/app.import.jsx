import { useRef, useState } from "react";
import { Link, useFetcher, useLoaderData } from "react-router";
import { useBusyTimeout } from "../hooks/useBusyTimeout";
import { authenticate } from "../shopify.server";
import { getCachedPlan, getCurrentPlan } from "../utils/billing.server.js";
import { PLANS } from "../utils/plans.js";
import { saveProductFields } from "../utils/productFields.server.js";
import { mapWithConcurrency, writeAccordionMetafieldsBatch } from "../utils/metafield.server.js";

// Parallel Mongo writes / lookups per request. High enough to hide round-trip
// latency, low enough not to exhaust the connection pool.
const DB_CONCURRENCY = 8;

export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const plan = await getCurrentPlan(billing, session.shop);
  return { plan };
};

export const action = async ({ request }) => {
  const { session, admin, billing } = await authenticate.admin(request);
  const plan = getCachedPlan(session.shop) ?? await getCurrentPlan(billing, session.shop);

  if (plan !== PLANS.GROWTH) {
    return { error: "CSV Import requires the Growth plan." };
  }

  const formData = await request.formData();
  const csvText = formData.get("csv")?.toString() ?? "";

  if (!csvText.trim()) {
    return { error: "No CSV content received." };
  }

  const allRows = parseCSV(csvText);
  if (allRows.length < 2) {
    return { error: "CSV must have a header row and at least one data row." };
  }

  const EXPECTED_HEADERS = ["productId", "productTitle", "displayStyle", "fieldTitle", "titleFont", "content", "sortOrder"];
  const actualHeaders = allRows[0].map((h) => h.trim().toLowerCase());
  const headersMatch = EXPECTED_HEADERS.length === actualHeaders.length &&
    EXPECTED_HEADERS.every((h, i) => actualHeaders[i] === h.toLowerCase());
  if (!headersMatch) {
    return {
      error: `Invalid CSV format. Expected columns: ${EXPECTED_HEADERS.join(", ")} — make sure you're using a CSV exported from this app.`,
    };
  }

  const badRows = allRows.slice(1).filter((row) => row.some((c) => c.trim()) && row.length !== 7);
  if (badRows.length > 0) {
    return {
      error: `${badRows.length} row(s) have an unexpected number of columns. This CSV may have been edited outside the app or exported from a different tool — please use a CSV downloaded from the Export page.`,
    };
  }

  const byProduct = new Map();

  for (let i = 1; i < allRows.length; i++) {
    const cols = allRows[i];
    if (cols.length !== 7) continue;

    const [productId, productTitle, displayStyle, fieldTitle, titleFont, content, sortOrderRaw] = cols;
    if (!productId || !fieldTitle) continue;

    if (!byProduct.has(productId)) {
      byProduct.set(productId, { productTitle: productTitle || productId, displayStyle: displayStyle || "accordion", fields: [] });
    }
    byProduct.get(productId).fields.push({
      shop: session.shop,
      productId,
      productTitle: productTitle || productId,
      title: fieldTitle,
      titleFont: titleFont || "",
      content: content || "",
      sortOrder: parseInt(sortOrderRaw, 10) || 0,
      displayStyle: displayStyle || "accordion",
    });
  }

  if (byProduct.size === 0) {
    return { error: "No valid rows found in the CSV." };
  }

  // Each product must use a single display style — mixing accordion + tabs rows for the same product is not allowed.
  const mixedStyleProducts = [];
  for (const [, { productTitle, fields }] of byProduct) {
    const styles = new Set(fields.map((f) => f.displayStyle.trim().toLowerCase()));
    if (styles.size > 1) {
      mixedStyleProducts.push(productTitle);
    }
  }
  if (mixedStyleProducts.length > 0) {
    return {
      error:
        `Mixed display styles found in the same product. All fields for a product must use the same displayStyle — either "accordion" or "tabs", not both.\n\nAffected products: ${mixedStyleProducts.join(", ")}\n\nFix: In your CSV, make sure every row for the same productId has the same value in the displayStyle column.`,
    };
  }

  // Resolve any handles to GIDs in parallel rather than one lookup at a time.
  // Ensure productId is a Shopify GID — handles (e.g. "my-product") are invalid as ownerId.
  const resolved = await mapWithConcurrency(
    [...byProduct.entries()],
    DB_CONCURRENCY,
    async ([productId, { fields }]) => {
      if (productId.startsWith("gid://shopify/Product/")) return { gid: productId, fields };

      const gid = await resolveProductGid(admin, productId);
      if (!gid) return null;
      // Update all field records to use the resolved GID.
      fields.forEach((f) => { f.productId = gid; });
      return { gid, fields };
    },
  );

  const found = resolved.filter(Boolean);
  const skipped = resolved.length - found.length;

  // Database writes in parallel; saveProductFields returns the stored docs, so
  // the metafield write no longer re-reads them from Mongo.
  const saved = await mapWithConcurrency(found, DB_CONCURRENCY, async ({ gid, fields }) => ({
    productId: gid,
    docs: await saveProductFields(gid, session.shop, fields),
  }));

  // One batched sync for every product instead of a request each.
  await writeAccordionMetafieldsBatch(admin, saved);
  const imported = saved.length;

  if (imported === 0 && skipped > 0) {
    return { error: `No products could be imported — ${skipped} product ID(s) in the CSV were not found in your Shopify store. Make sure the CSV was exported from this app.` };
  }

  return { success: true, imported, skipped };
};

// Look up a product's GID by handle (used when the CSV contains a handle instead of a GID).
async function resolveProductGid(admin, handle) {
  try {
    const res = await admin.graphql(
      `#graphql
      query getProductByHandle($handle: String!) {
        productByHandle(handle: $handle) { id }
      }`,
      { variables: { handle } }
    );
    const json = await res.json();
    return json.data?.productByHandle?.id ?? null;
  } catch {
    return null;
  }
}

// RFC 4180-compliant parser: handles quoted fields that contain commas, newlines, and escaped quotes.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        row.push(field);
        field = "";
        i++;
      } else if (ch === "\r" && text[i + 1] === "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        i += 2;
      } else if (ch === "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  // Flush the last field / row
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);

  return rows;
}

export default function ImportPage() {
  const { plan } = useLoaderData();
  const fetcher = useFetcher();
  const fileRef = useRef(null);
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState(null);

  const isGrowth = plan === PLANS.GROWTH;
  const isSubmitting = useBusyTimeout(fetcher.state === "submitting");
  const result = fetcher.data;
  const hasFile = !!fileName;

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    readFile(file);
  };

  const EXPECTED_HEADERS = ["productid", "producttitle", "displaystyle", "fieldtitle", "titlefont", "content", "sortorder"];

  const readFile = (file) => {
    if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
      setFileError("Only .csv files are accepted.");
      setFileName(null);
      setCsvText("");
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result ?? "";
      const firstLine = text.split(/\r?\n/)[0] ?? "";
      const headers = firstLine.split(",").map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());

      if (headers.length !== EXPECTED_HEADERS.length || !EXPECTED_HEADERS.every((h, i) => headers[i] === h)) {
        setFileError(
          `Wrong CSV format. Expected columns: productId, productTitle, displayStyle, fieldTitle, titleFont, content, sortOrder`
        );
        setFileName(null);
        setCsvText("");
        if (fileRef.current) fileRef.current.value = "";
        return;
      }

      // Quick structural check: count commas in a few data lines (outside quotes)
      const lines = text.split(/\r?\n/).slice(1).filter((l) => l.trim());
      const badLine = lines.find((line) => {
        let inQ = false;
        let cols = 1;
        for (let i = 0; i < line.length; i++) {
          if (line[i] === '"') { inQ = !inQ; }
          else if (line[i] === "," && !inQ) { cols++; }
        }
        return cols !== 7;
      });
      if (badLine !== undefined) {
        setFileError(
          "This CSV has rows with an unexpected number of columns. Please use a CSV downloaded from the Export page."
        );
        setFileName(null);
        setCsvText("");
        if (fileRef.current) fileRef.current.value = "";
        return;
      }

      // Mixed displayStyle check: all rows for the same productId must share one style.
      const stylesByProduct = new Map();
      const titleByProduct = new Map();
      for (const line of lines) {
        // Simple split (values are quoted; strip outer quotes for this check)
        const cols = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.replace(/^"|"$/g, ""));
        if (cols.length !== 7) continue;
        const [pid, ptitle, dStyle] = cols;
        if (!pid || !dStyle) continue;
        const style = dStyle.trim().toLowerCase();
        if (!stylesByProduct.has(pid)) {
          stylesByProduct.set(pid, new Set());
          titleByProduct.set(pid, ptitle || pid);
        }
        stylesByProduct.get(pid).add(style);
      }
      const mixedProducts = [...stylesByProduct.entries()]
        .filter(([, styles]) => styles.size > 1)
        .map(([pid]) => titleByProduct.get(pid) || pid);
      if (mixedProducts.length > 0) {
        setFileError(
          `Mixed displayStyle found for ${mixedProducts.length > 1 ? "these products" : "this product"}: ${mixedProducts.join(", ")}.\n\nAll rows for the same product must use the same displayStyle — either "accordion" or "tabs", not both. Fix the CSV and re-upload.`
        );
        setFileName(null);
        setCsvText("");
        if (fileRef.current) fileRef.current.value = "";
        return;
      }

      setFileError(null);
      setFileName(file.name);
      setCsvText(text);
    };
    reader.readAsText(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFile(file);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!csvText.trim()) return;
    setFileError(null);
    const fd = new FormData();
    fd.append("csv", csvText);
    fetcher.submit(fd, { method: "post" });
  };

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
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={s.heroTitle}>CSV Import</h1>
          <p style={s.heroDesc}>Upload a CSV to create or overwrite custom fields across multiple products at once.</p>
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
          <p style={s.gateDesc}>CSV Import is available on the Growth plan ($4.99/month). Upgrade to bulk-import custom fields from a CSV file.</p>
          <Link to="/app/billing" style={s.upgradeBtn}>View Plans &amp; Upgrade</Link>
        </div>
      ) : (
        <>
          {/* Banners */}
          {fileError && (
            <div style={s.errorBanner}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {fileError}
            </div>
          )}
          {result?.success && (
            <div style={s.successBanner}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              Imported fields for {result.imported} product{result.imported !== 1 ? "s" : ""} successfully!
            </div>
          )}
          {result?.error && (
            <div style={s.errorBanner}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {result.error}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            {/* Drop zone card */}
            <div style={s.card}>
              <div style={s.cardHeader}>
                <div style={s.stepBadge}>1</div>
                <span style={s.cardTitle}>Select your CSV file</span>
              </div>

              <div
                style={{
                  ...s.dropZone,
                  ...(dragging ? s.dropZoneDrag : {}),
                  ...(hasFile ? s.dropZoneActive : {}),
                }}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
              >
                {hasFile ? (
                  <>
                    <div style={s.fileIconWrap}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    </div>
                    <span style={s.fileNameText}>{fileName}</span>
                    <span style={s.fileReadyBadge}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      Ready to import
                    </span>
                    <span style={s.changeFile}>Click to change file</span>
                  </>
                ) : (
                  <>
                    <div style={s.uploadIconWrap}>
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={dragging ? "#2563eb" : "#9ca3af"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                    </div>
                    <span style={s.dropText}>{dragging ? "Drop it here!" : "Click to select or drag & drop"}</span>
                    <span style={s.dropSub}>Accepts .csv files only</span>
                  </>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
                style={{ display: "none" }}
              />
            </div>

            {/* Submit card */}
            <div style={{ ...s.card, ...(hasFile ? {} : s.cardDimmed) }}>
              <div style={s.cardHeader}>
                <div style={{ ...s.stepBadge, ...(hasFile ? s.stepBadgeDone : {}) }}>
                  {hasFile ? (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : "2"}
                </div>
                <span style={s.cardTitle}>Import fields</span>
              </div>
              <p style={s.cardDesc}>
                Importing will <strong>overwrite</strong> any existing custom fields for the products in the CSV. Other products are not affected.
              </p>
              <button
                type="submit"
                style={{ ...s.importBtn, ...(!csvText.trim() || isSubmitting ? s.importBtnDisabled : {}) }}
                disabled={!csvText.trim() || isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite" }}>
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                    Importing…
                  </>
                ) : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    Import Fields
                  </>
                )}
              </button>
            </div>
          </form>

          {/* Format reference */}
          <div style={s.infoCard}>
            <div style={s.infoHeader}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span style={s.infoTitle}>Expected CSV Format</span>
            </div>
            <code style={s.formatCode}>
              productId, productTitle, displayStyle, fieldTitle, titleFont, content, sortOrder
            </code>
            <ul style={s.noteList}>
              <li><code style={s.inlineCode}>displayStyle</code>: <code style={s.inlineCode}>accordion</code> or <code style={s.inlineCode}>tabs</code> — all rows for the same product must use the same value</li>
              <li><code style={s.inlineCode}>content</code>: HTML allowed (from rich text editor)</li>
              <li>Importing a product will overwrite its existing fields</li>
            </ul>
            <Link to="/app/export" style={s.exportLink}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download your current fields as a template
            </Link>
          </div>
        </>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
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
  successBanner: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "#d1fae5",
    color: "#065f46",
    border: "1px solid #6ee7b7",
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 500,
    marginBottom: 16,
  },
  errorBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    background: "#fee2e2",
    color: "#991b1b",
    border: "1px solid #fca5a5",
    borderRadius: 10,
    padding: "12px 16px",
    whiteSpace: "pre-line",
    fontSize: 14,
    marginBottom: 16,
  },
  card: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    padding: "22px 24px",
    marginBottom: 16,
    boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
  },
  cardDimmed: {
    opacity: 0.55,
    pointerEvents: "none",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
  },
  stepBadge: {
    width: 26,
    height: 26,
    borderRadius: "50%",
    background: "#e5e7eb",
    color: "#6b7280",
    fontSize: 12,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  stepBadgeDone: {
    background: "#22c55e",
    color: "#fff",
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: "#111827",
  },
  cardDesc: {
    fontSize: 13,
    color: "#6b7280",
    margin: "0 0 16px",
    lineHeight: 1.6,
  },
  dropZone: {
    border: "2px dashed #d1d5db",
    borderRadius: 10,
    padding: "40px 24px",
    textAlign: "center",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
    transition: "all 0.2s",
    background: "#fafafa",
  },
  dropZoneDrag: {
    borderColor: "#2563eb",
    background: "#eff6ff",
  },
  dropZoneActive: {
    borderColor: "#22c55e",
    background: "#f0fdf4",
  },
  uploadIconWrap: {
    width: 56,
    height: 56,
    background: "#f3f4f6",
    borderRadius: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  fileIconWrap: {
    width: 56,
    height: 56,
    background: "#eff6ff",
    borderRadius: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  dropText: {
    fontSize: 15,
    fontWeight: 600,
    color: "#374151",
  },
  dropSub: {
    fontSize: 12,
    color: "#9ca3af",
  },
  fileNameText: {
    fontSize: 14,
    fontWeight: 700,
    color: "#1d4ed8",
  },
  fileReadyBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 10px",
    background: "#d1fae5",
    color: "#065f46",
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 600,
  },
  changeFile: {
    fontSize: 11,
    color: "#9ca3af",
    marginTop: 4,
  },
  importBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 28px",
    background: "linear-gradient(135deg, #1d4ed8, #2563eb)",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "0 3px 12px rgba(37,99,235,0.35)",
  },
  importBtnDisabled: {
    background: "#e5e7eb",
    color: "#9ca3af",
    cursor: "not-allowed",
    boxShadow: "none",
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
  noteList: {
    fontSize: 13,
    color: "#6b7280",
    margin: "0 0 14px",
    paddingLeft: 20,
    lineHeight: 1.9,
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
  exportLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
    color: "#2563eb",
    textDecoration: "none",
    fontWeight: 500,
  },
  gateBox: {
    textAlign: "center",
    padding: "60px 40px",
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
  },
  gateIconWrap: { marginBottom: 16 },
  gateTitle: { fontSize: 20, fontWeight: 700, color: "#111827", margin: "0 0 10px" },
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
