const mongoose = require("mongoose");
const { toInternalId, MAX_INTERNAL_ID } = require("../utils/internalId");
const { allocateInternalId, ensureInternalId } = require("../services/internalIds.service");
const Counter = require("../models/Counter");

function defaultModels() {
  return [require("../models/User"), require("../models/Admin"), require("../models/Health"),
    require("../models/Submission"), require("../models/ReviewOutbox")];
}
const isLong = value => typeof value === "bigint" || value?._bsontype === "Long";
const sameId = (left, right) => left != null && right != null && String(left) === String(right);
const rawFind = (Model, filter = {}, projection) => Model.collection.find(filter, { projection, useBigInt64: true });
async function relationTarget(Model, row, field, relation, Target) {
  if (row[relation.legacyField] != null) return Target.collection.findOne({ _id: row[relation.legacyField] }, { projection: { internalId: 1 }, useBigInt64: true });
  if (Model.modelName === "Health" && field === "userKey") {
    if (typeof row.citizenId === "string" && row.citizenId) {
      const users = await Target.collection.find({ citizenId: row.citizenId }, { projection: { internalId: 1 }, useBigInt64: true }).limit(2).toArray();
      if (users.length > 1) throw new Error("Ambiguous citizen identity");
      return users[0] || null;
    }
    if (row[field] === undefined) return null;
  }
  if (row[field] !== undefined) return Target.collection.findOne({ internalId: toInternalId(row[field]) }, { projection: { internalId: 1 }, useBigInt64: true });
  return undefined;
}

