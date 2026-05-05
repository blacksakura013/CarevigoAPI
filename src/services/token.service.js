const jwt = require("jsonwebtoken");

// 🔐 Generate Tokens
exports.generateTokens = (admin) => {
  if (!admin || !admin._id) {
    throw new Error("Invalid admin data for token generation");
  }

  const payload = {
    id: admin._id,
    role: admin.role || "admin"
  };

  // 🎯 Access Token (short-lived)
  const accessToken = jwt.sign(
    payload,
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRE || "15m"
    }
  );

  // 🔄 Refresh Token (long-lived)
  const refreshToken = jwt.sign(
    { id: admin._id },
    process.env.JWT_REFRESH_SECRET,
    {
      expiresIn: process.env.JWT_REFRESH_EXPIRE || "7d"
    }
  );

  return {
    accessToken,
    refreshToken
  };
};



// 🔍 Verify Access Token
exports.verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    throw new Error("Invalid or expired access token");
  }
};



// 🔍 Verify Refresh Token
exports.verifyRefreshToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch (err) {
    throw new Error("Invalid or expired refresh token");
  }
};



// 🔄 Refresh Access Token
exports.refreshAccessToken = (refreshToken) => {
  const decoded = this.verifyRefreshToken(refreshToken);

  const newAccessToken = jwt.sign(
    {
      id: decoded.id,
      role: decoded.role || "admin"
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRE || "15m"
    }
  );

  return {
    accessToken: newAccessToken
  };
};



// 🧹 Extract Token from Header
exports.extractToken = (req) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    throw new Error("No authorization header");
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    throw new Error("Invalid token format");
  }

  return token;
};