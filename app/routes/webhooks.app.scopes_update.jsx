import { authenticate } from "../shopify.server";
import connection from "../db.server.js";
import SessionModel from "../models/Session.js";

export const action = async ({ request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  const current = payload.current;

  if (session) {
    await connection;
    await SessionModel.findByIdAndUpdate(session.id, { scope: current.toString() });
  }

  return new Response();
};