async function migrateInternalIds({ apply = false, batchSize = 100, models = defaultModels(), onProgress = () => {} } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new RangeError("Batch size must be 1–1000");
  const byName = Object.fromEntries(models.map(Model => [Model.modelName, Model]));
  const report = { mode: apply ? "apply" : "dry-run", models: {}, conflicts: [], assigned: 0, relations: 0, embeddedRecords: 0, normalized: 0 };
  const conflict = (Model, rowId, field, reason) => report.conflicts.push({ model: Model.modelName, id: String(rowId), field, reason });
  const maxima = Object.fromEntries(models.map(Model => [Model.modelName, 0n]));
  const required = Object.fromEntries(models.map(Model => [Model.modelName, 0n]));

  // Audit before any writes. Raw BSON reads avoid schema casting concealing a
  // wrong storage type or an already-rounded JavaScript Number.
  for (const Model of models) {
    const summary = report.models[Model.modelName] = { total: 0, missing: 0, missingRelations: 0, normalized: 0, maximum: "0" };
    const relations = Model.schema.$internalIdRelations || {};
    const cursor = rawFind(Model).batchSize(batchSize);
    for await (const row of cursor) {
      summary.total += 1;
      if (row.internalId === undefined) {
        summary.missing += 1;
        let reserved = false;
        if (Model.modelName === "Health" && byName.Submission) {
          reserved = Boolean(await byName.Submission.collection.findOne({ records: { $elemMatch: { _id: row._id, internalId: { $exists: true } } } }, { projection: { _id: 1 } }));
        }
        if (!reserved) required[Model.modelName] += 1n;
      }
      else {
        try {
          const key = toInternalId(row.internalId);
          if (key > maxima[Model.modelName]) maxima[Model.modelName] = key;
          if (!isLong(row.internalId)) summary.normalized += 1;
        } catch { conflict(Model, row._id, "internalId", "Invalid or imprecise signed int64 identity"); }
      }
      for (const [field, relation] of Object.entries(relations)) {
        if (row[field] !== undefined) {
          try { toInternalId(row[field]); } catch { conflict(Model, row._id, field, "Invalid numeric relation"); continue; }
        }
        const Target = byName[relation.model];
        if (!Target) { conflict(Model, row._id, field, "Referenced model not included"); continue; }
        let target;
        try { target = await relationTarget(Model, row, field, relation, Target); }
        catch { conflict(Model, row._id, field, "Ambiguous or invalid relation identity"); continue; }
        if (target === undefined) continue;
        if (!target) { conflict(Model, row._id, field, "Missing referenced document"); continue; }
        if (row[field] === undefined) summary.missingRelations += 1;
        else if (target.internalId === undefined) conflict(Model, row._id, field, "Keyed relation points to an unkeyed target; explicit resolution required");
        else {
          try { if (toInternalId(row[field]) !== toInternalId(target.internalId)) conflict(Model, row._id, field, "Existing numeric relation disagrees with legacy relation"); }
          catch { conflict(Model, row._id, field, "Referenced identity invalid"); }
        }
      }
    }
    const duplicates = await Model.collection.aggregate([
      { $match: { internalId: { $exists: true } } },
      { $group: { _id: { $convert: { input: "$internalId", to: "long", onError: null, onNull: null } }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }, { $limit: 1 }
    ], { useBigInt64: true }).toArray();
    if (duplicates.length) conflict(Model, "collection", "internalId", "Duplicate existing identities require manual resolution");
  }

  const Submission = byName.Submission, Health = byName.Health;
  if (Submission && Health) {
    const unreserved = new Set();
    for await (const submission of rawFind(Submission, {}, { records: 1 }).batchSize(batchSize)) {
      for (const record of submission.records || []) {
        const health = await Health.collection.findOne({ _id: record._id }, { projection: { internalId: 1 }, useBigInt64: true });
        if (record.internalId === undefined) {
          if (!health && !unreserved.has(String(record._id))) { unreserved.add(String(record._id)); required.Health += 1n; }
          continue;
        }
        try {
          const key = toInternalId(record.internalId);
          if (key > maxima.Health) maxima.Health = key;
          if (health?.internalId !== undefined && toInternalId(health.internalId) !== key) conflict(Submission, submission._id, "records.internalId", "Reserved key conflicts with persisted health identity");
          const collision = await Health.collection.findOne({ _id: { $ne: record._id }, $expr: { $eq: [
            { $convert: { input: "$internalId", to: "long", onError: null, onNull: null } }, key
          ] } }, { projection: { _id: 1 }, useBigInt64: true });
          if (collision) conflict(Submission, submission._id, "records.internalId", "Reserved key belongs to another health record");
        } catch { conflict(Submission, submission._id, "records.internalId", "Invalid reserved health identity"); }
      }
    }
    const collisions = await Submission.collection.aggregate([
      { $unwind: "$records" }, { $match: { "records.internalId": { $exists: true } } },
      { $group: { _id: { $convert: { input: "$records.internalId", to: "long", onError: null, onNull: null } }, records: { $addToSet: "$records._id" } } },
      { $match: { "records.1": { $exists: true } } }, { $limit: 1 }
    ], { useBigInt64: true }).toArray();
    if (collisions.length) conflict(Submission, "collection", "records.internalId", "Different records reserve the same health identity");
    const duplicateRecords = await Submission.collection.aggregate([
      { $unwind: "$records" }, { $group: { _id: "$records._id", count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }, { $limit: 1 }
    ]).toArray();
    if (duplicateRecords.length) conflict(Submission, "collection", "records._id", "Duplicate embedded record IDs require explicit resolution");
  }
  for (const Model of models) {
    const current = await Counter.collection.findOne({ _id: Model.modelName }, { useBigInt64: true });
    if (current) {
      try {
        if (!isLong(current.value)) throw new Error("Wrong counter BSON type");
        const value = toInternalId(current.value, { allowZero: true });
        if (value > maxima[Model.modelName]) maxima[Model.modelName] = value;
      } catch { conflict(Model, "counter", "value", "Counter is invalid; it will not be reset automatically"); }
    }
    report.models[Model.modelName].maximum = maxima[Model.modelName].toString();
    report.models[Model.modelName].requiredAllocations = required[Model.modelName].toString();
    if (maxima[Model.modelName] + required[Model.modelName] > MAX_INTERNAL_ID) conflict(Model, "counter", "value", "Insufficient signed int64 capacity for the audited missing identities");
  }
  onProgress({ phase: "audit", ...report });
  if (!apply) return report;
  if (report.conflicts.length) { const error = new Error("Internal-ID migration blocked by audited conflicts"); error.report = report; throw error; }

  // Align every namespace before assigning anything, including reserved Health
  // keys that have not yet been materialized into the health collection.
  for (const Model of models) {
    await Counter.collection.updateOne({ _id: Model.modelName }, { $max: { value: maxima[Model.modelName] } }, { upsert: true });
  }
  for (const Model of models) {
    for await (const row of rawFind(Model).batchSize(batchSize)) {
      if (row.internalId !== undefined) {
        if (!isLong(row.internalId)) {
          await Model.collection.updateOne({ _id: row._id, internalId: row.internalId }, { $set: { internalId: toInternalId(row.internalId) } });
          report.normalized += 1;
        }
        continue;
      }
      let reserved;
      if (Model.modelName === "Health" && Submission) {
        const source = await Submission.collection.findOne({ "records._id": row._id }, { projection: { records: 1 }, useBigInt64: true });
        const record = source?.records?.find(item => sameId(item._id, row._id));
        if (record?.internalId !== undefined) reserved = toInternalId(record.internalId);
      }
      const key = reserved ?? await allocateInternalId(Model.modelName);
      const result = await Model.collection.updateOne({ _id: row._id, internalId: { $exists: false } }, { $set: { internalId: key } });
      report.assigned += result.modifiedCount;
    }
    onProgress({ phase: "identities", model: Model.modelName, assigned: report.assigned });
  }
  for (const Model of models) {
    const relations = Model.schema.$internalIdRelations || {};
    if (!Object.keys(relations).length) continue;
    for await (const row of rawFind(Model).batchSize(batchSize)) {
      for (const [field, relation] of Object.entries(relations)) {
        const target = await relationTarget(Model, row, field, relation, byName[relation.model]);
        if (target === undefined) continue;
        if (!target) throw new Error("Referenced document disappeared during migration");
        const key = toInternalId(target.internalId);
        if (row[field] !== undefined && toInternalId(row[field]) !== key) throw new Error("Concurrent relation conflict; migration stopped without repointing it");
        if (row[field] === undefined || !isLong(row[field])) {
          const guard = row[field] === undefined ? { $exists: false } : row[field];
          const legacyGuard = row[relation.legacyField] === undefined ? { $exists: false } : row[relation.legacyField];
          const filter = { _id: row._id, [field]: guard, [relation.legacyField]: legacyGuard };
          if (Model.modelName === "Health" && field === "userKey" && row.userId == null && row.citizenId !== undefined) filter.citizenId = row.citizenId;
          const result = await Model.collection.updateOne(filter, { $set: { [field]: key } });
          report.relations += result.modifiedCount;
        }
      }
    }
  }
  if (Submission && Health) {
    for await (const source of rawFind(Submission).batchSize(batchSize)) {
      for (const record of source.records || []) {
        let health = await Health.collection.findOne({ _id: record._id }, { projection: { internalId: 1 }, useBigInt64: true });
        const key = record.internalId !== undefined ? toInternalId(record.internalId)
          : health ? await ensureInternalId(Health, health) : await allocateInternalId("Health");
        if (record.internalId === undefined || !isLong(record.internalId)) {
          const guard = record.internalId === undefined ? { $exists: false } : record.internalId;
          const result = await Submission.collection.updateOne({ _id: source._id, records: { $elemMatch: { _id: record._id, internalId: guard } } }, { $set: { "records.$.internalId": key } });
          report.embeddedRecords += result.modifiedCount;
        }
        const winner = await Submission.collection.findOne({ _id: source._id }, { projection: { records: 1 }, useBigInt64: true });
        const claimed = toInternalId(winner.records.find(item => sameId(item._id, record._id)).internalId);
        if (health && toInternalId(health.internalId) !== claimed) throw new Error("Concurrent reserved health identity conflict");
      }
    }
  }
  // Add declared indexes only; never sync/drop existing production indexes.
  for (const Model of models) await Model.createIndexes();
  onProgress({ phase: "complete", ...report });
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--apply", "--dry-run"].includes(arg) && !/^--batch-size=\d+$/.test(arg)) || (args.includes("--apply") && args.includes("--dry-run"))) throw new Error("Usage: node src/scripts/migrateInternalIds.js [--dry-run|--apply] [--batch-size=100]");
  const batchSize = Number(args.find(arg => arg.startsWith("--batch-size="))?.split("=")[1] || 100);
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI must be explicitly configured");
  mongoose.set("autoIndex", false); mongoose.set("autoCreate", false);
  await mongoose.connect(process.env.MONGO_URI, { dbName: "carevigo_db", autoIndex: false, autoCreate: false });
  try {
    await migrateInternalIds({ apply: args.includes("--apply"), batchSize,
      onProgress: event => process.stdout.write(JSON.stringify(event, (_, value) => typeof value === "bigint" ? value.toString() : value) + "\n") });
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(() => { console.error("Internal-ID migration failed; audit conflicts/configuration before retrying. No credentials are logged."); process.exitCode = 1; });
module.exports = { migrateInternalIds, runMigration: migrateInternalIds };
