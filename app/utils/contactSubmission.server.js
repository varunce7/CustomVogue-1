import ContactSubmission from "../models/ContactSubmission.js";
import connection from "../db.server.js";

export async function saveContactSubmission(data) {
  await connection;
  return ContactSubmission.create(data);
}

export async function getContactSubmissions(shop) {
  await connection;
  return ContactSubmission.find({ shop }).sort({ createdAt: -1 }).lean();
}

export async function markSubmissionRead(id) {
  await connection;
  return ContactSubmission.findByIdAndUpdate(id, { read: true });
}

export async function deleteSubmission(id) {
  await connection;
  return ContactSubmission.findByIdAndDelete(id);
}

export async function markContactEmailSent(shop, email, subject) {
  await connection;
  return ContactSubmission.findOneAndUpdate(
    { shop, email, subject, emailSent: false },
    { emailSent: true },
    { sort: { createdAt: -1 } }
  );
}
