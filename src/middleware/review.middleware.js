module.exports = (req, res, next) => {
  require("../services/review.service").approveOverdue().then(() => next()).catch(next);
};
