import { Outlet, useLoaderData, useRouteError, isRouteErrorResponse } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { syncAppUrl, syncShopPlan } from "../utils/appUrl.server.js";
import { getCurrentPlan } from "../utils/billing.server.js";
import TopLoadingBar from "../components/TopLoadingBar";

export const loader = async ({ request }) => {
  const { admin, session, billing } = await authenticate.admin(request);

  const appUrl = new URL(request.url).origin;
  syncAppUrl(admin, session.shop, appUrl).catch(() => {});

  getCurrentPlan(billing, session.shop)
    .then((plan) => syncShopPlan(admin, session.shop, plan))
    .catch(() => {});

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <TopLoadingBar />
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  // Auth redirect thrown by authenticate.admin (Shopify OAuth flow).
  // boundary.error handles Response objects for the OAuth redirect mechanism.
  // We only call it when error.data is a string (safe to pass to dangerouslySetInnerHTML).
  const isShopifyBoundaryType =
    error &&
    typeof error === "object" &&
    (error.constructor?.name === "ErrorResponse" ||
      error.constructor?.name === "ErrorResponseImpl");

  if (isShopifyBoundaryType && typeof error.data === "string") {
    return boundary.error(error);
  }

  // 401/403 from authenticate.admin (e.g. shop=null, expired token).
  // Auto-reload once — this triggers the proper Shopify OAuth flow.
  if (isRouteErrorResponse(error) && (error.status === 401 || error.status === 403)) {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
    return (
      <div style={authErrorStyle}>
        <p>Reconnecting to Shopify…</p>
      </div>
    );
  }

  // Other route-level errors (404, 500, etc.)
  if (isRouteErrorResponse(error)) {
    return (
      <div style={errorStyle}>
        <h2 style={{ color: "#b91c1c", margin: "0 0 8px" }}>
          {error.status} — {error.statusText || "Error"}
        </h2>
        <p style={{ color: "#374151", margin: "0 0 16px" }}>
          {typeof error.data === "string" ? error.data : "An unexpected error occurred."}
        </p>
        <button onClick={() => window.location.reload()} style={reloadBtn}>Reload</button>
      </div>
    );
  }

  // For auth types where error.data is not a string (catches remaining ShopifyBoundaryType cases)
  if (isShopifyBoundaryType) {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
    return <div style={authErrorStyle}><p>Reconnecting to Shopify…</p></div>;
  }

  // Real JS errors — show the message
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
      ? error
      : "An unexpected error occurred.";

  console.error("[CustomVogue] Unhandled route error:", error);

  return (
    <div style={errorStyle}>
      <h2 style={{ color: "#b91c1c", margin: "0 0 8px" }}>Application Error</h2>
      <p style={{ color: "#374151", margin: "0 0 16px" }}>{message}</p>
      <button onClick={() => window.location.reload()} style={reloadBtn}>Reload</button>
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

const authErrorStyle = {
  display: "flex", alignItems: "center", justifyContent: "center",
  height: "100vh", fontFamily: "sans-serif", color: "#6b7280", fontSize: 14,
};

const errorStyle = {
  padding: 32, fontFamily: "sans-serif",
};

const reloadBtn = {
  padding: "8px 20px", background: "#1a1a1a", color: "#fff",
  border: "none", borderRadius: 4, cursor: "pointer", fontSize: 14,
};
