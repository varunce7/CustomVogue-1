import mongoose from "mongoose";

const fieldClickSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, index: true },
    productId: { type: String, required: true },
    productTitle: { type: String, default: "" },
    fieldId: { type: String, required: true },
    fieldTitle: { type: String, default: "" },
    action: { type: String, enum: ["expand", "tab_click"], default: "expand" },
  },
  { timestamps: true }
);

fieldClickSchema.index({ shop: 1, fieldId: 1 });
fieldClickSchema.index({ shop: 1, createdAt: -1 });

export default mongoose.models.FieldClick ||
  mongoose.model("FieldClick", fieldClickSchema);
