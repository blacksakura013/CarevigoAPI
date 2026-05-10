if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
  require("dotenv").config({ path: ".env.local", override: true });
}

// ======================================
// 🔥 GLOBAL ERROR HANDLER
// ======================================
process.on("uncaughtException", (err) => {
  console.error("❌ UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("❌ UNHANDLED REJECTION:", err);
});

// ======================================
// 📦 IMPORTS
// ======================================
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");

const connectDB = require("./config/db");

// routes
const authRoutes = require("./routes/auth.routes");
const publicRoutes = require("./routes/public.routes");
const userRoutes = require("./routes/user.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
// ⚠️ LINE route อาจ crash ถ้า ENV ไม่มี
let lineRoutes = null;

try {
  lineRoutes = require("./routes/line.routes");
  console.log("✅ LINE routes loaded");
} catch (err) {
  console.error("❌ LINE routes load failed:", err.message);
}

// ======================================
// 🔍 ENV CHECK
// ======================================
console.log("=================================");
console.log("🚀 STARTING CAREVIGO API");
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("PORT:", process.env.PORT);
console.log("MONGO_URI exists:", !!process.env.MONGO_URI);
console.log(
  "LINE_CHANNEL_SECRET exists:",
  !!process.env.LINE_CHANNEL_SECRET
);
console.log(
  "LINE_CHANNEL_ACCESS_TOKEN exists:",
  !!process.env.LINE_CHANNEL_ACCESS_TOKEN
);
console.log("=================================");

// ======================================
// 🚀 APP
// ======================================
const app = express();

// ======================================
// 🔒 SECURITY
// ======================================
app.use(helmet());

// ======================================
// 🌐 CORS
// ======================================
const allowedOrigins = [
  "http://localhost:3000",
  "https://carevigo-frontend.onrender.com",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.error("❌ CORS blocked:", origin);
        callback(new Error("CORS blocked"));
      }
    },
    credentials: true,
  })
);

// ======================================
// 📝 LOGGER
// ======================================
app.use(
  morgan(process.env.NODE_ENV === "production" ? "combined" : "dev")
);

// ======================================
// 📦 BODY PARSER
// ======================================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ======================================
// 🧪 HEALTH CHECK
// ======================================
app.get("/", (req, res) => {
  res.status(200).json({
    service: "Carevigo API",
    status: "RUNNING",
    timestamp: new Date(),
  });
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    uptime: process.uptime(),
    timestamp: new Date(),
    mongodb: process.env.MONGO_URI ? "CONFIGURED" : "MISSING",
  });
});

// ======================================
// 🔥 LINE WEBHOOK
// ======================================
if (lineRoutes) {
  app.use("/api/line", lineRoutes);
}

// ======================================
// 📌 ROUTES
// ======================================
app.use("/api/auth", authRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/users", userRoutes);
app.use("/api/dashboard", dashboardRoutes);

// ======================================
// ❌ 404
// ======================================
app.use((req, res) => {
  res.status(404).json({
    statusCode: 404,
    title: "Not Found",
    message: "Route not found",
  });
});

// ======================================
// ⚠️ ERROR HANDLER
// ======================================
app.use((err, req, res, next) => {
  console.error("❌ EXPRESS ERROR:", err);

  res.status(err.status || 500).json({
    statusCode: err.status || 500,
    message:
      process.env.NODE_ENV === "production"
        ? "Internal Server Error"
        : err.message,
  });
});

// ======================================
// 🚀 START SERVER
// ======================================
const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  try {
    await connectDB();
    console.log("✅ MongoDB connection success");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
  }
});