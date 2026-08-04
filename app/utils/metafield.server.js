// Shopify caps metafieldsSet / metafieldsDelete at 25 entries per call, so bulk
// work is chunked rather than sent one product at a time.
const METAFIELD_CHUNK = 25;
// How many chunk requests are in flight at once. Kept low so a large import
// doesn't burn through the GraphQL cost bucket and start getting throttled.
const REQUEST_CONCURRENCY = 4;

// Run fn over items with at most `limit` running concurrently, preserving order.
// Rejects on the first error, like the sequential loops this replaces.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// The metafield payload for one product, or null when it has no usable fields
// (in which case the metafield should be deleted instead of written).
function buildAccordionValue(docs) {
  const validFields = (docs || []).filter((field) => field?.title?.trim());
  if (validFields.length === 0) return null;

  const displayStyle = validFields[0]?.displayStyle ?? "accordion";
  const metaFields = validFields.map((f) => ({
    id: f._id ? f._id.toString() : f.id,
    title: f.title,
    titleFont: f.titleFont ?? "",
    content: f.content ?? "",
  }));

  return JSON.stringify({ displayStyle, fields: metaFields });
}

// Sync many products' metafields at once. Same result as calling
// writeAccordionMetafield() per product, but in ceil(n/25) requests instead of n.
// `entries` is [{ productId, docs }].
export async function writeAccordionMetafieldsBatch(admin, entries) {
  const toSet = [];
  const toClear = [];

  for (const { productId, docs } of entries) {
    const value = buildAccordionValue(docs);
    if (value === null) {
      toClear.push({ ownerId: productId, namespace: "custom_vogue", key: "accordion_fields" });
    } else {
      toSet.push({
        ownerId: productId,
        namespace: "custom_vogue",
        key: "accordion_fields",
        value,
        type: "json",
      });
    }
  }

  const errors = [];

  const jobs = [
    ...chunk(toSet, METAFIELD_CHUNK).map((batch) => async () => {
      const response = await admin.graphql(
        `#graphql
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message code }
          }
        }`,
        { variables: { metafields: batch } }
      );
      const json = await response.json();
      for (const e of json.data?.metafieldsSet?.userErrors ?? []) errors.push(e.message);
    }),
    ...chunk(toClear, METAFIELD_CHUNK).map((batch) => async () => {
      const response = await admin.graphql(
        `#graphql
        mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields { key }
            userErrors { field message }
          }
        }`,
        { variables: { metafields: batch } }
      );
      const json = await response.json();
      for (const e of json.data?.metafieldsDelete?.userErrors ?? []) errors.push(e.message);
    }),
  ];

  await mapWithConcurrency(jobs, REQUEST_CONCURRENCY, (job) => job());

  if (errors.length) {
    throw new Error(`Metafield sync failed: ${errors.join(", ")}`);
  }
}

// Remove the storefront metafield for a product so its custom fields stop
// showing on the storefront (e.g. after the merchant deletes all its fields).
export async function clearAccordionMetafield(admin, productId) {
  const response = await admin.graphql(
    `#graphql
    mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) {
        deletedMetafields { key }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          { ownerId: productId, namespace: "custom_vogue", key: "accordion_fields" },
        ],
      },
    }
  );

  const json = await response.json();
  const errors = json.data?.metafieldsDelete?.userErrors;
  if (errors?.length) {
    throw new Error(
      `Metafield clear failed: ${errors.map((e) => e.message).join(", ")}`
    );
  }
}

export async function writeAccordionMetafield(admin, productId, shop, docs) {
  // docs passed directly from the action to avoid a redundant DB read.
  // If not provided (e.g. called from other places), fall back to a DB query.
  let fields = docs;
  if (!fields) {
    const { default: ProductField } = await import("../models/ProductField.js");
    fields = await ProductField.find({ productId, shop }).sort({ sortOrder: 1 }).lean();
  }

  const validFields = (fields || []).filter((field) => field?.title?.trim());
  if (validFields.length === 0) {
    await clearAccordionMetafield(admin, productId);
    return;
  }

  const displayStyle = validFields[0]?.displayStyle ?? "accordion";

  const metaFields = validFields.map((f) => ({
    id: f._id ? f._id.toString() : f.id,
    title: f.title,
    titleFont: f.titleFont ?? "",
    content: f.content ?? "",
  }));

  const value = JSON.stringify({ displayStyle, fields: metaFields });

  const response = await admin.graphql(
    `#graphql
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message code }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: productId,
            namespace: "custom_vogue",
            key: "accordion_fields",
            value,
            type: "json",
          },
        ],
      },
    }
  );

  const json = await response.json();
  const errors = json.data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    throw new Error(
      `Metafield sync failed: ${errors.map((e) => e.message).join(", ")}`
    );
  }
}
