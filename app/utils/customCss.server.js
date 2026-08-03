export async function ensureCustomCssDefinition(admin) {
  await admin.graphql(
    `#graphql
    mutation createMetafieldDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id }
        userErrors { field message code }
      }
    }`,
    {
      variables: {
        definition: {
          name: "Custom CSS",
          namespace: "custom_vogue",
          key: "custom_css",
          type: "multi_line_text_field",
          ownerType: "SHOP",
          access: { storefront: "PUBLIC_READ" },
        },
      },
    }
  );
  // Ignore "already exists" userErrors — safe to call on every load
}

export async function getCustomCss(admin) {
  const res = await admin.graphql(
    `#graphql
    query {
      shop {
        id
        metafield(namespace: "custom_vogue", key: "custom_css") {
          value
        }
      }
    }`
  );
  const json = await res.json();
  return {
    shopId: json.data?.shop?.id,
    css: json.data?.shop?.metafield?.value ?? "",
  };
}

export async function saveCustomCss(admin, shopId, css) {
  const res = await admin.graphql(
    `#graphql
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: "custom_vogue",
            key: "custom_css",
            value: css,
            type: "multi_line_text_field",
          },
        ],
      },
    }
  );
  const json = await res.json();
  const errors = json.data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    throw new Error(errors.map((e) => e.message).join(", "));
  }
}
