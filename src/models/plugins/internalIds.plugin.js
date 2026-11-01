const mongoose = require("mongoose");
const { keySetter } = require("../../utils/internalId");
const ids = require("../../services/internalIds.service");
const identityPath = path => /(^|\.)internalId($|\.)/.test(path);
function containsIdentity(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => identityPath(key) || containsIdentity(item));
}
function guardUpdate(update, multi) {
  if (Array.isArray(update)) throw new Error("Pipeline updates require an explicit internal-ID migration path");
  for (const [operator, values] of Object.entries(update || {})) {
    if (!operator.startsWith("$")) continue;
    for (const [path, value] of Object.entries(values || {})) {
      if (operator === "$setOnInsert") continue;
      if ((identityPath(path) && !(operator === "$set" && path === "internalId" && !multi)) ||
          (operator === "$rename" && typeof value === "string" && identityPath(value)) || containsIdentity(value)) {
        throw new Error("Internal identity cannot be changed by this operation");
      }
    }
  }
}

function internalIdsPlugin(schema, { namespace, relations = {} } = {}) {
  schema.$internalIdNamespace = namespace;
  schema.$internalIdRelations = relations;
  schema.add({ internalId: { type: mongoose.Schema.Types.BigInt, set: keySetter } });
  schema.index({ internalId: 1 }, { unique: true, name: "internalId_unique_int64", partialFilterExpression: { internalId: { $type: "long" } } });
  for (const [field, relation] of Object.entries(relations)) {
    schema.add({ [field]: { type: mongoose.Schema.Types.BigInt, set: keySetter } });
    schema.index({ [field]: 1 }, { name: field + "_int64", partialFilterExpression: { [field]: { $type: "long" } } });
    schema.virtual(relation.virtual || relation.legacyField.replace(/Id$/, "") + "ByKey", {
      ref: relation.model, localField: field, foreignField: "internalId", justOne: true
    });
  }
  const modelNamespace = Model => namespace || Model.modelName;
  async function prepareDocument(Model, doc) {
    doc.internalId = doc.internalId === undefined ? await ids.allocateInternalId(modelNamespace(Model)) : ids.toInternalId(doc.internalId);
    Object.assign(doc, await ids.resolveRelationKeys(relations, doc));
    return doc;
  }
  async function prepareUpdate(Model, filter, update, upsert, multi = false) {
    guardUpdate(update, multi);
    const replacement = !Object.keys(update).some(key => key.startsWith("$"));
    if (multi && !upsert) return update;
    const projection = { internalId: 1 };
    Object.entries(relations).forEach(([key, ref]) => { projection[key] = 1; projection[ref.legacyField] = 1; });
    const existing = await Model.collection.findOne(filter, { projection, useBigInt64: true });
    const insert = replacement ? update : (update.$setOnInsert ||= {});
    const changed = replacement ? update : (update.$set || {});
    if (replacement && existing) {
      for (const [key, relation] of Object.entries(relations)) {
        if (update[key] === undefined && update[relation.legacyField] === undefined) {
          if (existing[key] !== undefined) update[key] = existing[key];
          if (existing[relation.legacyField] !== undefined) update[relation.legacyField] = existing[relation.legacyField];
        }
      }
    }
    const values = { ...filter, ...insert, ...changed };
    if (existing && !multi) {
      const key = await ids.ensureInternalId(Model, existing);
      if (changed.internalId !== undefined && ids.toInternalId(changed.internalId) !== key) throw new Error("Internal identity cannot be changed");
      if (replacement) update.internalId = key;
      else if (upsert) insert.internalId = key;
    } else if (upsert) {
      insert.internalId = values.internalId === undefined ? await ids.allocateInternalId(modelNamespace(Model)) : ids.toInternalId(values.internalId);
    }
    const keys = await ids.resolveRelationKeys(relations, values);
    if (replacement) Object.assign(update, keys);
    else if (Object.keys(keys).length) {
      const editsRelation = Object.keys(changed).some(field => Object.hasOwn(relations, field) || Object.values(relations).some(ref => ref.legacyField === field));
      Object.assign(upsert && !editsRelation ? insert : (update.$set ||= {}), keys);
    }
    return update;
  }
  schema.pre(["find", "findOne", "findOneAndUpdate", "findOneAndReplace"], function () { this.setOptions({ useBigInt64: true }); });
  schema.pre("save", async function () {
    if (!this.isNew && this.isModified("internalId")) {
      const original = await this.constructor.collection.findOne({ _id: this._id }, { projection: { internalId: 1 }, useBigInt64: true });
      if (original?.internalId !== undefined && (this.internalId === undefined || ids.toInternalId(original.internalId) !== ids.toInternalId(this.internalId))) throw new Error("Internal identity cannot be changed");
    }
    if (!this.isNew && this.internalId === undefined) this.internalId = await ids.ensureInternalId(this.constructor, this);
    await prepareDocument(this.constructor, this);
  });
  schema.pre("insertMany", function (next, docs) {
    (async () => { for (const doc of docs) await prepareDocument(this, doc); })().then(() => next(), next);
  });
  schema.pre(["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"], async function () {
    if (!this.getUpdate()) return;
    guardUpdate(this.getUpdate(), this.op === "updateMany");
    this.cast(this.model);
    this.setUpdate(await prepareUpdate(this.model, this.getFilter(), this.getUpdate(), this.getOptions().upsert, this.op === "updateMany"));
  });
  schema.pre("bulkWrite", function (next, operations) {
    (async () => {
      for (const operation of operations) {
        for (const kind of ["updateOne", "updateMany"]) if (operation[kind]) guardUpdate(operation[kind].update, kind === "updateMany");
      }
      for (const operation of operations) {
        if (operation.insertOne) await prepareDocument(this, operation.insertOne.document);
        for (const kind of ["updateOne", "updateMany", "replaceOne"]) {
          const item = operation[kind]; if (!item) continue;
          const filter = this.findOne(item.filter).cast(this);
          const field = kind === "replaceOne" ? "replacement" : "update";
          item[field] = await prepareUpdate(this, filter, item[field], item.upsert, kind === "updateMany");
        }
      }
    })().then(() => next(), next);
  });
}
module.exports = internalIdsPlugin;
