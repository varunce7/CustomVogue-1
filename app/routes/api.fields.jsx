import connection from "../db.server.js";
import ProductField from "../models/ProductField.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  let productId = url.searchParams.get("productId");

  if (!shop || !productId) {
    return new Response(JSON.stringify({ fields: [] }), { headers: CORS });
  }

  // Liquid's {{ product.id }} gives the numeric ID (e.g. 7217103405127).
  // MongoDB stores the full Shopify GID (gid://shopify/Product/7217103405127).
  // Normalise so both forms match.
  if (/^\d+$/.test(productId)) {
    productId = `gid://shopify/Product/${productId}`;
  }

  await connection;
  const fields = await ProductField.find({ shop, productId })
    .sort({ sortOrder: 1 })
    .select("_id content")
    .lean();

  return new Response(
    JSON.stringify({
      fields: fields.map((f) => ({ id: f._id.toString(), content: f.content || "" })),
    }),
    { headers: CORS }
  );
};
