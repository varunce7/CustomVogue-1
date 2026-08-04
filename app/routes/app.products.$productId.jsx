import { useCallback, useEffect, useRef, useState } from "react";
import { Link, redirect, useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getCurrentPlan } from "../utils/billing.server.js";
import { writeAccordionMetafield } from "../utils/metafield.server";
import { FREE_PLAN_LIMITS, PLANS } from "../utils/plans.js";
import { getProductFields, saveProductFields } from "../utils/productFields.server.js";
import { getExistingProducts } from "../utils/products.server.js";

// 22 font families — value = Quill CSS class key, css = actual font-family stack
const FONTS = [
  { value: "arial", label: "Arial", css: "Arial, sans-serif" },
  { value: "times-new-roman", label: "Times New Roman", css: "'Times New Roman', Times, serif" },
  { value: "georgia", label: "Georgia", css: "Georgia, serif" },
  { value: "verdana", label: "Verdana", css: "Verdana, Geneva, sans-serif" },
  { value: "helvetica", label: "Helvetica", css: "Helvetica, Arial, sans-serif" },
  { value: "courier-new", label: "Courier New", css: "'Courier New', Courier, monospace" },
  { value: "trebuchet-ms", label: "Trebuchet MS", css: "'Trebuchet MS', sans-serif" },
  { value: "impact", label: "Impact", css: "Impact, Haettenschweiler, sans-serif" },
  { value: "comic-sans-ms", label: "Comic Sans MS", css: "'Comic Sans MS', cursive" },
  { value: "garamond", label: "Garamond", css: "Garamond, serif" },
  { value: "tahoma", label: "Tahoma", css: "Tahoma, Geneva, sans-serif" },
  { value: "palatino", label: "Palatino", css: "'Palatino Linotype', Palatino, serif" },
  { value: "book-antiqua", label: "Book Antiqua", css: "'Book Antiqua', Palatino, serif" },
  { value: "calibri", label: "Calibri", css: "Calibri, sans-serif" },
  { value: "cambria", label: "Cambria", css: "Cambria, Georgia, serif" },
  { value: "candara", label: "Candara", css: "Candara, sans-serif" },
  { value: "century-gothic", label: "Century Gothic", css: "'Century Gothic', sans-serif" },
  { value: "gill-sans", label: "Gill Sans", css: "'Gill Sans', 'Gill Sans MT', sans-serif" },
  { value: "lucida-sans", label: "Lucida Sans", css: "'Lucida Sans', 'Lucida Grande', sans-serif" },
  { value: "optima", label: "Optima", css: "Optima, Segoe, sans-serif" },
  { value: "rockwell", label: "Rockwell", css: "Rockwell, 'Courier Bold', serif" },
  { value: "franklin-gothic-medium", label: "Franklin Gothic", css: "'Franklin Gothic Medium', 'Arial Narrow', sans-serif" },
];

const FONT_VALUES = ["", ...FONTS.map((f) => f.value)];

const QUILL_FORMATS = [
  "font", "header",
  "bold", "italic", "underline", "strike",
  "color", "background",
  "align",
  "list", "bullet",
  "link", "image",
  "width", "height", "style", "alt",
];

const QUILL_MODULES = {
  toolbar: [
    [{ font: FONT_VALUES }],
    [{ header: [1, 2, 3, false] }],
    ["bold", "italic", "underline", "strike"],
    [{ color: [] }, { background: [] }],
    [{ align: [] }],
    [{ list: "ordered" }, { list: "bullet" }],
    ["link", "image"],
    ["clean"],
  ],
};

// Singleton: Quill modules must only be registered once globally.
// Re-registering on every RichTextEditor mount corrupts existing editor instances.
let _quillReady = null;
let _ReactQuill = null;
function getReactQuill() {
  if (!_quillReady) {
    _quillReady = import("react-quill").then((mod) => {
      _ReactQuill = mod.default;
      const Quill = _ReactQuill.Quill;

      const Font = Quill.import("formats/font");
      Font.whitelist = FONT_VALUES;
      Quill.register(Font, true);

      const ImageBlot = Quill.import("formats/image");
      const PRESERVED_ATTRS = ["alt", "width", "height", "style"];
      class CustomImageBlot extends ImageBlot {
        static formats(domNode) {
          return PRESERVED_ATTRS.reduce((acc, attr) => {
            if (domNode.hasAttribute(attr)) acc[attr] = domNode.getAttribute(attr);
            return acc;
          }, {});
        }
        format(name, value) {
          if (PRESERVED_ATTRS.includes(name)) {
            if (value) this.domNode.setAttribute(name, value);
            else this.domNode.removeAttribute(name);
          } else {
            super.format(name, value);
          }
        }
      }
      CustomImageBlot.blotName = "image";
      CustomImageBlot.tagName = "IMG";
      Quill.register(CustomImageBlot, true);

      // Patch the known react-quill bug: componentDidUpdate crashes when its
      // internal state.value is undefined during rapid mount/unmount cycles.
      const origCDU = _ReactQuill.prototype.componentDidUpdate;
      _ReactQuill.prototype.componentDidUpdate = function (prevProps, prevState) {
        try {
          return origCDU.call(this, prevProps, prevState);
        } catch (e) {
          // Swallow the delta crash — the editor recovers on the next render.
        }
      };

      return _ReactQuill;
    });
  }
  return _quillReady;
}

