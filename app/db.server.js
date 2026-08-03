import mongoose from "mongoose";

const opts = {
  family: 4,                      // force IPv4 — fixes EREFUSED on mongodb+srv:// SRV lookups
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
};

let connection;

if (process.env.NODE_ENV !== "production") {
  if (!global.__mongooseConnection) {
    global.__mongooseConnection = mongoose.connect(process.env.MONGODB_URI, opts);
  }
  connection = global.__mongooseConnection;
} else {
  connection = mongoose.connect(process.env.MONGODB_URI, opts);
}

export default connection;
