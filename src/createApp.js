const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const mongoose = require("mongoose");
const { allowedOrigins } = require("./config/origins");
const { jsonReplacer } = require("./utils/json");

// Build the production HTTP stack without starting a server, worker or database.
function createApp({ enableLine = true, logRequests = true } = {}) {
  const app = express();
  app.set("json replacer", jsonReplacer);
  const proxySetting = process.env.TRUST_PROXY_HOPS;
  if (proxySetting !== undefined) {
    const hops = Number(proxySetting);
    if (/^\d+$/.test(proxySetting) && Number.isInteger(hops) && hops >= 0 && hops <= 5) app.set("trust proxy", hops);
    else console.warn("TRUST_PROXY_HOPS ignored: expected an integer from 0 to 5");
  }
  app.use(helmet());
  app.use("/api", (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins().includes(origin)) return callback(null, true);
      const error = new Error("CORS blocked"); error.status = 403; callback(error);
    },
    credentials: true,
    exposedHeaders: ["X-Carevigo-Session-Id", "Retry-After"],
  }));
  if (logRequests) {
    morgan.token("safe-url", req => req.path);
    app.use(morgan(":remote-addr :method :safe-url :status :response-time ms"));
  }
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.get("/", (req, res) => res.json({ service: "Save Stroke API", status: "RUNNING", timestamp: new Date() }));
  app.get("/api/health", (req, res) => {
    const connected = mongoose.connection.readyState === 1;
    if (!connected) res.set("Retry-After", "3");
    res.status(connected ? 200 : 503).json({
      status: connected ? "OK" : "NOT_READY", uptime: process.uptime(), timestamp: new Date(),
      mongodb: connected ? "CONNECTED" : "DISCONNECTED",
    });
  });
  if (enableLine) {
    try { app.use("/api/line", require("./routes/line.routes")); }
    catch (error) { console.error("LINE routes unavailable:", error.message); }
  }
  app.use("/api/auth", require("./routes/auth.routes"));
  app.use("/api/public", require("./routes/public.routes"));
  app.use("/api/users", require("./routes/user.routes"));
  app.use("/api/dashboard", require("./routes/dashboard.routes"));
  app.use("/api/reviews", require("./routes/review.routes"));
  app.use((req, res) => res.status(404).json({ statusCode: 404, title: "Not Found", message: "Route not found" }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const candidate = error.status || error.statusCode;
    const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
    // Raw errors can contain request bodies or connection credentials.
    if (status >= 500) console.error("API request failed:", error.name || "Error");
    res.status(status).json({ statusCode: status,
      message: process.env.NODE_ENV === "production" || status >= 500
        ? (status >= 500 ? "Internal Server Error" : "Invalid request") : error.message,
    });
  });
  return app;
}

module.exports = createApp;
