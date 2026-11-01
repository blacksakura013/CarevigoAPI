const mongoose = require("mongoose");
const { toInternalId } = require("../utils/internalId");
const CounterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  value: { type: mongoose.Schema.Types.BigInt, required: true, default: 0n,
    set: value => toInternalId(value, { allowZero: true }) }
}, { versionKey: false });
CounterSchema.pre(["find", "findOne", "findOneAndUpdate"], function () { this.setOptions({ useBigInt64: true }); });
module.exports = mongoose.model("Counter", CounterSchema);
