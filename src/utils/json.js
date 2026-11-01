// JSON has no native integer type beyond Number. Keep internal 64-bit IDs exact
// at the HTTP boundary, including lean/aggregate documents containing BSON Long.
function jsonReplacer(key, value) {
  const original = this?.[key];
  if (typeof value === "bigint") return value.toString();
  if (original?._bsontype === "Long" && typeof original.toBigInt === "function") {
    return original.toBigInt().toString();
  }
  return value;
}

const jsonSafe = value => JSON.parse(JSON.stringify(value, jsonReplacer));
module.exports = { jsonReplacer, jsonSafe };