function ImageResizeModal({ width, height, onChange, onApply, onCancel }) {
  return (
    <div style={modalStyles.overlay}>
      <div style={modalStyles.box}>
        <h3 style={modalStyles.title}>Resize Image</h3>
        <div style={modalStyles.field}>
          <label style={modalStyles.label}>Width (px)</label>
          <input
            type="number"
            min={10}
            value={width}
            onChange={(e) => onChange("width", e.target.value)}
            style={modalStyles.input}
            autoFocus
          />
        </div>
        <div style={modalStyles.field}>
          <label style={modalStyles.label}>Height (px)</label>
          <input
            type="number"
            min={10}
            value={height}
            onChange={(e) => onChange("height", e.target.value)}
            style={modalStyles.input}
          />
        </div>
        <div style={modalStyles.actions}>
          <button type="button" onClick={onCancel} style={modalStyles.cancelBtn}>Cancel</button>
          <button type="button" onClick={onApply} style={modalStyles.applyBtn}>Apply</button>
        </div>
      </div>
    </div>
  );
}

function RichTextEditor({ value, onChange, onBlockFontChange, readOnly }) {
  const [QuillComponent, setQuillComponent] = useState(() => _ReactQuill);
  // useRef instead of useState: setting a ref never triggers a re-render,
  // which prevents an extra componentDidUpdate cycle on Quill during mount.
  const editorRef = useRef(null);
  const [resizeTarget, setResizeTarget] = useState(null);

  useEffect(() => {
    if (_ReactQuill) { setQuillComponent(() => _ReactQuill); return; }
    getReactQuill().then((RQ) => setQuillComponent(() => RQ));
  }, []);

  // Stable ref callback — never triggers re-renders.
  const setEditorRef = useCallback((el) => { editorRef.current = el; }, []);

  useEffect(() => {
    const el = editorRef.current;
    if (!el?.getEditor) return;
    const editor = el.getEditor();
    const editorElement = editor.container;

    const handleImageClick = (e) => {
      if (e.target.tagName !== "IMG") return;
      e.preventDefault();
      e.stopPropagation();
      const img = e.target;
      setResizeTarget({
        img,
        width: String(img.getAttribute("width") || img.naturalWidth || 200),
        height: String(img.getAttribute("height") || img.naturalHeight || 150),
      });
    };

    editorElement.addEventListener("click", handleImageClick, true);
    return () => editorElement.removeEventListener("click", handleImageClick, true);
  }, [QuillComponent]); // re-run when the Quill instance first becomes available

  useEffect(() => {
    const el = editorRef.current;
    if (!el?.getEditor || !onBlockFontChange) return;
    const quill = el.getEditor();
    const originalFormat = quill.format.bind(quill);
    quill.format = function (name, val, source) {
      if (name === 'font') onBlockFontChange(val || '');
      return originalFormat(name, val, source);
    };
    return () => { quill.format = originalFormat; };
  }, [QuillComponent, onBlockFontChange]);

  const handleApply = () => {
    const el = editorRef.current;
    if (!resizeTarget || !el?.getEditor) return;
    const { img, width, height } = resizeTarget;

    img.setAttribute("width", width);
    img.setAttribute("height", height);
    img.style.width = `${width}px`;
    img.style.height = `${height}px`;

    const editor = el.getEditor();
    const updatedHtml = editor.root.innerHTML;
    const delta = editor.clipboard.convert(updatedHtml);
    editor.setContents(delta, "silent");

    onChange(editor.root.innerHTML);
    setResizeTarget(null);
  };

  if (!QuillComponent) {
    return <div style={styles.editorPlaceholder}>Loading editor…</div>;
  }

  const fontCss = FONTS.map(({ value, label, css }) => `
    .ql-font-${value} { font-family: ${css} !important; }
    .ql-picker.ql-font .ql-picker-label[data-value="${value}"]::before,
    .ql-picker.ql-font .ql-picker-item[data-value="${value}"]::before {
      content: '${label}' !important;
      font-family: ${css} !important;
    }
  `).join("");

  return (
    <>
      <style>{`
        .react-quill-editor .ql-toolbar.ql-snow {
          border: 1px solid #d1d5db;
          border-bottom: none;
          border-radius: 4px 4px 0 0;
          flex-wrap: wrap;
        }
        .react-quill-editor .ql-container.ql-snow {
          border: 1px solid #d1d5db;
          border-radius: 0 0 4px 4px;
        }
        .react-quill-editor .ql-editor {
          min-height: 140px;
          font-size: 14px;
          line-height: 1.7;
        }
        .react-quill-editor .ql-font.ql-picker { width: 160px; }
        .react-quill-editor .ql-picker.ql-font .ql-picker-label::before,
        .react-quill-editor .ql-picker.ql-font .ql-picker-item::before {
          content: 'Default';
        }
        ${fontCss}
        .react-quill-editor .ql-editor span[style*="background-color"] {
          padding: 0.12em 0.2em;
          border-radius: 2px;
          -webkit-box-decoration-break: clone;
          box-decoration-break: clone;
        }
        .react-quill-editor .ql-editor img {
          max-width: 100%;
          cursor: pointer;
          display: inline-block;
          vertical-align: middle;
          margin: 0 0.5rem 0.75rem 0;
          background-color: transparent !important;
          padding: 0 !important;
        }
        .react-quill-editor .ql-editor img[width],
        .react-quill-editor .ql-editor img[style*="width"] {
          max-width: none;
        }
        .react-quill-editor .ql-editor img:hover {
          outline: 2px solid #2563eb;
          opacity: 0.9;
        }
      `}</style>
      <div className="react-quill-editor">
        <QuillComponent
          ref={setEditorRef}
          theme="snow"
          value={value ?? ""}
          onChange={readOnly ? () => { } : onChange}
          readOnly={readOnly}
          modules={readOnly ? { toolbar: false } : QUILL_MODULES}
          formats={QUILL_FORMATS}
        />
      </div>
      {resizeTarget && (
        <ImageResizeModal
          width={resizeTarget.width}
          height={resizeTarget.height}
          onChange={(key, val) => setResizeTarget((prev) => ({ ...prev, [key]: val }))}
          onApply={handleApply}
          onCancel={() => setResizeTarget(null)}
        />
      )}
    </>
  );
}

