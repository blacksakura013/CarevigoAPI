// ======================================
// src/services/token.service.js
// ======================================

const jwt = require("jsonwebtoken");

// ======================================
// GENERATE TOKEN PAIR
// ======================================

exports.generateTokenPair = (payload) => {
  if (!payload?.id) {
    throw new Error("Invalid payload");
  }

  const tokenPayload = {
    id: payload.id,
    email: payload.email,
    role: payload.role || "admin",
    type: payload.type || "admin",
  };

  const accessToken = jwt.sign(
    tokenPayload,
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRE || "7d",
    }
  );

  const refreshToken = jwt.sign(
    tokenPayload,
    process.env.JWT_REFRESH_SECRET,
    {
      expiresIn:
        process.env.JWT_REFRESH_EXPIRE || "30d",
    }
  );

  return {
    accessToken,
    refreshToken,
  };
};

// ======================================
// VERIFY ACCESS TOKEN
// ======================================

exports.verifyAccessToken = (token) => {
  return jwt.verify(
    token,
    process.env.JWT_SECRET
  );
};

// ======================================
// VERIFY REFRESH TOKEN
// ======================================

exports.verifyRefreshToken = (token) => {
  return jwt.verify(
    token,
    process.env.JWT_REFRESH_SECRET
  );
};

// ======================================
// REFRESH TOKEN
// ======================================

exports.refreshToken = (refreshToken) => {

  const decoded =
    exports.verifyRefreshToken(refreshToken);

  return exports.generateTokenPair(decoded);
};

// ======================================
// EXTRACT TOKEN
// ======================================

exports.extractToken = (req) => {

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    throw new Error("Authorization header required");
  }

  if (!authHeader.startsWith("Bearer ")) {
    throw new Error("Invalid authorization format");
  }

  return authHeader.replace("Bearer ", "");
};