const mongoose = require("mongoose");
const crypto = require("node:crypto");
const Health = require("../models/Health");
const User = require("../models/User");
const Admin = require("../models/Admin");
const Submission = require("../models/Submission");
const Outbox = require("../models/ReviewOutbox");
const email = require("./email.service");
const { refreshUserThaiCvRisk, calculateRiskForProfile } = require("./thaiCvRisk.service");
const { tokenFor, hashToken, reviewDocumentFilter } = require("../utils/review");
const ids = require("./internalIds.service");

function frontendOrigin() {
  try {
    const configured = new URL(process.env.FRONTEND_URL || "https://carevigo-frontend.onrender.com");
    if (configured.protocol === "https:" || (configured.protocol === "http:" && ["localhost", "127.0.0.1"].includes(configured.hostname))) return configured.origin;
  } catch {}
  return "https://carevigo-frontend.onrender.com";
}
function emailToken(job) { return tokenFor("email-review", job._id, job.submissionId, job.adminId); }

async function ensureSubmissionKeys(submission) {
  const submissionKey = await ids.ensureInternalId(Submission, submission);
  let userKey = submission.userKey === undefined ? undefined : ids.toInternalId(submission.userKey);
  if (userKey === undefined && submission.userId) {
    const user = await User.findOne({ _id: submission.userId });
    if (user) {
      userKey = await ids.ensureInternalId(User, user);
      await Submission.updateOne({ $and: [reviewDocumentFilter(submission), { userKey: { $exists: false } }] }, { $set: { userKey } });
      const latest = await Submission.findOne(reviewDocumentFilter(submission));
      if (latest?.userKey !== undefined) userKey = ids.toInternalId(latest.userKey);
      submission.userKey = userKey;
    }
  }
  return { submissionKey, userKey };
}

async function ensureRecordKey(submission, record) {
  const existingKey = ids.getInternalId(record);
  if (existingKey !== undefined) return existingKey;
  // Reserve in the durable submission first. Concurrent recovery must reuse the
  // winner's key, even when its Health upsert has not completed yet.
  const existing = await Health.findOne({ _id: record._id });
  const candidate = existing ? await ids.ensureInternalId(Health, existing) : await ids.allocateInternalId("Health");
  await Submission.collection.updateOne({ $and: [reviewDocumentFilter(submission), {
    records: { $elemMatch: { _id: record._id, internalId: { $exists: false } } }
  }] }, { $set: { "records.$.internalId": ids.toInternalId(candidate) } });
  const latest = await Submission.findOne(reviewDocumentFilter(submission));
  const winner = latest?.records?.find(item => String(item._id) === String(record._id));
  const key = ids.getInternalId(winner);
  if (key === undefined) throw new Error("Submission record identity was not durably reserved");
  record.internalId = key;
  return key;
}

async function materializeSubmission(submission) {
  const { submissionKey, userKey } = await ensureSubmissionKeys(submission);
  for (const record of submission.records) {
    const internalId = await ensureRecordKey(submission, record);
    const data = record.toObject ? record.toObject() : { ...record };
    // A source may predate the migration while its stable ObjectId Health row
    // already exists. Fill only the absent key, never replace an existing one.
    await Health.collection.updateOne({ _id: data._id, internalId: { $exists: false } }, { $set: { internalId } });
    const identity = ids.identityFilter({ key: internalId, legacyId: data._id });
    await Health.updateOne(identity, { $setOnInsert: {
      ...data, internalId, userId: submission.userId, ...(userKey === undefined ? {} : { userKey }), citizenId: submission.citizenId,
      submissionId: submission._id, submissionKey, source: "guest", submittedProfile: submission.profile,
      ...(submission.legalAgreement ? { legalAgreement: submission.legalAgreement } : {}),
      submittedAt: submission.submittedAt, createdAt: submission.submittedAt, materializedAt: new Date(),
      reviewDueAt: submission.reviewDueAt, reviewStatus: "pending", isVerified: false,
      reviewHistory: [{ at: submission.submittedAt, status: "pending", from: null, to: "pending", source: "guest", reason: "ส่งข้อมูลโดยไม่เข้าสู่ระบบ" }]
    } }, { upsert: true, runValidators: true });
    for (const [field, value] of Object.entries({ userKey, submissionKey })) {
      if (value !== undefined) await Health.updateOne({ $and: [identity, { [field]: { $exists: false } }] }, { $set: { [field]: value } });
    }
  }
  await Submission.updateOne(reviewDocumentFilter(submission), { $set: { materialized: true } });
}

