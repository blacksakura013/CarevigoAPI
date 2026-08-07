// ======================================
// src/middleware/auth.middleware.js
// ======================================

const jwt = require("jsonwebtoken");

// ======================================
// VERIFY JWT
// ======================================

module.exports = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        statusCode: 401,
        title: "Unauthorized",
        message: "Authorization header is required",
      });
    }

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        statusCode: 401,
        title: "Unauthorized",
        message: "Invalid authorization format",
      });
    }

    const token = authHeader.substring(7);

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      type: decoded.type,
    };

    next();

  } catch (err) {
    console.error("JWT ERROR:", err.message);

    return res.status(401).json({
      statusCode: 401,
      title: "Unauthorized",
      message: "Invalid or expired token",
    });
  }
};