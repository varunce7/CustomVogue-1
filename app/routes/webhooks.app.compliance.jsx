import { authenticate } from "../shopify.server";
import connection from "../db.server.js";
import ContactSubmission from "../models/ContactSubmission.js";
import FieldClick from "../models/FieldClick.js";
import ProductField from "../models/ProductField.js";
import SessionModel from "../models/Session.js";

export const action = async ({ request }) => {
  // Throws a 401 Response when the HMAC signature is missing or invalid, which
  // is what Shopify's automated "Verifies webhooks with HMAC signatures" check
  // probes for. Compliance webhooks arrive after uninstall, so `session` is
  // usually undefined here — only `topic` and `shop` are needed.
  const { topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await connection;

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // CustomVogue holds no customer-identifiable data: accordion fields are
      // keyed by product, and click analytics carry no customer or order ID.
      // There is nothing to hand back to the merchant.
      break;

    case "CUSTOMERS_REDACT":
      // Same reason — no per-customer record exists to erase.
      break;

    case "SHOP_REDACT":
      // Everything this app stores is keyed by shop domain. Custom CSS lives in
      // a Shopify shop metafield, which Shopify removes on its own.
      await Promise.all([
        ProductField.deleteMany({ shop }),
        FieldClick.deleteMany({ shop }),
        ContactSubmission.deleteMany({ shop }),
        SessionModel.deleteMany({ shop }),
      ]);
      break;

    default:
      return new Response("Unhandled webhook topic", { status: 404 });
  }

  return new Response();
};
