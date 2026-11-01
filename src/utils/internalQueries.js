const ids = require("../services/internalIds.service");

function documentFilter(document) {
  const internalId = ids.getInternalId(document);
  return internalId === undefined ? { _id: document._id } : { internalId };
}

function healthForUser(user) {
  const legacy = { $or: [{ userId: user._id }, { citizenId: String(user.citizenId) }] };
  const key = ids.getInternalId(user);
  if (key === undefined) return { $and: [{ userKey: { $exists: false } }, legacy] };
  // A legacy match must never override an existing numeric link to someone else.
  return { $or: [{ userKey: key }, { $and: [{ userKey: { $exists: false } }, legacy] }] };
}

module.exports = { documentFilter, healthForUser };
