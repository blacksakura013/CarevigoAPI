const createApp = require("./createApp");

async function startServer({
  connect = require("./config/db"),
  buildApp = createApp,
  startWorker = require("./services/review.service").startReviewWorker,
  port = process.env.PORT || 8080,
  host = "0.0.0.0",
} = {}) {
  const connection = await connect();
  if (!connection || connection.connection?.readyState !== 1) {
    throw new Error("MongoDB is not ready");
  }
  const app = buildApp();
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.once("error", reject);
  });
  // Explicit opt-out supports local diagnosis without consuming a deployment's
  // pending review/outbox backlog. An absent setting preserves normal startup.
  const worker = process.env.REVIEW_WORKER_ENABLED?.trim().toLowerCase() === "false" ? null : startWorker();
  console.log(`Save Stroke API listening on port ${server.address().port}`);
  return { app, server, worker };
}

if (require.main === module) {
  if (process.env.NODE_ENV !== "production") {
    require("dotenv").config();
    require("dotenv").config({ path: ".env.local", override: true });
  }
  startServer().catch(async () => {
    console.error("Save Stroke API startup failed; check database connectivity and server configuration.");
    await require("mongoose").disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { createApp, startServer };
