const jwt = require("jsonwebtoken");

// 🔐 ตรวจ token + attach user เข้า req
module.exports = (req, res, next) => {
  try {
    // 🔍 ดึง header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        statusCode: 401,
        title: "Unauthorized",
        message: "No token provided"
      });
    }

    // format: Bearer token
    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        statusCode: 401,
        title: "Unauthorized",
        message: "Invalid token format"
      });
    }

    // 🔑 verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // attach user ไปให้ controller ใช้
    req.user = decoded;

    next();

  } catch (err) {
    return res.status(401).json({
      statusCode: 401,
      title: "Unauthorized",
      message: "Invalid or expired token"
    });
  }
};