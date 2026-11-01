const User = require("../models/User");
const Health = require("../models/Health");
const { calculateThaiCvRisk } = require("../utils/thaiCvRisk");
const { APPROVED_FILTER } = require("../utils/review");
const ids = require("./internalIds.service");
const { documentFilter, healthForUser } = require("../utils/internalQueries");
const pending = new Map();

async function calculateRiskForProfile(user, profile) {
  const filter = { $and: [
    healthForUser(user), APPROVED_FILTER
  ] };
  const [bloodPressure, cholesterol] = await Promise.all([
    Health.findOne({ ...filter, type: "blood_pressure" }).sort({ createdAt: -1, _id: -1 }),
    Health.findOne({ ...filter, type: "cholesterol" }).sort({ createdAt: -1, _id: -1 })
  ]);
  return calculateThaiCvRisk(profile, {
    systolic: bloodPressure?.value?.systolic, totalCholesterol: cholesterol?.value?.total,
    bloodPressureRecordedAt: bloodPressure?.createdAt, cholesterolRecordedAt: cholesterol?.createdAt
  });
}

async function calculateAndStore(user) {
  const currentUser = await (ids.getInternalId(user) === undefined ? User.findById(user._id) : User.findOne(documentFilter(user)));
  if (!currentUser) throw new Error("Patient no longer exists");
  const risk = await calculateRiskForProfile(currentUser, currentUser);
  if (ids.getInternalId(currentUser) === undefined) await User.findByIdAndUpdate(currentUser._id, { $set: { thaiCvRisk: risk } });
  else await User.findOneAndUpdate(documentFilter(currentUser), { $set: { thaiCvRisk: risk } });
  return risk;
}

// Serialize grouped saves for one account. GET /patient/me recalculates from persisted
// measurements after all saves, including requests handled by another server instance.
function refreshUserThaiCvRisk(user) {
  const key = ids.getInternalId(user) === undefined ? String(user._id) : `internal:${ids.getInternalId(user)}`;
  const previous = pending.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => calculateAndStore(user));
  pending.set(key, task);
  return task.finally(() => { if (pending.get(key) === task) pending.delete(key); });
}

module.exports = { refreshUserThaiCvRisk, calculateRiskForProfile };
