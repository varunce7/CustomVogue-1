// The extension's unique id from extensions/custom-vogue-accordion/shopify.extension.toml.
// It's embedded verbatim (as "shopify://apps/{api_key}/blocks/{handle}/{uuid}")
// inside a theme's JSON template whenever the merchant adds the "Custom Fields"
// app block, so we can detect installation by just searching for this
// substring instead of parsing the full block-type string.
const EXTENSION_UID = "bc2445a3-d0b6-ca7d-5f7d-e05c36853a21e7a7b817";
const BLOCK_HANDLE = "accordion";
// client_id from shopify.app.toml. The theme-editor deep link's addAppBlockId
// takes {api_key}/{handle} — using the extension uuid there is deprecated.
const APP_API_KEY = "9adf469185b975354ca9383c6ee1baea";

export function getAddBlockUrl(shop) {
  return `https://${shop}/admin/themes/current/editor?template=product&addAppBlockId=${APP_API_KEY}/${BLOCK_HANDLE}&target=mainSection`;
}

export async function getMainTheme(admin) {
  const response = await admin.graphql(
    `#graphql
    query {
      themes(first: 20) {
        nodes { id name role }
      }
    }`
  );
  const json = await response.json();
  const themes = json.data?.themes?.nodes ?? [];
  return themes.find((t) => t.role === "MAIN") ?? null;
}

// Returns { isOS2, blockDetected } for the given theme's product template.
export async function checkThemeSetup(admin, themeId) {
  const response = await admin.graphql(
    `#graphql
    query getThemeFiles($id: ID!, $filenames: [String!]!) {
      theme(id: $id) {
        files(filenames: $filenames) {
          nodes {
            filename
            body {
              ... on OnlineStoreThemeFileBodyText { content }
            }
          }
        }
      }
    }`,
    { variables: { id: themeId, filenames: ["templates/product.json"] } }
  );
  const json = await response.json();
  const files = json.data?.theme?.files?.nodes ?? [];
  const productJson = files.find((f) => f.filename === "templates/product.json");

  if (!productJson) {
    // No JSON template for Product — legacy .liquid template, not Online Store 2.0.
    return { isOS2: false, blockDetected: false };
  }

  const content = productJson.body?.content ?? "";
  return { isOS2: true, blockDetected: content.includes(EXTENSION_UID) };
}
