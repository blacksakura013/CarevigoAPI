if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
  require("dotenv").config({ path: ".env.local", override: true });
}

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const connectDB = require("./config/db");

// routes
const authRoutes = require("./routes/auth.routes");
const publicRoutes = require("./routes/public.routes");
const userRoutes = require("./routes/user.routes");
const lineRoutes = require("./routes/line.routes");

const app = express();

// ===============================
// 🔧 CORE
// ===============================
app.use(helmet());

// ===============================
// 🔥 LINE WEBHOOK ต้องมาก่อน json
// ===============================
app.use("/api/line", lineRoutes);

// ===============================
// 📦 BODY PARSER (หลัง LINE)
// ===============================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ===============================
// 🌐 CORS
// ===============================
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

// ===============================
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ===============================
// 🧪 HEALTH
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

// ===============================
// ❌ 404
// ===============================
app.use((req, res) => {
  res.status(404).json({
    statusCode: 404,
    title: "Not Found",
    message: "Route not found",
  });
});

// ===============================
// ⚠️ ERROR
// ===============================
app.use((err, req, res, next) => {
  console.error("❌ ERROR:", err);
  res.status(500).json({
    statusCode: 500,
    message: err.message,
  });
});

// ===============================
// 🚀 START
// ===============================
const startServer = async () => {
  try {
    await connectDB();
    app.listen(process.env.PORT || 3000, () =>
      console.log("🚀 Server running")
    );
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

startServer();