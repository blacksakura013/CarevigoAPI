if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
  require("dotenv").config({ path: ".env.local", override: true });
}

process.on("uncaughtException", (err) => {
  console.error("❌ UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("❌ UNHANDLED REJECTION:", err);
});

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const mongoose = require("mongoose");

const connectDB = require("./config/db");

// routes
const authRoutes = require("./routes/auth.routes");
const publicRoutes = require("./routes/public.routes");
const userRoutes = require("./routes/user.routes");

let lineRoutes = null;

try {
  lineRoutes = require("./routes/line.routes");
} catch (err) {
  console.error("❌ LINE route load failed:", err.message);
}

const app = express();

// ======================================
// SECURITY
// ======================================
app.use(helmet());

// ======================================
// CORS
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
        callback(new Error("CORS blocked"));
      }
    },
    credentials: true,
  })
);

// ======================================
// LOGGER
// ======================================
app.use(
  morgan(process.env.NODE_ENV === "production" ? "combined" : "dev")
);

// ======================================
// BODY PARSER
// ======================================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ======================================
// HEALTH
// ======================================
app.get("/", (req, res) => {
  res.json({
    service: "Carevigo API",
    status: "RUNNING",
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    mongoState: mongoose.connection.readyState,
  });
});

// ======================================
// WAIT FOR DB MIDDLEWARE
// ======================================
app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      statusCode: 503,
      message: "Database not connected",
    });
  }

  next();
});

// ======================================
// ROUTES
// ======================================
if (lineRoutes) {
  app.use("/api/line", lineRoutes);
}

app.use("/api/auth", authRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/users", userRoutes);

// ======================================
// 404
// ======================================
app.use((req, res) => {
  res.status(404).json({
    statusCode: 404,
    message: "Route not found",
  });
});

// ======================================
// ERROR
// ======================================
app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    statusCode: 500,
    message: err.message,
  });
});

// ======================================
// START
// ======================================
const PORT = process.env.PORT || 8080;

const startServer = async () => {
  try {
    console.log("🔄 Connecting MongoDB...");

    await connectDB();

    console.log("✅ MongoDB Connected");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on ${PORT}`);
    });

  } catch (err) {
    console.error("❌ Startup Error:", err);

    process.exit(1);
  }
};

startServer();