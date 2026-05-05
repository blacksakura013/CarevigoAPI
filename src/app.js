
  require("dotenv").config();
  require("dotenv").config({ path: ".env.local", override: true });


const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const connectDB = require("./config/db");

// routes (ของคุณ)
const authRoutes = require("./routes/auth.routes");
const publicRoutes = require("./routes/public.routes");
const userRoutes = require("./routes/user.routes");
const lineRoutes = require("./routes/line.routes");

const app = express();

// ===============================
// 🔧 CORE MIDDLEWARE
// ===============================
app.use(helmet());

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS สำหรับ frontend
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
        callback(new Error("CORS blocked"));
      }
    },
    credentials: true,
  })
);

// 🔥 สำคัญ: เปิด CORS ให้ LINE webhook (ไม่ติด origin)
app.use("/api/line", cors({ origin: true }));

app.use(
  morgan(process.env.NODE_ENV === "production" ? "combined" : "dev")
);

// ===============================
// 🧪 HEALTH CHECK
// ===============================
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    uptime: process.uptime(),
    timestamp: new Date(),
  });
});

// ===============================
// 📌 ROUTES
// ===============================
app.use("/api/auth", authRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/users", userRoutes);
app.use("/api/line", lineRoutes);

// ===============================
// ❌ 404 HANDLER
// ===============================
app.use((req, res) => {
  res.status(404).json({
    statusCode: 404,
    title: "Not Found",
    message: "Route not found",
  });
});

// ===============================
// ⚠️ GLOBAL ERROR HANDLER
// ===============================
app.use((err, req, res, next) => {
  console.error("❌ ERROR:", err);

  res.status(err.statusCode || 500).json({
    statusCode: err.statusCode || 500,
    title: "Error",
    message: err.message || "Internal Server Error",
  });
});

// ===============================
// 🚀 START SERVER
// ===============================
const startServer = async () => {
  try {
    await connectDB();

    const PORT = process.env.PORT || 3000;

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
};

startServer();