async function prepareNotifications(submission) {
  const { submissionKey } = await ensureSubmissionKeys(submission);
  const admins = await Admin.find({ isActive: true });
  for (const admin of admins) {
    if (!admin.email) continue;
    const adminKey = await ids.ensureInternalId(Admin, admin);
    const job = { _id: new mongoose.Types.ObjectId(), internalId: await ids.allocateInternalId("ReviewOutbox"),
      submissionId: submission._id, submissionKey, adminId: admin._id, adminKey, recipient: admin.email,
      expiresAt: new Date(submission.submittedAt.getTime() + 7 * 24 * 60 * 60 * 1000), status: "pending", nextAttemptAt: new Date() };
    job.tokenHash = hashToken(emailToken(job));
    const relation = { $and: [
      ids.relationFilter({ keyField: "submissionKey", key: submissionKey, legacyField: "submissionId", legacyId: submission._id }),
      ids.relationFilter({ keyField: "adminKey", key: adminKey, legacyField: "adminId", legacyId: admin._id })
    ] };
    await Outbox.updateOne(relation, { $setOnInsert: job }, { upsert: true, runValidators: true });
  }
  await Submission.updateOne(reviewDocumentFilter(submission), { $set: { notificationsPrepared: true } });
}

async function refreshReviewedUser({ userId, userKey }) {
  const user = await User.findOne(ids.identityFilter({ key: userKey, legacyId: userId }));
  if (user) await refreshUserThaiCvRisk(user);
}

async function decidePending(filter, { action, source, actorId, actorKey, reason = "", at = new Date() }) {
  const status = action === "approve" ? "approved" : "rejected";
  const pendingFilter = { $and: [filter, { reviewStatus: "pending" }] };
  let changed = 0;
  const users = new Map();
  const snapshots = new Map();
  while (true) {
    const rows = await Health.find(pendingFilter).sort({ _id: 1 }).limit(100);
    if (!rows.length) break;
    for (const row of rows) {
      const updated = await Health.findOneAndUpdate({ $and: [reviewDocumentFilter(row), { reviewStatus: "pending" }] }, {
        $set: { reviewStatus: status, reviewedAt: at, reviewSource: source, reviewReason: reason },
        $push: { reviewHistory: { at, status, from: "pending", to: status, source,
          actor: actorId ? String(actorId) : undefined, actorId: actorId ? String(actorId) : undefined,
          ...(actorKey === undefined ? {} : { adminKey: ids.toInternalId(actorKey) }), reason } }
      }, { new: true });
      if (updated) {
        changed += 1;
        const userKey = updated.userKey === undefined ? undefined : ids.toInternalId(updated.userKey);
        users.set(userKey === undefined ? `legacy:${updated.userId}` : `key:${userKey}`, { userId: updated.userId, userKey });
        if (status === "approved" && updated.submissionId && updated.submittedProfile) {
          const key = updated.submissionKey === undefined ? `legacy:${updated.submissionId}` : `key:${ids.toInternalId(updated.submissionKey)}`;
          if (!snapshots.has(key)) snapshots.set(key, { row: updated, identities: [] });
          snapshots.get(key).identities.push(reviewDocumentFilter(updated));
        }
      }
    }
  }
  for (const user of users.values()) {
    try { await refreshReviewedUser(user); } catch { /* GET /me can recover an assessment refresh. */ }
  }
  for (const { row, identities } of snapshots.values()) {
    try {
      const risk = await calculateRiskForProfile({ _id: row.userId, internalId: row.userKey, citizenId: row.citizenId }, row.submittedProfile);
      risk.inputs.profileSource = "submitted-profile";
      await Health.updateMany({ $and: [{ $or: identities }, { reviewStatus: "approved" }] }, { $set: { thaiCvRisk: risk } });
    } catch { /* The state transition and audit stay durable if risk refresh fails. */ }
  }
  return changed;
}

async function decidePendingProfiles(filter, { action, source, actorId, actorKey, reason = "", at = new Date() }) {
  const status = action === "approve" ? "approved" : "rejected";
  const pending = { $and: [{ profileOnly: true }, filter, { profileReviewStatus: "pending" }] };
  let changed = 0;
  while (true) {
    const rows = await Submission.find(pending).sort({ _id: 1 }).limit(100);
    if (!rows.length) break;
    for (const row of rows) {
      const updated = await Submission.findOneAndUpdate({ $and: [reviewDocumentFilter(row), { profileOnly: true, profileReviewStatus: "pending" }] }, {
        $set: { profileReviewStatus: status, profileReviewedAt: at, profileReviewSource: source, profileReviewReason: reason },
        $push: { profileReviewHistory: { at, status, from: "pending", to: status, source,
          actor: actorId ? String(actorId) : undefined, actorId: actorId ? String(actorId) : undefined,
          ...(actorKey === undefined ? {} : { adminKey: ids.toInternalId(actorKey) }), reason } },
      }, { new: true });
      if (updated) changed++;
    }
  }
  // Reviewing a submitted snapshot never overwrites an existing official
  // profile and never creates a fictional measurement or health history row.
  return changed;
}

