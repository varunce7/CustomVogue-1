import { authenticate } from "../shopify.server";
import { saveContactSubmission } from "../utils/contactSubmission.server.js";
import { sendContactEmail } from "../utils/sendContactEmail.server.js";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const name = formData.get("name")?.toString().trim() ?? "";
  const email = formData.get("email")?.toString().trim() ?? "";
  const subject = formData.get("subject")?.toString().trim() ?? "";
  const message = formData.get("message")?.toString().trim() ?? "";

  if (!name || !email || !subject || !message) {
    return { error: "All fields are required." };
  }

  const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;
  if (!EMAIL_REGEX.test(email)) {
    return { error: "Please enter a valid email address." };
  }

  await saveContactSubmission({ shop: session.shop, name, email, subject, message });

  let emailSent = false;
  try {
    await sendContactEmail({ name, email, subject, message, shop: session.shop });
    emailSent = true;
  } catch (err) {
    console.error("[contact] Email send failed:", err.message);
  }

  return { success: true, emailSent };
};
