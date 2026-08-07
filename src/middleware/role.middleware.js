module.exports = (...roles) => {
  return (req, res, next) => {

    if (!req.user) {
      return res.status(401).json({
        statusCode: 401,
        message: "Unauthorized",
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        statusCode: 403,
        message: "Permission denied",
      });
    }

    next();
  };
};