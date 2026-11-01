const { reviewFilter } = require("./review");

function mapProfileFilter(value) {
  if (Array.isArray(value)) return value.map(mapProfileFilter);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key === "reviewStatus" ? "profileReviewStatus" : key === "materializedAt" ? "profileMaterializedAt"
      : key === "createdAt" ? "submittedAt" : key.replace(/^submittedProfile\./, "profile."), mapProfileFilter(item),
  ]));
}

function profileReviewFilter(filters = {}, cutoff) {
  return { $and: [{ profileOnly: true, profileMaterializedAt: { $exists: true } }, mapProfileFilter(reviewFilter(filters, cutoff))] };
}

function profileReviewRow(submission, { privateFields = false } = {}) {
  const value = submission.toObject ? submission.toObject() : { ...submission };
  return { _id: value._id, internalId: value.internalId, type: "profile", reviewEntity: "submission-profile", profileOnly: true,
    submissionId: value._id, submissionKey: value.internalId, value: {}, reviewStatus: value.profileReviewStatus || "pending",
    reviewHistory: value.profileReviewHistory || [], submittedAt: value.submittedAt, createdAt: value.submittedAt,
    materializedAt: value.profileMaterializedAt, reviewDueAt: value.reviewDueAt, reviewedAt: value.profileReviewedAt,
    reviewSource: value.profileReviewSource, reviewReason: value.profileReviewReason, source: "guest",
    ...(privateFields ? { citizenId: value.citizenId, userId: value.userId, userKey: value.userKey,
      userByKey: submission.userByKey, submittedProfile: value.profile, legalAgreement: value.legalAgreement } : {}) };
}

module.exports = { profileReviewFilter, profileReviewRow };
