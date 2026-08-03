const synced = new Set();
const planSynced = new Map(); // shop → last-synced plan

export async function syncShopPlan(admin, shop, plan, force = false) {
  if (!plan || !shop) return;
  if (!force && planSynced.get(shop) === plan) return;
  planSynced.set(shop, plan);

  // Ensure definition exists with PUBLIC_READ storefront access
  try {
    await admin.graphql(
      `#graphql
      mutation createPlanDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id }
          userErrors { code message }
        }
      }`,
      {
        variables: {
          definition: {
            name: "Plan",
            namespace: "custom_vogue",
            key: "plan",
            type: "single_line_text_field",
            ownerType: "SHOP",
            access: { storefront: "PUBLIC_READ" },
          },
        },
      }
    );
  } catch (_) {}

  // Write the plan value
  try {
    const shopRes = await admin.graphql(
      `#graphql
      query {
        shop { id }
      }`
    );
    const shopJson = await shopRes.json();
    const shopId = shopJson.data?.shop?.id;
    if (!shopId) { planSynced.delete(shop); return; }

    const setRes = await admin.graphql(
      `#graphql
      mutation setShopPlan($metafields: [MetafieldsSetInput!]!) {
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
              key: "plan",
              value: plan.toLowerCase(),
              type: "single_line_text_field",
            },
          ],
        },
      }
    );
    const setJson = await setRes.json();
    const setErrors = setJson.data?.metafieldsSet?.userErrors;
    if (setErrors?.length > 0) {
      console.error("[CustomVogue] syncShopPlan write error:", JSON.stringify(setErrors));
      planSynced.delete(shop);
    } else {
      console.log(`[CustomVogue] syncShopPlan: wrote plan="${plan.toLowerCase()}" for ${shop}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    console.error("[CustomVogue] syncShopPlan exception:", msg);
    planSynced.delete(shop);
  }
}

export async function syncAppUrl(admin, shop, appUrl) {
  if (!appUrl || synced.has(shop + appUrl)) return;
  synced.add(shop + appUrl);

  try {
    await admin.graphql(
      `#graphql
      mutation createAppUrlDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id }
          userErrors { code message }
        }
      }`,
      {
        variables: {
          definition: {
            name: "App URL",
            namespace: "custom_vogue",
            key: "app_url",
            type: "single_line_text_field",
            ownerType: "SHOP",
            access: { storefront: "PUBLIC_READ" },
          },
        },
      }
    );
  } catch (_) {}

  try {
    const shopRes = await admin.graphql(
      `#graphql
      query {
        shop { id }
      }`
    );
    const shopJson = await shopRes.json();
    const shopId = shopJson.data?.shop?.id;
    if (!shopId) return;

    await admin.graphql(
      `#graphql
      mutation setAppUrl($metafields: [MetafieldsSetInput!]!) {
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
              key: "app_url",
              value: appUrl,
              type: "single_line_text_field",
            },
          ],
        },
      }
    );
  } catch (e) {
    synced.delete(shop + appUrl);
  }
}
