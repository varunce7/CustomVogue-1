import { Session } from "@shopify/shopify-api";
import connection from "./db.server.js";
import SessionModel from "./models/Session.js";

const TOKEN_EXCHANGE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:token-exchange";
const OFFLINE_ACCESS_TOKEN_TYPE =
  "urn:shopify:params:oauth:token-type:offline-access-token";

// Keyed by session id, so concurrent requests for the same shop only run one
// exchange instead of racing each other with the same subject token.
const pendingMigrations = new Map();

export class MongoDBSessionStorage {
  constructor() {
    this.ready = connection;
  }

  async storeSession(session) {
    await this.ready;
    const data = this.#sessionToDoc(session);
    await SessionModel.findByIdAndUpdate(data._id, data, { upsert: true, new: true });
    return true;
  }

  async loadSession(id) {
    await this.ready;
    const doc = await SessionModel.findById(id).lean();
    if (!doc) return undefined;
    if (!doc.isOnline && doc.accessToken && !doc.refreshToken) {
      return this.#migrateLegacyOfflineSession(doc);
    }
    return this.#docToSession(doc);
  }

  async deleteSession(id) {
    await this.ready;
    await SessionModel.findByIdAndDelete(id);
    return true;
  }

  async deleteSessions(ids) {
    await this.ready;
    await SessionModel.deleteMany({ _id: { $in: ids } });
    return true;
  }

  async findSessionsByShop(shop) {
    await this.ready;
    const docs = await SessionModel.find({ shop }).sort({ expires: -1 }).limit(25).lean();
    return docs.map((doc) => this.#docToSession(doc));
  }

  // Sessions stored before `future.expiringOfflineAccessTokens` was enabled hold
  // a non-expiring offline token. Shopify has deprecated those and they never
  // look expired, so the library would keep reusing them: exchange them once for
  // an expiring token + refresh token pair.
  #migrateLegacyOfflineSession(doc) {
    const inFlight = pendingMigrations.get(doc._id);
    if (inFlight) return inFlight;

    const migration = (async () => {
      try {
        const response = await fetch(`https://${doc.shop}/admin/oauth/access_token`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            client_id: process.env.SHOPIFY_API_KEY,
            client_secret: process.env.SHOPIFY_API_SECRET,
            grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
            subject_token: doc.accessToken,
            subject_token_type: OFFLINE_ACCESS_TOKEN_TYPE,
            requested_token_type: OFFLINE_ACCESS_TOKEN_TYPE,
            expiring: "1",
          }),
        });

        if (!response.ok) {
          console.error(
            `[CustomVogue] offline token migration rejected for ${doc.shop}: ${response.status}`,
          );
          // The old token is unusable, so drop the session and let the next
          // embedded request mint a fresh one through token exchange.
          await this.deleteSession(doc._id);
          return undefined;
        }

        const body = await response.json();
        const now = Date.now();
        const update = {
          scope: body.scope ?? doc.scope ?? null,
          accessToken: body.access_token,
          expires: body.expires_in ? new Date(now + body.expires_in * 1000) : null,
          refreshToken: body.refresh_token ?? null,
          refreshTokenExpires: body.refresh_token_expires_in
            ? new Date(now + body.refresh_token_expires_in * 1000)
            : null,
        };
        await SessionModel.findByIdAndUpdate(doc._id, update, { new: true });
        return this.#docToSession({ ...doc, ...update });
      } catch (error) {
        // Never let a migration problem surface as a 500: leave the row alone,
        // return no session, and the request re-authenticates through token
        // exchange like any other missing session.
        console.error(`[CustomVogue] offline token migration failed for ${doc.shop}`, error);
        return undefined;
      }
    })().finally(() => pendingMigrations.delete(doc._id));

    pendingMigrations.set(doc._id, migration);
    return migration;
  }

  #sessionToDoc(session) {
    const params = session.toObject ? session.toObject() : session;
    return {
      _id: session.id,
      shop: session.shop,
      state: session.state,
      isOnline: session.isOnline,
      scope: session.scope ?? null,
      expires: session.expires ?? null,
      accessToken: session.accessToken ?? "",
      userId: params.onlineAccessInfo?.associated_user?.id ?? null,
      firstName: params.onlineAccessInfo?.associated_user?.first_name ?? null,
      lastName: params.onlineAccessInfo?.associated_user?.last_name ?? null,
      email: params.onlineAccessInfo?.associated_user?.email ?? null,
      accountOwner: params.onlineAccessInfo?.associated_user?.account_owner ?? false,
      locale: params.onlineAccessInfo?.associated_user?.locale ?? null,
      collaborator: params.onlineAccessInfo?.associated_user?.collaborator ?? false,
      emailVerified: params.onlineAccessInfo?.associated_user?.email_verified ?? false,
      refreshToken: params.refreshToken ?? null,
      refreshTokenExpires: params.refreshTokenExpires ?? null,
    };
  }

  #docToSession(doc) {
    const p = {
      id: doc._id,
      shop: doc.shop,
      state: doc.state,
      isOnline: doc.isOnline,
    };
    if (doc.userId != null) p.userId = String(doc.userId);
    if (doc.firstName) p.firstName = doc.firstName;
    if (doc.lastName) p.lastName = doc.lastName;
    if (doc.email) p.email = doc.email;
    if (doc.locale) p.locale = doc.locale;
    if (doc.accountOwner != null) p.accountOwner = doc.accountOwner;
    if (doc.collaborator != null) p.collaborator = doc.collaborator;
    if (doc.emailVerified != null) p.emailVerified = doc.emailVerified;
    if (doc.expires) p.expires = new Date(doc.expires).getTime();
    if (doc.scope) p.scope = doc.scope;
    if (doc.accessToken) p.accessToken = doc.accessToken;
    if (doc.refreshToken) p.refreshToken = doc.refreshToken;
    if (doc.refreshTokenExpires)
      p.refreshTokenExpires = new Date(doc.refreshTokenExpires).getTime();
    return Session.fromPropertyArray(Object.entries(p), true);
  }
}
