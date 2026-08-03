import ProductField from "../models/ProductField.js";
import connection from "../db.server.js";

export async function getExistingProducts(shop) {
  await connection;
  const existing = await ProductField.aggregate([
    { $match: { shop } },
    {
      $group: {
        _id: "$productId",
        productTitle: { $first: "$productTitle" },
        handle: { $first: "$handle" },
        fieldCount: { $sum: 1 },
      },
    },
    { $sort: { productTitle: 1 } },
  ]);
  return existing.map((e) => ({
    id: e._id,
    title: e.productTitle,
    handle: e.handle ?? "",
    fieldCount: e.fieldCount,
  }));
}
