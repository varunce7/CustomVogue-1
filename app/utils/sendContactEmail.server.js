import nodemailer from "nodemailer";

const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "nisarg.patel@xillentech.com";

export async function sendContactEmail({ name, email, subject, message, shop }) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");

  const transporter = user && pass
    ? nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    })
    : nodemailer.createTransport({
      sendmail: true,
      newline: true,
      path: process.env.SENDMAIL_PATH || "/usr/sbin/sendmail",
    });

  await transporter.sendMail({
    from: `"CustomVogue" <${process.env.EMAIL_FROM || "no-reply@customvogue.local"}>`,
    to: CONTACT_EMAIL,
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

  console.log(`[sendContactEmail] ✅ Email sent to ${CONTACT_EMAIL} | subject: ${subject}`);
}
