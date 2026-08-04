import nodemailer from "nodemailer";

// Where contact submissions land. Needs no setup — any inbox can receive.
const TO_EMAIL = "nisarg.patel@xillentech.com";

// ─── Fill these two in ────────────────────────────────────────────────
// The account used to SEND. Outlook.com cannot be used here — Microsoft
// disabled basic auth for personal accounts, so SMTP AUTH fails with
// 535 5.7.139. Gmail + an app password works and is the quickest to set up:
// myaccount.google.com → Security → App passwords.
const SMTP_USER = "sutharprerna01@gmail.com";
const SMTP_PASSWORD = "lglc uueq yacq lwzr";

const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 587;
// ──────────────────────────────────────────────────────────────────────

export async function sendContactEmail({ name, email, subject, message, shop }) {
  if (!SMTP_USER || !SMTP_PASSWORD) {
    throw new Error(
      "SMTP_USER / SMTP_PASSWORD are empty in sendContactEmail.server.js",
    );
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false, // upgrades to TLS via STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD.replace(/\s+/g, "") },
  });

  await transporter.sendMail({
    from: `"CustomVogue" <${SMTP_USER}>`,
    to: TO_EMAIL,
    replyTo: email, // replying goes to whoever filled in the form
    subject: `[CustomVogue] ${subject}`,
    text: `Name: ${name}\nEmail: ${email}\nSubject: ${subject}\nMessage:\n${message}\n\nShop: ${shop}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#2563eb;padding:16px 24px;">
          <h2 style="color:#fff;margin:0;font-size:18px;">New Contact Form Submission</h2>
          <p style="color:#bfdbfe;margin:4px 0 0;font-size:13px;">CustomVogue App — ${shop}</p>
        </div>
        <div style="padding:24px;">
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr>
              <td style="padding:10px 12px;background:#f9fafb;font-weight:600;color:#374151;width:100px;border-radius:4px;">Name</td>
              <td style="padding:10px 12px;color:#111827;">${name}</td>
            </tr>
            <tr>
              <td style="padding:10px 12px;font-weight:600;color:#374151;">Email</td>
              <td style="padding:10px 12px;color:#111827;"><a href="mailto:${email}" style="color:#2563eb;">${email}</a></td>
            </tr>
            <tr>
              <td style="padding:10px 12px;background:#f9fafb;font-weight:600;color:#374151;">Subject</td>
              <td style="padding:10px 12px;color:#111827;">${subject}</td>
            </tr>
          </table>
          <div style="margin-top:20px;">
            <p style="font-weight:600;color:#374151;font-size:14px;margin-bottom:8px;">Message</p>
            <div style="background:#f9fafb;border-left:4px solid #2563eb;padding:14px 16px;border-radius:4px;color:#111827;font-size:14px;line-height:1.7;">
              ${message.replace(/\n/g, "<br/>")}
            </div>
          </div>
        </div>
      </div>
    `,
  });

  console.log(`[sendContactEmail] ✅ Email sent to ${email} | subject: ${subject}`);
}
