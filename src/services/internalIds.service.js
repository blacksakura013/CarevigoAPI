const mongoose = require("mongoose");
const Counter = require("../models/Counter");
const exact = require("../utils/internalId");

async function allocateInternalIds(namespace, count = 1) {
  if (typeof namespace !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(namespace)) throw new TypeError("Invalid internal-ID namespace");
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new RangeError("Allocate between 1 and 1000 IDs at a time");
  const increment = BigInt(count);
  try {
    await Counter.collection.updateOne({ _id: namespace }, { $setOnInsert: { value: 0n } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  const initial = await Counter.collection.findOne({ _id: namespace }, { useBigInt64: true });
  if (!initial || !(typeof initial.value === "bigint" || initial.value?._bsontype === "Long")) throw new TypeError("Counter must contain an exact BSON int64");
  exact.toInternalId(initial.value, { allowZero: true });
  // Guard before incrementing: MongoDB must never promote an overflowing int64.
  const counter = await Counter.collection.findOneAndUpdate({ _id: namespace, value: { $type: "long", $gte: 0n, $lte: exact.MAX_INTERNAL_ID - increment } },
    { $inc: { value: increment } }, { returnDocument: "after", includeResultMetadata: false, useBigInt64: true });
  if (!counter) throw new RangeError(`Internal ID space exhausted for ${namespace}`);
  const end = exact.toInternalId(counter.value);
  const start = end - increment + 1n;
  return Array.from({ length: count }, (_, index) => start + BigInt(index));
}
async function allocateInternalId(namespace) { return (await allocateInternalIds(namespace, 1))[0]; }

async function ensureInternalId(Model, docOrId) {
  if (!Model?.modelName) throw new TypeError("A Mongoose model is required");
  const supplied = docOrId && typeof docOrId === "object" && docOrId._id !== undefined ? docOrId : null;
  if (supplied?.internalId !== undefined) return exact.toInternalId(supplied.internalId);
  const physicalId = Model.schema.path("_id").cast(supplied ? supplied._id : docOrId);
  let row = await Model.collection.findOne({ _id: physicalId }, { projection: { internalId: 1 }, useBigInt64: true });
  if (!row) throw new Error(`${Model.modelName} identity does not exist`);
  if (row.internalId === undefined) {
    const candidate = await allocateInternalId(Model.schema.$internalIdNamespace || Model.modelName);
    row = await Model.collection.findOneAndUpdate({ _id: physicalId, internalId: { $exists: false } },
      { $set: { internalId: candidate } }, { returnDocument: "after", includeResultMetadata: false, projection: { internalId: 1 }, useBigInt64: true }) ||
      await Model.collection.findOne({ _id: physicalId }, { projection: { internalId: 1 }, useBigInt64: true });
  }
  if (!row || row.internalId === undefined) throw new Error("Internal identity allocation did not complete");
  const key = exact.toInternalId(row.internalId);
  if (supplied) supplied.internalId = key;
  return key;
}

async function resolveRelationKeys(relations, values) {
  const resolved = {};
  for (const [keyField, relation] of Object.entries(relations || {})) {
    const provided = values[keyField] === undefined ? undefined : exact.toInternalId(values[keyField]);
    if (values[relation.legacyField] === undefined || values[relation.legacyField] === null) {
      if (provided !== undefined) resolved[keyField] = provided;
      continue;
    }
    const Target = mongoose.model(relation.model);
    const actual = await ensureInternalId(Target, values[relation.legacyField]);
    if (provided !== undefined && provided !== actual) throw new Error(`Conflicting numeric relation ${keyField}`);
    resolved[keyField] = actual;
  }
  return resolved;
}

module.exports = { ...exact, allocateInternalId, allocateInternalIds, ensureInternalId, resolveRelationKeys };
