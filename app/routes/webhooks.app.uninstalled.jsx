import { authenticate } from "../shopify.server";
import connection from "../db.server.js";
import ProductField from "../models/ProductField.js";
import SessionModel from "../models/Session.js";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (session) {
    await connection;
    await Promise.all([
      ProductField.deleteMany({ shop }),
      SessionModel.deleteMany({ shop }),
    ]);
  }

  return new Response();
};
