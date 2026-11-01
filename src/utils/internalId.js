const MAX_INTERNAL_ID = 9223372036854775807n;
function toInternalId(value, { allowZero = false } = {}) {
  let result;
  if (typeof value === "bigint") result = value;
  else if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) result = BigInt(value);
  else if (typeof value === "number" && Number.isSafeInteger(value)) result = BigInt(value);
  else if (value?._bsontype === "Long" && typeof value.toBigInt === "function") result = value.toBigInt();
  else throw new TypeError("Internal ID must be an exact integer or canonical decimal string");
  if (result < (allowZero ? 0n : 1n) || result > MAX_INTERNAL_ID) throw new RangeError("Internal ID exceeds the positive signed 64-bit range");
  return result;
}
function keySetter(value) { return value === undefined ? undefined : toInternalId(value); }
function getInternalId(doc) { return doc?.internalId === undefined ? undefined : toInternalId(doc.internalId); }
function relationFilter({ keyField, key, legacyField, legacyId }) {
  if (!keyField || !legacyField) throw new TypeError("Relation field names are required");
  if (key === undefined || key === null) {
    if (legacyId === undefined || legacyId === null) throw new TypeError("Relation identity is required");
    return { $and: [{ [keyField]: { $exists: false } }, { [legacyField]: legacyId }] };
  }
  const numeric = { [keyField]: toInternalId(key) };
  if (legacyId === undefined || legacyId === null) return numeric;
  return { $or: [numeric, { $and: [{ [keyField]: { $exists: false } }, { [legacyField]: legacyId }] }] };
}
function identityFilter({ key, legacyId }) {
  if (key === undefined || key === null) {
    if (legacyId === undefined || legacyId === null) throw new TypeError("Identity is required");
    return { _id: legacyId };
  }
  return relationFilter({ keyField: "internalId", key, legacyField: "_id", legacyId });
}
module.exports = { MAX_INTERNAL_ID, toInternalId, parseInternalId: toInternalId, keySetter, getInternalId, relationFilter, identityFilter };
