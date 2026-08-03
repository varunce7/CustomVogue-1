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
