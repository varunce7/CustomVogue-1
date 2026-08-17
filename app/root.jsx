import { Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteError } from "react-router";

export const links = () => [
  {
    rel: "stylesheet",
    href: "https://cdn.jsdelivr.net/npm/quill@1.3.7/dist/quill.snow.css",
  },
];

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body style={{ margin: 0 }}>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "An unexpected error occurred. Please reload the page.";

  console.error("[CustomVogue] Root error boundary caught:", error);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Error — CustomVogue</title>
      </head>
      <body style={{ margin: 0, fontFamily: "sans-serif", padding: 32 }}>
        <h2 style={{ color: "#b91c1c" }}>Something went wrong</h2>
        <p style={{ color: "#374151" }}>{message}</p>
        <s-button variant="primary"
          onClick={() => window.location.reload()}
          style={{
            marginTop: 16, padding: "8px 20px",
            background: "#1a1a1a", color: "#fff",
            border: "none", borderRadius: 4, cursor: "pointer", fontSize: 14,
          }}
        >
          Reload
        </s-button>
      </body>
    </html>
  );
}