// Convert a product title into a Shopify storefront handle the same way Shopify
// does (lowercase, strip accents, non-alphanumerics become hyphens). Used as a
// guaranteed fallback so the Live Preview link always resolves to a storefront
// product URL instead of the admin backend.
function titleToHandle(title) {
  return String(title ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accent marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const loader = async ({ request, params }) => {
  const { session, admin, billing } = await authenticate.admin(request);
  const productId = decodeURIComponent(params.productId);
  const url = new URL(request.url);
  const titleFromQuery = url.searchParams.get("productTitle") ?? "";
  const handleFromQuery = url.searchParams.get("handle") ?? "";

  const [fields, plan] = await Promise.all([
    getProductFields(productId, session.shop),
    getCurrentPlan(billing, session.shop),
  ]);

  const resolvedTitle = fields[0]?.productTitle || titleFromQuery || "";

  // Resolve the product handle WITHOUT depending on the Admin API (which can
  // return 403 if the app token lacks Online Store access). Order of preference:
  //   1) handle stored in the DB from a previous save,
  //   2) handle passed from the product picker via the query param,
  //   3) Admin API `product.handle` (only queried if still unknown),
  //   4) handle derived from the product title (guarantees a storefront URL).
  let handle = fields[0]?.handle || handleFromQuery || "";
  if (!handle) {
    try {
      const productRes = await admin.graphql(
        `#graphql
        query getProductUrl($id: ID!) {
          product(id: $id) { handle }
        }`,
        { variables: { id: productId } }
      );
      const productJson = await productRes.json();
      handle = productJson.data?.product?.handle ?? "";
    } catch { /* non-critical: Admin API may 403 if the token lacks scope */ }
  }
  if (!handle) {
    handle = titleToHandle(resolvedTitle);
  }

  // Always send Live Preview to the storefront (front-site) product page. The
  // admin URL is only used in the impossible case of having no handle at all.
  const storeSlug = session.shop.replace(".myshopify.com", "");
  const numericProductId = productId.split("/").pop();
  const adminProductUrl = `https://admin.shopify.com/store/${storeSlug}/products/${numericProductId}`;
  const storefrontUrl = handle
    ? `https://${session.shop}/products/${handle}`
    : adminProductUrl;

  // Block Free plan users from opening a brand-new product when they're at the product limit.
  // (fields.length > 0 means this product was already saved — always allow editing it.)
  if (plan !== PLANS.GROWTH && fields.length === 0) {
    const existingProducts = await getExistingProducts(session.shop);
    if (existingProducts.length >= FREE_PLAN_LIMITS.maxProducts) {
      return redirect("/app?limitReached=1");
    }
  }

  return {
    productId,
    productTitle: resolvedTitle,
    displayStyle: fields[0]?.displayStyle ?? "accordion",
    plan,
    storefrontUrl,
    handle,
    fields: fields.map((f) => ({
      id: f._id.toString(),
      title: f.title,
      titleFont: f.titleFont ?? "",
      content: f.content ?? "",
    })),
  };
};

export const action = async ({ request, params }) => {
  const { session, admin, billing } = await authenticate.admin(request);
  const productId = decodeURIComponent(params.productId);
  const formData = await request.formData();
  const productTitle = formData.get("productTitle") ?? "";
  const displayStyle = formData.get("displayStyle") ?? "accordion";
  const handle = formData.get("handle") ?? "";
  const fieldsJson = formData.get("fields") ?? "[]";

  let parsed = [];
  try {
    parsed = JSON.parse(fieldsJson);
  } catch {
    return { error: "Invalid fields data" };
  }

  const plan = await getCurrentPlan(billing, session.shop);
  const isGrowth = plan === PLANS.GROWTH;
  const validParsed = parsed.filter((f) => f.title?.trim());
  if (!isGrowth && validParsed.length > FREE_PLAN_LIMITS.maxFieldsPerProduct) {
    // Allow saving if the product already had >5 fields from a Growth plan session.
    // Only block if someone is trying to push beyond the existing stored count.
    const existingFields = await getProductFields(productId, session.shop);
    if (existingFields.length <= FREE_PLAN_LIMITS.maxFieldsPerProduct) {
      return { error: `Free plan is limited to ${FREE_PLAN_LIMITS.maxFieldsPerProduct} fields per product. Upgrade to Growth for unlimited fields.` };
    }
  }

  const newDocs = parsed
    .filter((f) => f.title?.trim())
    .map((f, idx) => ({
      shop: session.shop,
      productId,
      productTitle,
      handle,
      title: f.title.trim(),
      titleFont: f.titleFont ?? "",
      content: f.content ?? "",
      sortOrder: idx,
      displayStyle,
    }));

  // insertMany returns Mongoose Documents with _id; newDocs (plain objects) are NOT mutated.
  const insertedDocs = await saveProductFields(productId, session.shop, newDocs);

  // Pass insertedDocs so writeAccordionMetafield has real _id values for the metafield.
  try {
    await writeAccordionMetafield(admin, productId, session.shop, insertedDocs);
  } catch (err) {
    console.error("[CustomVogue] Metafield sync failed:", err instanceof Error ? err.message : String(err));
  }

  return { success: true };
};

const previewImgStyle = `
  .cv-preview-content img {
    max-width: 100% !important;
    height: auto !important;
    display: block;
    margin: 6px 0;
  }
`;

function LivePreviewPanel({ fields, displayStyle }) {
  const [openIdx, setOpenIdx] = useState(0);
  const validFields = fields.filter((f) => f.title?.trim());

  if (validFields.length === 0) {
    return (
      <div style={previewStyles.empty}>
        Add at least one field with a title to see the preview.
      </div>
    );
  }

  if (displayStyle === "tabs") {
    return (
      <div style={previewStyles.tabs}>
        <style>{previewImgStyle}</style>
        <div style={previewStyles.tabsNav}>
          {validFields.map((f, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setOpenIdx(i)}
              style={{
                ...previewStyles.tabBtn,
                ...(openIdx === i ? previewStyles.tabBtnActive : {}),
              }}
            >
              {f.title}
            </button>
          ))}
        </div>
        <div
          className="cv-preview-content"
          style={previewStyles.tabContent}
          dangerouslySetInnerHTML={{ __html: validFields[openIdx]?.content || "" }}
        />
      </div>
    );
  }

  return (
    <div style={previewStyles.accordion}>
      <style>{previewImgStyle}</style>
      {validFields.map((f, i) => (
        <div key={i} style={previewStyles.accordionItem}>
          <button
            type="button"
            onClick={() => setOpenIdx(openIdx === i ? -1 : i)}
            style={previewStyles.accordionHeader}
          >
            <span>{f.title}</span>
            <span style={previewStyles.accordionChevron}>{openIdx === i ? "▲" : "▼"}</span>
          </button>
          {openIdx === i && (
            <div
              className="cv-preview-content"
              style={previewStyles.accordionBody}
              dangerouslySetInnerHTML={{ __html: f.content || "" }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export default function ProductFieldsEditor() {
  const { productTitle, displayStyle: initialDisplayStyle, fields: initialFields, plan, storefrontUrl, handle } = useLoaderData();
  const fetcher = useFetcher();
  const [savedBanner, setSavedBanner] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [validationError, setValidationError] = useState("");
  const stickyRef = useRef(null);
  const [stickyHeight, setStickyHeight] = useState(195);

  const isGrowth = plan === PLANS.GROWTH;

  const [fields, setFields] = useState(
    initialFields.length > 0
      ? initialFields
      : [{ id: Date.now(), title: "", titleFont: "", content: "" }]
  );
  const [displayStyle, setDisplayStyle] = useState(initialDisplayStyle);

  const atFieldLimit = !isGrowth && fields.length >= FREE_PLAN_LIMITS.maxFieldsPerProduct;
  const hasExtraFields = !isGrowth && fields.length > FREE_PLAN_LIMITS.maxFieldsPerProduct;

  useEffect(() => {
    if (fetcher.data?.success) {
      setSavedBanner(true);
      const t = setTimeout(() => setSavedBanner(false), 3000);
      return () => clearTimeout(t);
    }
  }, [fetcher.data]);

  useEffect(() => {
    const el = stickyRef.current;
    if (!el) return;
    const update = () => setStickyHeight(el.offsetHeight + 8);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const addField = () => {
    if (atFieldLimit) return;
    setFields([...fields, { id: Date.now(), title: "", titleFont: "", content: "" }]);
  };

  const removeField = (fieldId) => {
    setFields((prev) => prev.filter((f) => f.id !== fieldId));
  };

  const updateField = (idx, key, value) =>
    setFields((prev) => prev.map((f, i) => (i === idx ? { ...f, [key]: value } : f)));

  const handleSubmit = (e) => {
    e.preventDefault();
    const validFields = fields.filter((f) => f.title?.trim());
    if (validFields.length === 0) {
      setValidationError("Please add at least one field with a title before saving.");
      return;
    }
    const missingContent = validFields.some((f) => !f.content?.trim());
    if (missingContent) {
      setValidationError("All fields must have content before saving.");
      return;
    }
    setValidationError("");
    const fd = new FormData();
    fd.append("productTitle", productTitle);
    fd.append("displayStyle", displayStyle);
    fd.append("handle", handle ?? "");
    fd.append("fields", JSON.stringify(fields));
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <div style={styles.page}>
      {/* ── Sticky header zone ── */}
      <div ref={stickyRef} style={styles.stickyZone}>
        <div style={styles.header}>
          <Link to="/app" style={styles.backLink}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 5l-7 7 7 7" />
            </svg>
            Back to App
          </Link>
          <h1 style={styles.heading}>Add Product Custom Fields</h1>
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            style={{ ...styles.previewToggleBtn, ...(showPreview ? styles.previewToggleBtnActive : {}) }}
          >
            {showPreview ? "Hide Preview" : "Preview"}
          </button>
          {storefrontUrl && (
            <a
              href={storefrontUrl}
              target="_blank"
              rel="noreferrer"
              style={styles.liveStoreBtn}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: "middle" }}>
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              Live Preview
            </a>
          )}
        </div>

        {savedBanner && (
          <div style={styles.savedBanner}>Fields saved successfully!</div>
        )}
        {validationError && (
          <div style={styles.validationError}>{validationError}</div>
        )}

        <div style={styles.banner}>{productTitle || "Add Product Custom Fields"}</div>

        <div style={styles.displayToggleBlock}>
          <span style={styles.displayToggleLabel}>Display Style:</span>
          <label style={styles.radioLabel}>
            <input
              type="radio"
              name="displayStyleUI"
              value="accordion"
              checked={displayStyle === "accordion"}
              onChange={() => setDisplayStyle("accordion")}
              style={{ marginRight: 6 }}
            />
            Accordion
          </label>
          <label style={styles.radioLabel}>
            <input
              type="radio"
              name="displayStyleUI"
              value="tabs"
              checked={displayStyle === "tabs"}
              onChange={() => setDisplayStyle("tabs")}
              style={{ marginRight: 6 }}
            />
            Horizontal Tabs
          </label>
        </div>
      </div>

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <form onSubmit={handleSubmit}>

            {hasExtraFields && (
              <div style={styles.planLimitBanner}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>
                  You're on the Free plan. Fields 1–{FREE_PLAN_LIMITS.maxFieldsPerProduct} are editable. Fields beyond {FREE_PLAN_LIMITS.maxFieldsPerProduct} are view-only.{" "}
                  <Link to="/app/billing" style={styles.planLimitLink}>Upgrade to Growth →</Link>
                </span>
              </div>
            )}

            <div style={styles.fieldsList}>
              {fields.map((field, idx) => {
                const isFieldLocked = hasExtraFields && idx >= FREE_PLAN_LIMITS.maxFieldsPerProduct;
                return (
                  <div key={field.id} style={{ ...styles.fieldBlock, ...(isFieldLocked ? styles.fieldBlockLocked : {}) }}>
                    <div style={styles.fieldHeader}>
                      <span style={styles.fieldLabel}>
                        Field {idx + 1}
                        {isFieldLocked && <span style={styles.lockedBadge}>View only</span>}
                      </span>
                      {fields.length > 1 && (
                        <button
                          type="button"
                          onPointerDown={(e) => { e.preventDefault(); removeField(field.id); }}
                          style={styles.closeBtn}
                          title="Remove field"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    <div style={styles.inputGroup}>
                      <label style={styles.label}>Title:</label>
                      <input
                        type="text"
                        value={field.title}
                        onChange={(e) => updateField(idx, "title", e.target.value)}
                        placeholder="Enter Title"
                        style={{ ...styles.titleInput, ...(isFieldLocked ? styles.inputDisabled : {}) }}
                        disabled={isFieldLocked}
                      />
                    </div>

                    <div style={styles.inputGroup}>
                      <label style={styles.label}>Description:</label>
                      <RichTextEditor
                        value={field.content}
                        onChange={(val) => updateField(idx, "content", val)}
                        onBlockFontChange={(font) => updateField(idx, "titleFont", font)}
                        readOnly={isFieldLocked}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ ...styles.actions, ...styles.stickyActions }}>
              <div style={styles.actionButtons}>
                <button type="submit" style={styles.submitBtn}>
                  {fetcher.state === "submitting" ? "Saving…" : "Submit"}
                </button>
                <button
                  type="button"
                  onClick={addField}
                  style={{
                    ...styles.addMoreBtn,
                    ...((atFieldLimit || hasExtraFields) ? styles.btnDisabled : {}),
                  }}
                  disabled={atFieldLimit || hasExtraFields}
                >
                  Add more fields
                  {!isGrowth && (
                    <span style={styles.fieldCountBadge}>
                      {fields.length}/{FREE_PLAN_LIMITS.maxFieldsPerProduct}
                    </span>
                  )}
                </button>
              </div>
              <div style={styles.fieldLimitWrap}>
                {hasExtraFields ? (
                  <>
                    <span style={styles.fieldLimitMsg}>
                      You're on the Free plan. Fields 1–{FREE_PLAN_LIMITS.maxFieldsPerProduct} are editable. Fields beyond {FREE_PLAN_LIMITS.maxFieldsPerProduct} are view-only.
                    </span>
                    <Link to="/app/billing" style={styles.upgradeLink}>
                      Upgrade to edit all fields →
                    </Link>
                  </>
                ) : atFieldLimit ? (
                  <>
                    <span style={styles.fieldLimitMsg}>
                      {FREE_PLAN_LIMITS.maxFieldsPerProduct}/{FREE_PLAN_LIMITS.maxFieldsPerProduct} fields (Free plan limit)
                    </span>
                    <Link to="/app/billing" style={styles.upgradeLink}>
                      Upgrade for unlimited fields →
                    </Link>
                  </>
                ) : null}
              </div>
            </div>
          </form>
        </div>

        {showPreview && (
          <div style={{ ...styles.previewPanel, top: stickyHeight }}>
            <div style={styles.previewHeader}>
              <span style={styles.previewTitle}>Preview</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={styles.previewStyleBadge}>{displayStyle === "tabs" ? "Horizontal Tabs" : "Accordion"}</span>
                {storefrontUrl && (
                  <a
                    href={storefrontUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={styles.previewLiveBtn}
                    title="Open in storefront"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                    Live Preview
                  </a>
                )}
              </div>
            </div>
            <LivePreviewPanel
              fields={fields}
              displayStyle={displayStyle}
            />
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: {
    fontFamily: "sans-serif",
    maxWidth: "100%",
    margin: "0 auto",
    padding: "0 32px 0",
  },
  stickyZone: {
    position: "sticky",
    top: 0,
    zIndex: 50,
    background: "#fff",
    marginLeft: -32,
    marginRight: -32,
    paddingLeft: 32,
    paddingRight: 32,
    paddingTop: 24,
    paddingBottom: 16,
    borderBottom: "1px solid #e5e7eb",
    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
    marginBottom: 24,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    marginBottom: 20,
  },
  backLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: "#6b7280",
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 500,
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid #e5e7eb",
    background: "#fff",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },
  heading: {
    fontSize: 20,
    fontWeight: 700,
    color: "#111827",
    margin: 0,
  },
  banner: {
    background: "#2563eb",
    color: "#fff",
    padding: "10px 16px",
    borderRadius: 4,
    fontWeight: 600,
    fontSize: 15,
    marginBottom: 12,
  },
  displayToggleBlock: {
    display: "flex",
    alignItems: "center",
    gap: 20,
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: "12px 16px",
    marginBottom: 0,
  },
  displayToggleLabel: {
    fontSize: 14,
    fontWeight: 600,
    color: "#374151",
    marginRight: 4,
  },
  radioLabel: {
    display: "flex",
    alignItems: "center",
    fontSize: 14,
    color: "#374151",
    cursor: "pointer",
  },
  fieldsList: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    marginBottom: 20,
  },
  fieldBlock: {
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: "20px 20px 16px",
    background: "#fff",
  },
  fieldHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  closeBtn: {
    background: "#ef4444",
    color: "#fff",
    border: "none",
    borderRadius: 4,
    width: 26,
    height: 26,
    cursor: "pointer",
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 600,
  },
  inputGroup: { marginBottom: 14 },
  label: {
    display: "block",
    fontSize: 13,
    fontWeight: 500,
    color: "#374151",
    marginBottom: 6,
  },
  titleInput: {
    width: "100%",
    border: "1px solid #d1d5db",
    borderRadius: 4,
    padding: "8px 10px",
    fontSize: 14,
    color: "#111827",
    boxSizing: "border-box",
  },
  editorPlaceholder: {
    border: "1px solid #d1d5db",
    borderRadius: 4,
    padding: 16,
    color: "#9ca3af",
    fontSize: 14,
    minHeight: 140,
    display: "flex",
    alignItems: "center",
  },
  actions: {
    display: "flex",
    gap: 12,
    alignItems: "center",
  },
  actionButtons: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
  },
  stickyActions: {
    // Not pinned: the bar sits at the end of the form and scrolls away with it,
    // rather than hovering over the last field and any open font dropdown.
    width: "100%",
    background: "#fff",
    padding: "16px 0",
    borderTop: "1px solid #e5e7eb",
    flexWrap: "wrap",
    gap: 12,
  },
  submitBtn: {
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 4,
    padding: "9px 24px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  addMoreBtn: {
    background: "#10b981",
    color: "#fff",
    border: "none",
    borderRadius: 4,
    padding: "9px 20px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
  fieldCountBadge: {
    background: "rgba(255,255,255,0.25)",
    borderRadius: 10,
    padding: "1px 8px",
    fontSize: 12,
    fontWeight: 700,
  },
  fieldLimitWrap: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  fieldLimitMsg: {
    fontSize: 13,
    color: "#6b7280",
  },
  upgradeLink: {
    fontSize: 13,
    color: "#2563eb",
    fontWeight: 600,
    textDecoration: "none",
  },
  previewToggleBtn: {
    marginLeft: "auto",
    padding: "7px 16px",
    background: "#fff",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    color: "#374151",
    cursor: "pointer",
  },
  previewToggleBtnActive: {
    background: "#dbeafe",
    border: "1px solid #93c5fd",
    color: "#1d4ed8",
  },
  liveStoreBtn: {
    display: "inline-flex",
    alignItems: "center",
    padding: "7px 16px",
    background: "#10b981",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    textDecoration: "none",
    cursor: "pointer",
  },
  previewPanel: {
    width: 340,
    flexShrink: 0,
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    background: "#f9fafb",
    overflow: "auto",
    maxHeight: "90vh",
    position: "sticky",
    top: 24,
  },
  previewHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #e5e7eb",
    background: "#fff",
  },
  previewTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
  },
  previewLiveBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    fontWeight: 600,
    color: "#fff",
    background: "#10b981",
    border: "none",
    borderRadius: 4,
    padding: "3px 8px",
    textDecoration: "none",
    cursor: "pointer",
  },
  previewStyleBadge: {
    fontSize: 11,
    color: "#6b7280",
    background: "#f3f4f6",
    padding: "2px 8px",
    borderRadius: 10,
  },
  savedBanner: {
    background: "#d1fae5",
    color: "#065f46",
    border: "1px solid #6ee7b7",
    borderRadius: 6,
    padding: "10px 16px",
    fontSize: 14,
    fontWeight: 500,
    marginBottom: 16,
  },
  validationError: {
    background: "#fee2e2",
    color: "#991b1b",
    border: "1px solid #fca5a5",
    borderRadius: 6,
    padding: "10px 16px",
    fontSize: 14,
    fontWeight: 500,
    marginBottom: 16,
  },
  planLimitBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    background: "#fffbeb",
    border: "1px solid #fcd34d",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 13,
    color: "#92400e",
    marginBottom: 16,
    lineHeight: 1.5,
  },
  planLimitLink: {
    color: "#b45309",
    fontWeight: 600,
    textDecoration: "underline",
  },
  inputDisabled: {
    background: "#f3f4f6",
    color: "#9ca3af",
    cursor: "not-allowed",
  },
  fieldBlockLocked: {
    background: "#fafafa",
    borderColor: "#e5e7eb",
    opacity: 0.8,
  },
  lockedBadge: {
    marginLeft: 8,
    fontSize: 10,
    fontWeight: 600,
    color: "#9ca3af",
    background: "#f3f4f6",
    border: "1px solid #e5e7eb",
    borderRadius: 4,
    padding: "1px 6px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
};

const previewStyles = {
  empty: {
    padding: 20,
    fontSize: 13,
    color: "#9ca3af",
    textAlign: "center",
  },
  accordion: {
    border: "1px solid #e5e7eb",
    borderRadius: 6,
    overflow: "hidden",
    margin: 12,
  },
  accordionItem: {
    borderBottom: "1px solid #e5e7eb",
  },
  accordionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    padding: "10px 14px",
    background: "#fff",
    border: "none",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 500,
    color: "#111827",
    textAlign: "left",
  },
  accordionChevron: {
    fontSize: 10,
    color: "#9ca3af",
  },
  accordionBody: {
    padding: "10px 14px",
    background: "#fafafa",
    fontSize: 13,
    color: "#374151",
    lineHeight: 1.6,
    overflow: "hidden",
  },
  tabs: {
    margin: 12,
  },
  tabsNav: {
    display: "flex",
    gap: 2,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  tabBtn: {
    padding: "7px 12px",
    borderTop: "none",
    borderLeft: "none",
    borderRight: "none",
    borderBottom: "2px solid transparent",
    borderBottomColor: "transparent",
    outline: "none",
    background: "none",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    color: "#6b7280",
    marginBottom: 0,
  },
  tabBtnActive: {
    color: "#2563eb",
    borderBottomColor: "#2563eb",
  },
  tabContent: {
    fontSize: 13,
    color: "#374151",
    lineHeight: 1.6,
    minHeight: 60,
    overflow: "hidden",
  },
};

const modalStyles = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    zIndex: 9999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  box: {
    background: "#fff",
    borderRadius: 8,
    padding: 24,
    width: 300,
    boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
  },
  title: {
    margin: "0 0 16px",
    fontSize: 16,
    fontWeight: 600,
    color: "#111827",
  },
  field: { marginBottom: 14 },
  label: {
    display: "block",
    fontSize: 13,
    fontWeight: 500,
    color: "#374151",
    marginBottom: 6,
  },
  input: {
    width: "100%",
    border: "1px solid #d1d5db",
    borderRadius: 4,
    padding: "8px 10px",
    fontSize: 14,
    color: "#111827",
    boxSizing: "border-box",
  },
  actions: {
    display: "flex",
    gap: 10,
    justifyContent: "flex-end",
    marginTop: 20,
  },
  cancelBtn: {
    padding: "8px 16px",
    border: "1px solid #d1d5db",
    borderRadius: 4,
    background: "#fff",
    cursor: "pointer",
    fontSize: 14,
    color: "#374151",
  },
  applyBtn: {
    padding: "8px 16px",
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
  },
};
