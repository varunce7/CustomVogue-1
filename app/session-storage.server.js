import { Session } from "@shopify/shopify-api";
import SessionModel from "./models/Session.js";
import connection from "./db.server.js";

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
