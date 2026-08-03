import connection from "../db.server.js";
import FieldClick from "../models/FieldClick.js";

function normalizeShopifyProductId(productId) {
  if (typeof productId !== "string") return productId;
  if (/^\d+$/.test(productId)) {
    return `gid://shopify/Product/${productId}`;
  }
  return productId;
}

export const action = async ({ request }) => {
  const corsHeaders = { "Access-Control-Allow-Origin": "*" };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  let body;
  try {
    const text = await request.text();
    body = JSON.parse(text);
  } catch {
    return new Response("Bad request", { status: 400, headers: corsHeaders });
  }

  const { shop, productId: rawProductId, productTitle, fieldId, fieldTitle, action: eventAction } = body ?? {};
  if (!shop || !rawProductId || !fieldId) {
    return new Response("Missing fields", { status: 400, headers: corsHeaders });
  }

  const productId = normalizeShopifyProductId(rawProductId);

  try {
    await connection;
    await FieldClick.create({
      shop,
      productId,
      productTitle: productTitle ?? "",
      fieldId,
      fieldTitle: fieldTitle ?? "",
      action: ["expand", "tab_click"].includes(eventAction) ? eventAction : "expand",
    });
  } catch (e) {
    console.error("FieldClick tracking error:", e.message);
  }

  return new Response("OK", { status: 200, headers: corsHeaders });
};