let approving;
function approveOverdue(now = new Date()) {
  if (approving) return approving;
  const decision = { action: "approve", source: "automatic", at: now,
    reason: "อนุมัติอัตโนมัติเมื่อพ้นเวลา 23:59 น. ของวันส่งข้อมูล (Asia/Bangkok)" };
  approving = Promise.all([decidePending({ reviewDueAt: { $lte: now } }, decision),
    decidePendingProfiles({ reviewDueAt: { $lte: now } }, decision)]).then(values => values.reduce((sum, value) => sum + value, 0))
    .finally(() => { approving = null; });
  return approving;
}

async function sendOutbox(now = new Date()) {
  for (let count = 0; count < 20; count++) {
    const leaseId = crypto.randomUUID();
    const job = await Outbox.findOneAndUpdate({ $or: [
      { status: { $in: ["pending", "failed"] }, nextAttemptAt: { $lte: now } },
      { status: "sending", leaseUntil: { $lte: now } }
    ] }, { $set: { status: "sending", leaseUntil: new Date(now.getTime() + 5 * 60 * 1000), leaseId }, $inc: { attempts: 1 } },
    { new: true, sort: { createdAt: 1 } });
    if (!job) break;
    // A slow SMTP request can outlive its lease. Only this claim may finish it;
    // an earlier worker must never replace a newer worker's durable result.
    const owned = { $and: [reviewDocumentFilter(job), { status: "sending", leaseId }] };
    const releaseLease = { leaseUntil: 1, leaseId: 1 };
    try {
      if (job.expiresAt <= now) {
        await Outbox.updateOne(owned, { $set: { status: "expired", lastError: "Review link expired" }, $unset: releaseLease });
        continue;
      }
      const admin = await Admin.findOne({ $and: [ids.identityFilter({ key: job.adminKey, legacyId: job.adminId }), { isActive: true }] });
      if (!admin) {
        await Outbox.updateOne(owned, { $set: { status: "failed", lastError: "Recipient no longer active", nextAttemptAt: new Date(now.getTime() + 86400000) }, $unset: releaseLease });
        continue;
      }
      const submission = await Submission.findOne(ids.identityFilter({ key: job.submissionKey, legacyId: job.submissionId }));
      if (!submission) throw new Error("Submission missing");
      const token = emailToken(job);
      const ownership = await Outbox.updateOne(owned, { $set: { tokenHash: hashToken(token) } });
      if (ownership?.matchedCount === 0) continue;
      const link = action => { const url = new URL("/review-email", frontendOrigin()); url.searchParams.set("token", token); url.searchParams.set("action", action); return url.href; };
      await email.sendReviewNotification({ recipient: job.recipient,
        patientName: [submission.profile.firstName, submission.profile.lastName].filter(Boolean).join(" "),
        recordCount: submission.records.length,
        profileOnly: submission.profileOnly === true,
        deadlineLabel: new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }).format(submission.reviewDueAt),
        approveUrl: link("approve"), rejectUrl: link("reject") });
      await Outbox.updateOne(owned, { $set: { status: "sent", sentAt: new Date(), lastError: "" }, $unset: releaseLease });
    } catch {
      const delay = Math.min(3600000, 60000 * Math.pow(2, Math.min(job.attempts - 1, 6)));
      await Outbox.updateOne(owned, { $set: { status: "failed", lastError: "Email delivery failed", nextAttemptAt: new Date(now.getTime() + delay) }, $unset: releaseLease });
    }
  }
}

let working;
async function runReviewWorker() {
  if (working) return working;
  working = (async () => {
    const unfinished = await Submission.find({ $or: [{ materialized: false }, { notificationsPrepared: false }] }).sort({ submittedAt: 1 }).limit(50);
    for (const submission of unfinished) {
      try {
        if (!submission.materialized) await materializeSubmission(submission);
        if (!submission.notificationsPrepared) await prepareNotifications(submission);
      } catch { /* One failed submission must not block deadlines for others. */ }
    }
    await approveOverdue();
    await sendOutbox();
  })().finally(() => { working = null; });
  return working;
}
function startReviewWorker() {
  const tick = () => {
    // Deadlines run independently even while an SMTP attempt is slow.
    approveOverdue().catch(() => console.error("Review deadline catch-up will retry"));
    runReviewWorker().catch(() => console.error("Review worker will retry unfinished tasks"));
  };
  tick(); const timer = setInterval(tick, 60000); timer.unref(); return timer;
}

module.exports = { materializeSubmission, prepareNotifications, decidePending, decidePendingProfiles, approveOverdue, runReviewWorker, startReviewWorker, sendOutbox };
