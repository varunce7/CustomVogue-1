// The block file name from extensions/custom-vogue-accordion/blocks/accordion.liquid.
// Shopify embeds a reference to it inside a theme's JSON template whenever the
// merchant adds the "Custom Fields" app block — see BLOCK_REF below.
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

// Matches the block reference Shopify writes into a JSON template, e.g.
//   "shopify://apps/custom-vogue-accordion/blocks/accordion/<uuid>"
// The uuid is deliberately not pinned: the dev-preview extension registers under
// a different uuid than the deployed one, so matching it exactly made a block
// that was genuinely added read as "not detected".
const BLOCK_REF = new RegExp(`shopify://apps/[^"']+/blocks/${BLOCK_HANDLE}/`);

// A block present but toggled off in the editor renders nothing, so treat
// "disabled": true on the same block entry as not installed.
function hasEnabledBlock(content) {
  if (!BLOCK_REF.test(content)) return false;

  let template;
  try {
    // JSON templates may carry /* */ comments, which JSON.parse rejects.
    template = JSON.parse(content.replace(/\/\*[\s\S]*?\*\//g, ""));
  } catch {
    // Unparseable — fall back to the plain substring match.
    return true;
  }

  const blocks = Object.values(template?.sections ?? {}).flatMap((section) =>
    Object.values(section?.blocks ?? {}),
  );
  const ours = blocks.filter((b) => typeof b?.type === "string" && BLOCK_REF.test(b.type));

  // Regex matched but no parsed block did (unusual shape) — trust the regex.
  if (ours.length === 0) return true;
  return ours.some((b) => b.disabled !== true);
}

// Theme files are alphabetical and paginated at 250 per page, so templates/*
// lands on a later page for any theme with a decent number of assets and
// snippets (Dawn's first page ends inside snippets/). Page through all of them.
async function listFilenames(admin, themeId) {
  const filenames = [];
  let after = null;

  for (let page = 0; page < 20; page++) {
    const response = await admin.graphql(
      `#graphql
      query listThemeFiles($id: ID!, $after: String) {
        theme(id: $id) {
          files(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { filename }
          }
        }
      }`,
      { variables: { id: themeId, after } }
    );
    const json = await response.json();
    const files = json.data?.theme?.files;
    if (!files) break;

    filenames.push(...files.nodes.map((f) => f.filename));
    if (!files.pageInfo?.hasNextPage) break;
    after = files.pageInfo.endCursor;
  }

  return filenames;
}

// Returns { isOS2, blockDetected } for the theme's product templates.
export async function checkThemeSetup(admin, themeId) {
  // Every product template counts, not just templates/product.json — merchants
  // routinely assign an alternate template (templates/product.custom.json) to
  // the products they care about.
  const filenames = await listFilenames(admin, themeId);

  const productTemplates = filenames.filter(
    (f) => f.startsWith("templates/product") && f.endsWith(".json"),
  );

  if (productTemplates.length === 0) {
    // No JSON template for Product — legacy .liquid template, not Online Store 2.0.
    return { isOS2: false, blockDetected: false };
  }

  // Section groups can host the product section too, so check them alongside.
  const sectionGroups = filenames.filter(
    (f) => f.startsWith("sections/") && f.endsWith(".json"),
  );

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
    { variables: { id: themeId, filenames: [...productTemplates, ...sectionGroups] } }
  );
  const json = await response.json();
  const files = json.data?.theme?.files?.nodes ?? [];

  const blockDetected = files.some((f) => hasEnabledBlock(f.body?.content ?? ""));

  return { isOS2: true, blockDetected };
}
