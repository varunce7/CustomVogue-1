import mongoose from "mongoose";

const opts = {
  family: 4,                      // force IPv4 — fixes EREFUSED on mongodb+srv:// SRV lookups
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
};

// Holding the promise from `mongoose.connect()` directly means a failed cold
// start is remembered for the life of the instance: every later `await
// connection` rethrows that first error even once Mongo is reachable again.
// Connect lazily and forget the promise when it rejects, so the next request
// retries instead of replaying the failure.
function connect() {
  if (!globalThis.__mongooseConnection) {
    globalThis.__mongooseConnection = mongoose
      .connect(process.env.MONGODB_URI, opts)
      .catch((error) => {
        globalThis.__mongooseConnection = null;
        throw error;
      });
  }
  return globalThis.__mongooseConnection;
}

// Awaitable exactly like the promise this module used to export — every `await
// connection` call site keeps working — but each await re-enters connect().
const connection = {
  then: (onFulfilled, onRejected) => connect().then(onFulfilled, onRejected),
};

export default connection;
