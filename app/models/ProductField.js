import mongoose from "mongoose";

const productFieldSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, index: true },
    productId: { type: String, required: true, index: true },
    productTitle: { type: String, required: true },
    handle: { type: String, default: "" },
    title: { type: String, required: true },
    titleFont: { type: String, default: "" },
    content: { type: String, default: "" },
    sortOrder: { type: Number, default: 0 },
    displayStyle: {
      type: String,
      enum: ["accordion", "tabs"],
      default: "accordion",
    },
    language: { type: String, default: "en" },
  },
  { timestamps: true }
);

productFieldSchema.index({ productId: 1, sortOrder: 1 });

export default mongoose.models.ProductField ||
  mongoose.model("ProductField", productFieldSchema);
