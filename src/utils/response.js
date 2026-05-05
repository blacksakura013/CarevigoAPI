exports.success = ({
  res,
  statusCode = 200,
  message = "Success",
  data = [],
  total = 0,
  page = 1,
  limit = 10
}) => {
  return res.status(statusCode).json({
    statusCode,
    title: "Success",
    message,
    total,
    page,
    limit,
    hasMore: page * limit < total,
    data
  });
};

exports.error = ({
  res,
  statusCode = 500,
  message = "Internal Server Error"
}) => {
  return res.status(statusCode).json({
    statusCode,
    title: "Error",
    message,
    data: null
  });
};