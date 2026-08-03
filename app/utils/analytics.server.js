import ProductField from "../models/ProductField.js";
import FieldClick from "../models/FieldClick.js";
import connection from "../db.server.js";

export async function getShopAnalytics(shop) {
  await connection;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Get IDs of fields that currently exist so click data for deleted fields is excluded
  const activeFieldIdRaw = await ProductField.find({ shop }).distinct("_id");
  const activeFieldIds = activeFieldIdRaw.map(String);

  const [
    totalFields,
    fieldsThisMonth,
    fieldsLastMonth,
    fieldsLast7Days,
    productGroups,
    languageGroups,
    displayStyleGroups,
    topClickedGroups,
    totalClicks,
    topTitleGroups,
    topProductClickGroups,
  ] = await Promise.all([
    ProductField.countDocuments({ shop }),
    ProductField.countDocuments({ shop, createdAt: { $gte: startOfMonth } }),
    ProductField.countDocuments({
      shop,
      createdAt: { $gte: startOfLastMonth, $lt: startOfMonth },
    }),
    ProductField.countDocuments({ shop, createdAt: { $gte: sevenDaysAgo } }),
    ProductField.aggregate([
      { $match: { shop } },
      {
        $group: {
          _id: "$productId",
          title: { $first: "$productTitle" },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]),
    ProductField.aggregate([
      { $match: { shop } },
      {
        $group: {
          _id: { $ifNull: ["$language", "en"] },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]),
    ProductField.aggregate([
      { $match: { shop } },
      { $group: { _id: "$displayStyle", count: { $sum: 1 } } },
    ]),
    FieldClick.aggregate([
      { $match: { shop, fieldId: { $in: activeFieldIds } } },
      {
        $group: {
          _id: { fieldId: "$fieldId", fieldTitle: "$fieldTitle" },
          count: { $sum: 1 },
          expandCount: { $sum: { $cond: [{ $eq: ["$action", "expand"] }, 1, 0] } },
          tabCount: { $sum: { $cond: [{ $eq: ["$action", "tab_click"] }, 1, 0] } },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    FieldClick.countDocuments({ shop, fieldId: { $in: activeFieldIds } }),
    // Most reused field titles across products
    ProductField.aggregate([
      { $match: { shop } },
      {
        $group: {
          _id: "$title",
          productIds: { $addToSet: "$productId" },
          totalInstances: { $sum: 1 },
        },
      },
      {
        $project: {
          title: "$_id",
          productCount: { $size: "$productIds" },
          totalInstances: 1,
        },
      },
      { $sort: { productCount: -1 } },
      { $limit: 10 },
    ]),
    // Most interactive products by click events (only for existing products)
    FieldClick.aggregate([
      { $match: { shop, fieldId: { $in: activeFieldIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$productId",
          productTitle: { $first: "$productTitle" },
          clicks: { $sum: 1 },
        },
      },
      { $sort: { clicks: -1 } },
      { $limit: 10 },
    ]),
  ]);

  const totalProducts = productGroups.length;
  const avgFieldsPerProduct =
    totalProducts > 0
      ? Math.round((totalFields / totalProducts) * 10) / 10
      : 0;

  const top10 = productGroups.slice(0, 10).map((g) => ({
    id: g._id,
    title: g.title,
    count: g.count,
  }));

  const fieldDistribution = { 1: 0, "2-3": 0, "4-5": 0, "6+": 0 };
  productGroups.forEach(({ count }) => {
    if (count === 1) fieldDistribution[1]++;
    else if (count <= 3) fieldDistribution["2-3"]++;
    else if (count <= 5) fieldDistribution["4-5"]++;
    else fieldDistribution["6+"]++;
  });

  const languages = languageGroups.map((g) => ({
    code: g._id,
    count: g.count,
  }));
  const displayStyles = Object.fromEntries(
    displayStyleGroups.map((g) => [g._id, g.count])
  );
  const monthGrowth =
    fieldsLastMonth > 0
      ? Math.round(
          ((fieldsThisMonth - fieldsLastMonth) / fieldsLastMonth) * 100
        )
      : null;

  const topClicked = topClickedGroups.map((g) => ({
    fieldId: g._id.fieldId,
    fieldTitle: g._id.fieldTitle,
    count: g.count,
    expandCount: g.expandCount,
    tabCount: g.tabCount,
  }));

  const topTitles = topTitleGroups.map((g) => ({
    title: g._id,
    productCount: g.productCount,
    totalInstances: g.totalInstances,
  }));

  function normalizeShopifyProductId(productId) {
    if (typeof productId !== "string") return productId;
    if (/^\d+$/.test(productId)) {
      return `gid://shopify/Product/${productId}`;
    }
    return productId;
  }

  function productIdVariants(productId) {
    const variants = [productId];
    if (/^\d+$/.test(productId)) {
      variants.push(normalizeShopifyProductId(productId));
    } else {
      const match = productId.match(/^gid:\/\/shopify\/Product\/(\d+)$/);
      if (match) {
        variants.push(match[1]);
      }
    }
    return [...new Set(variants)];
  }

  // Join click productIds with known product titles from productGroups
  const productTitleMap = {};
  productGroups.forEach((g) => {
    const id = String(g._id);
    const title = g.title;
    if (title) {
      productIdVariants(id).forEach((variant) => {
        productTitleMap[variant] = title;
      });
    }
  });

  function getMappedProductTitle(productId) {
    return productIdVariants(productId)
      .map((variant) => productTitleMap[variant])
      .find((title) => title && String(title).trim());
  }

  const missingProductIds = [...new Set(
    topProductClickGroups
      .flatMap((g) => productIdVariants(String(g._id)))
      .filter((id) => !getMappedProductTitle(id))
  )];

  if (missingProductIds.length > 0) {
    const missingProducts = await ProductField.find(
      { shop, productId: { $in: missingProductIds } },
      { productId: 1, productTitle: 1 }
    ).lean();
    missingProducts.forEach((product) => {
      const id = String(product.productId);
      const title = String(product.productTitle || "").trim();
      if (title) {
        productIdVariants(id).forEach((variant) => {
          productTitleMap[variant] = title;
        });
      }
    });
  }

  const topProductClicks = topProductClickGroups.map((g) => ({
    productId: g._id,
    title: String(g.productTitle || getMappedProductTitle(String(g._id)) || g._id).trim() || g._id,
    clicks: g.clicks,
  }));

  return {
    totalFields,
    totalProducts,
    avgFieldsPerProduct,
    fieldsThisMonth,
    fieldsLast7Days,
    monthGrowth,
    top10,
    fieldDistribution,
    languages,
    displayStyles,
    topClicked,
    totalClicks,
    topTitles,
    topProductClicks,
  };
}
