import ProductField from "../models/ProductField.js";
import connection from "../db.server.js";

export async function getProductFields(productId, shop) {
  await connection;
  return ProductField.find({ productId, shop }).sort({ sortOrder: 1 }).lean();
}

export async function saveProductFields(productId, shop, docs) {
  await connection;

  if (docs.length === 0) {
    await ProductField.deleteMany({ productId, shop });
    return [];
  }

  // Upsert each field by position — same sortOrder keeps its _id across saves
  await ProductField.bulkWrite(
    docs.map((doc) => ({
      updateOne: {
        filter: { shop, productId, sortOrder: doc.sortOrder },
        update: { $set: doc },
        upsert: true,
      },
    }))
  );

  // Remove fields at positions that no longer exist (user deleted fields)
  await ProductField.deleteMany({ shop, productId, sortOrder: { $gte: docs.length } });

  // Return the saved docs with their _id for metafield sync
  return ProductField.find({ shop, productId }).sort({ sortOrder: 1 }).lean();
}
