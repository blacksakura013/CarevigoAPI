// Opt-in real MongoDB integration. Never reads .env or accepts a database URI.
// CAREVIGO_BIGINT_INTEGRATION=1 enables the suite. CAREVIGO_TEST_MONGOD can
// point to an installed mongod binary; an unavailable binary skips the suite.
const assert = require("node:assert/strict");
const { describe, test, before, after } = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const mongoose = require("mongoose");
const { MongoClient, BSON, Long } = require("mongodb");

const ENABLED = process.env.CAREVIGO_BIGINT_INTEGRATION === "1";
const BASE = 9007199254740993n;
const MAX = 9223372036854775807n;
const TEMP_PREFIX = "carevigo-bigint-integration-";
function installedMongod() {
  if (!ENABLED) return null;
  const candidates = [process.env.CAREVIGO_TEST_MONGOD,
    ...(process.platform === "win32" ? ["C:\\Program Files\\MongoDB\\Server\\8.2\\bin\\mongod.exe"] : []), "mongod"].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { windowsHide: true, timeout: 5000, encoding: "utf8" });
    if (!result.error && result.status === 0) return { path: candidate, version: result.stdout.split(/\r?\n/)[0] };
  }
  return null;
}
const executable = installedMongod();
const skip = !ENABLED ? "Set CAREVIGO_BIGINT_INTEGRATION=1 to start an isolated local mongod" :
  !executable ? "No installed mongod found; set CAREVIGO_TEST_MONGOD to an installed binary" : false;

describe("signed int64 identities against an isolated real MongoDB", { skip, concurrency: false, timeout: 120000 }, () => {
  let server, exitPromise, temporaryDirectory, uri, Counter, ids, User, Health, Submission, Admin, Outbox, jsonSafe, jsonReplacer;
  let person;

  before(async () => {
    assert.equal(mongoose.connection.readyState, 0, "Integration must not reuse an existing database connection");
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    uri = `mongodb://127.0.0.1:${port}/carevigo_bigint_integration`;
    server = spawn(executable.path, ["--bind_ip", "127.0.0.1", "--port", String(port), "--dbpath", temporaryDirectory,
      "--wiredTigerCacheSizeGB", "0.25", "--quiet", "--logpath", path.join(temporaryDirectory, "mongod.log")],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let startupError = "";
    server.stdout.on("data", () => {});
    server.stderr.on("data", data => { startupError = String(data).slice(-2000); });
    server.on("error", error => { startupError = error.message; });
    exitPromise = once(server, "exit");
    const deadline = Date.now() + 30000;
    let available = false;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Isolated mongod exited: ${startupError}`);
      const probe = new MongoClient(uri, { serverSelectionTimeoutMS: 500, connectTimeoutMS: 500 });
      try { await probe.connect(); available = true; break; }
      catch { await delay(150); }
      finally { await probe.close(); }
    }
    assert.equal(available, true, `Isolated mongod did not start: ${startupError}`);
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000 });
    Counter = require("../src/models/Counter");
    ids = require("../src/services/internalIds.service");
    ({ jsonSafe, jsonReplacer } = require("../src/utils/json"));
    User = require("../src/models/User"); Health = require("../src/models/Health");
    Submission = require("../src/models/Submission"); Admin = require("../src/models/Admin"); Outbox = require("../src/models/ReviewOutbox");
    await Promise.all([Counter, User, Health, Submission, Admin, Outbox].map(Model => Model.init()));
    for (const [index, Model] of [User, Health, Submission, Admin, Outbox].entries()) {
      await Counter.collection.insertOne({ _id: Model.modelName, value: Long.fromBigInt(BASE + BigInt(index) * 10000n - 1n) });
    }
  });

  after(async () => {
    try {
      if (mongoose.connection.readyState === 1) {
        try { await mongoose.connection.db.admin().command({ shutdown: 1, force: true }); } catch { /* Shutdown closes its own connection. */ }
      }
      await mongoose.disconnect();
    } finally {
      if (server && server.exitCode === null) {
        await Promise.race([exitPromise, delay(5000, undefined, { ref: false })]);
        if (server.exitCode === null) { server.kill(); await Promise.race([exitPromise, delay(5000, undefined, { ref: false })]); }
      }
      if (temporaryDirectory) {
        // Only the brand-new mkdtemp directory may be removed, after our child exits.
        assert.ok(!server || server.exitCode !== null, "Refuse to remove files while spawned mongod is still alive");
        const absolute = path.resolve(temporaryDirectory);
        assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
        assert.ok(path.basename(absolute).startsWith(TEMP_PREFIX));
        assert.ok(path.isAbsolute(absolute));
        fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  });

  test("BSON and schema hydration preserve integers above 2^53 and the signed int64 limit", (context) => {
    context.diagnostic(`${executable.version}; Mongoose ${mongoose.version}; private spawned PID ${server.pid}`);
    const encoded = BSON.serialize({ key: BASE, maximum: MAX });
    const raw = BSON.deserialize(encoded);
    assert.equal(raw.key._bsontype, "Long"); assert.equal(raw.key.toBigInt(), BASE);
    const big = BSON.deserialize(encoded, { useBigInt64: true });
    assert.equal(big.key, BASE); assert.equal(big.maximum, MAX);
    const hydrated = User.hydrate({ _id: new mongoose.Types.ObjectId(), citizenId: "1111111111111", internalId: raw.key });
    assert.equal(hydrated.internalId, BASE);
    assert.throws(() => ids.toInternalId(Number(BASE)), /exact|integer/i);
    assert.throws(() => ids.toInternalId(MAX + 1n), /range|64/i);
    assert.throws(() => ids.toInternalId(0n), /range|positive/i);
  });

  test("migration CLI dry-run leaves an empty database without collections or indexes", async () => {
    // The CLI intentionally uses its fixed dbName; the URI still points only at our child server.
    const emptyDatabase = mongoose.connection.getClient().db("carevigo_db");
    assert.deepEqual(await emptyDatabase.listCollections({}, { nameOnly: true }).toArray(), []);
    const child = spawnSync(process.execPath, [path.resolve(__dirname, "../src/scripts/migrateInternalIds.js"), "--dry-run", "--batch-size=2"], {
      cwd: path.resolve(__dirname, ".."), env: { ...process.env, MONGO_URI: uri },
      windowsHide: true, timeout: 20000, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const events = child.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(events[0].phase, "audit"); assert.equal(events[0].mode, "dry-run");
    assert.deepEqual(events[0].conflicts, []);
    assert.deepEqual(await emptyDatabase.listCollections({}, { nameOnly: true }).toArray(), [],
      "Importing Counter and connecting for dry-run must not auto-create any collection/index");
  });

  test("atomic counter allocates unique contiguous IDs under concurrent first use", async () => {
    const allocated = await Promise.all(Array.from({ length: 32 }, () => ids.allocateInternalId("IntegrationConcurrent")));
    assert.equal(new Set(allocated.map(String)).size, 32);
    allocated.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    assert.deepEqual(allocated, Array.from({ length: 32 }, (_, index) => BigInt(index + 1)));
    const raw = await Counter.collection.findOne({ _id: "IntegrationConcurrent" });
    assert.equal(raw.value, 32); // Safe counts may be promoted by the default driver decoder.
    const typed = await Counter.findById("IntegrationConcurrent").lean();
    assert.equal(typed.value, 32n);
  });

  test("counter ranges remain exact above 2^53 and reject exhaustion without partial allocation", async () => {
    await Counter.collection.insertOne({ _id: "IntegrationLargeRange", value: Long.fromBigInt(BASE - 1n) });
    assert.deepEqual(await ids.allocateInternalIds("IntegrationLargeRange", 3), [BASE, BASE + 1n, BASE + 2n]);
    await Counter.collection.insertOne({ _id: "IntegrationMaximum", value: Long.fromBigInt(MAX - 1n) });
    await assert.rejects(ids.allocateInternalIds("IntegrationMaximum", 2), /exhaust|range/i);
    assert.equal((await Counter.findById("IntegrationMaximum")).value, MAX - 1n);
    assert.equal(await ids.allocateInternalId("IntegrationMaximum"), MAX);
    await assert.rejects(ids.allocateInternalId("IntegrationMaximum"), /exhaust|range/i);
    assert.equal((await Counter.findById("IntegrationMaximum")).value, MAX);
  });

  test("corrupt counter doubles and negative int64 values are rejected without mutation", async () => {
    for (const [namespace, value] of [["IntegrationBadDouble", 1.5], ["IntegrationBadUnsafeNumber", Number(BASE)], ["IntegrationBadNegative", -1n]]) {
      await Counter.collection.insertOne({ _id: namespace, value });
      const before = await Counter.collection.findOne({ _id: namespace }, { useBigInt64: true });
      await assert.rejects(ids.allocateInternalId(namespace), /int64|range|integer/i);
      const after = await Counter.collection.findOne({ _id: namespace }, { useBigInt64: true });
      assert.deepEqual(after, before);
    }
  });

  test("create, save, insertMany, upserts and replacement keep public ObjectIds and exact internal IDs", async () => {
    person = await User.create({ citizenId: "1000000000001", firstName: "Integration", lastName: "Fixture", province: "Fixture", internalId: BASE });
    assert.equal(person.internalId, BASE); assert.ok(person._id instanceof mongoose.Types.ObjectId);
    // Advance the normal allocator past the explicitly seeded fixture key.
    await Counter.collection.updateOne({ _id: "User" }, { $max: { value: BASE } });
    person.phone = "0811111111"; await person.save();
    assert.equal((await User.findById(person._id)).internalId, BASE);
    const inserted = await User.insertMany([{ citizenId: "1000000000002" }, { citizenId: "1000000000003" }]);
    assert.deepEqual(inserted.map(doc => doc.internalId), [BASE + 1n, BASE + 2n]);
    const upserted = await User.findOneAndUpdate({ citizenId: "1000000000004" }, { $set: { firstName: "Upsert" } }, { new: true, upsert: true });
    assert.equal(typeof upserted.internalId, "bigint"); assert.ok(upserted.internalId > BASE + 2n);
    await User.updateOne({ citizenId: "1000000000005" }, { $setOnInsert: { firstName: "Materialized" } }, { upsert: true });
    assert.equal(typeof (await User.findOne({ citizenId: "1000000000005" })).internalId, "bigint");
    await User.replaceOne({ _id: person._id }, { citizenId: person.citizenId, firstName: "Replaced", lastName: "Fixture" });
    const replaced = await User.findById(person._id).lean();
    assert.equal(replaced.internalId, BASE); assert.equal(replaced._id.toString(), person._id.toString());
    const typed = await User.collection.findOne({ _id: person._id }, { useBigInt64: true });
    assert.equal(typed.internalId, BASE);
  });

  test("unsafe numeric input and attempted internal identity changes cannot reach storage", async () => {
    await assert.rejects(User.create({ citizenId: "1000000000099", internalId: Number(BASE) }));
    await assert.rejects(User.updateOne({ _id: person._id }, { $set: { internalId: BASE + 1000n } }), /cannot be changed/i);
    await assert.rejects(User.updateOne({ _id: person._id.toString() }, { $set: { internalId: BASE + 1000n } }), /cannot be changed/i);
    await assert.rejects(User.updateOne({ _id: person._id }, { $unset: { internalId: 1 } }), /identity|cannot/i);
    assert.equal((await User.findById(person._id)).internalId, BASE);
  });

  test("projected saves and concurrent hydrated legacy saves preserve the same assigned identity", async () => {
    const projected = await User.findById(person._id).select("firstName");
    assert.equal(projected.internalId, undefined);
    projected.firstName = "Projected save";
    await projected.save();
    assert.equal(projected.internalId, BASE);
    assert.equal((await User.findById(person._id)).internalId, BASE);
    const legacyId = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: legacyId, citizenId: "1000000000098", firstName: "Legacy race" });
    const [left, right] = await Promise.all([User.findById(legacyId), User.findById(legacyId)]);
    assert.equal(left.internalId, undefined); assert.equal(right.internalId, undefined);
    left.firstName = "Left writer"; right.lastName = "Right writer";
    await Promise.all([left.save(), right.save()]);
    assert.equal(left.internalId, right.internalId);
    assert.equal((await User.findById(legacyId)).internalId, left.internalId);
  });

  test("bulk writes allocate new IDs and reject arithmetic or multi-row identity changes", async () => {
    await User.bulkWrite([{ insertOne: { document: { citizenId: "1000000000080" } } },
      { updateOne: { filter: { citizenId: "1000000000081" }, update: { $set: { firstName: "Bulk upsert" } }, upsert: true } }]);
    const rows = await User.find({ citizenId: { $in: ["1000000000080", "1000000000081"] } }).lean();
    assert.equal(rows.length, 2); assert.ok(rows.every(row => typeof row.internalId === "bigint"));
    assert.notEqual(rows[0].internalId, rows[1].internalId);
    await assert.rejects(User.updateMany({}, { $set: { internalId: BASE + 5000n } }), /identity|cannot/i);
    await assert.rejects(User.bulkWrite([{ updateOne: { filter: { _id: person._id.toString() }, update: { $inc: { internalId: 1n } } } }]), /identity|cannot/i);
    assert.equal((await User.findById(person._id)).internalId, BASE);
  });

  test("partial unique int64 index permits untouched legacy rows but rejects duplicate assigned IDs", async () => {
    const before = await User.countDocuments();
    await User.collection.insertMany([{ citizenId: "1000000000100" }, { citizenId: "1000000000101" }]);
    assert.equal(await User.countDocuments(), before + 2);
    await assert.rejects(User.collection.insertOne({ citizenId: "1000000000102", internalId: BASE }), error => error.code === 11000);
    const indexes = await User.collection.indexes();
    const index = indexes.find(item => item.name === "internalId_unique_int64");
    assert.equal(index.unique, true); assert.deepEqual(index.partialFilterExpression, { internalId: { $type: "long" } });
  });

  test("migration dry-run is read-only; apply backfills relations and reservations once and reruns without mutations", async () => {
    const { migrateInternalIds } = require("../src/scripts/migrateInternalIds");
    const legacyUserId = new mongoose.Types.ObjectId(), legacyAdminId = new mongoose.Types.ObjectId(), submissionId = new mongoose.Types.ObjectId();
    const existingHealthId = new mongoose.Types.ObjectId(), otherHealthId = new mongoose.Types.ObjectId();
    const unmaterializedId = new mongoose.Types.ObjectId(), newlyReservedId = new mongoose.Types.ObjectId();
    const reservedKey = BASE + 900000n;
    await User.collection.insertOne({ _id: legacyUserId, citizenId: "1000000000150", firstName: "Migration legacy" });
    await Admin.collection.insertOne({ _id: legacyAdminId, email: "migration@example.invalid", role: "admin", isActive: true });
    await Submission.collection.insertOne({ _id: submissionId, userId: legacyUserId, citizenId: "1000000000150", profile: {},
      records: [
        { _id: existingHealthId, internalId: reservedKey, type: "sugar", value: { fbs: 101 } },
        { _id: unmaterializedId, internalId: reservedKey + 1n, type: "blood_pressure", value: { systolic: 120, diastolic: 80 } },
        { _id: otherHealthId, type: "cholesterol", value: { total: 180 } },
        { _id: newlyReservedId, type: "bmi", value: { weight: 60, height: 165 }, weight: 60, height: 165 },
      ], clientRequestId: randomUUID(), requestKeyHash: randomUUID(), payloadHash: randomUUID(), receiptHash: randomUUID(),
      submittedAt: new Date(), reviewDueAt: new Date(), receiptExpiresAt: new Date(Date.now() + 10000) });
    await Health.collection.insertMany([
      { _id: existingHealthId, userId: legacyUserId, citizenId: "1000000000150", submissionId, type: "sugar", value: { fbs: 101 } },
      { _id: otherHealthId, citizenId: "1000000000150", submissionId, type: "cholesterol", value: { total: 180 } },
    ]);
    const outboxId = new mongoose.Types.ObjectId();
    await Outbox.collection.insertOne({ _id: outboxId, submissionId, adminId: legacyAdminId, recipient: "migration@example.invalid",
      tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 10000) });
    async function snapshot() {
      const state = {};
      for (const Model of [Counter, User, Admin, Health, Submission, Outbox]) {
        const docs = await Model.collection.find({}, { useBigInt64: true }).sort({ _id: 1 }).toArray();
        state[Model.modelName] = docs.map(doc => BSON.serialize(doc).toString("hex"));
      }
      return state;
    }
    const before = await snapshot();
    const audit = await migrateInternalIds({ batchSize: 2 });
    assert.equal(audit.mode, "dry-run"); assert.deepEqual(audit.conflicts, []);
    assert.ok(audit.models.User.missing > 0); assert.ok(audit.models.Submission.missingRelations > 0);
    assert.equal(audit.models.Health.maximum, (reservedKey + 1n).toString());
    assert.deepEqual(await snapshot(), before, "Dry-run must not allocate counters or mutate any document");
    const applied = await migrateInternalIds({ apply: true, batchSize: 2 });
    assert.ok(applied.assigned > 0); assert.ok(applied.relations >= 5); assert.ok(applied.embeddedRecords >= 2);
    const user = await User.findById(legacyUserId), admin = await Admin.findById(legacyAdminId);
    const submission = await Submission.findById(submissionId), outbox = await Outbox.findById(outboxId);
    const health = await Health.findById(existingHealthId), other = await Health.findById(otherHealthId);
    assert.equal(health.internalId, reservedKey); assert.ok(other.internalId > reservedKey + 1n);
    assert.equal(health.userKey, user.internalId); assert.equal(health.submissionKey, submission.internalId);
    assert.equal(other.userKey, user.internalId); assert.equal(other.userId, undefined,
      "Citizen-only legacy health gains a numeric relation without inventing a legacy ObjectId relation");
    assert.equal(submission.userKey, user.internalId); assert.equal(outbox.submissionKey, submission.internalId); assert.equal(outbox.adminKey, admin.internalId);
    assert.equal(submission.records.find(record => record._id.equals(otherHealthId)).internalId, other.internalId);
    assert.ok(submission.records.find(record => record._id.equals(newlyReservedId)).internalId > reservedKey + 1n);
    const onceApplied = await snapshot();
    const repeated = await migrateInternalIds({ apply: true, batchSize: 2 });
    assert.equal(repeated.assigned, 0); assert.equal(repeated.relations, 0); assert.equal(repeated.embeddedRecords, 0); assert.equal(repeated.normalized, 0);
    assert.deepEqual(await snapshot(), onceApplied, "A repeated migration must not allocate new IDs or increment counters");
    const counterBeforeMaterialization = (await Counter.findById("Health")).value;
    const { materializeSubmission } = require("../src/services/review.service");
    await materializeSubmission(submission);
    for (const record of submission.records) assert.equal((await Health.findById(record._id)).internalId, record.internalId);
    assert.equal((await Counter.findById("Health")).value, counterBeforeMaterialization, "Recovery reuses reserved record IDs");
  });

  test("migration rejects insufficient signed int64 capacity before any counter or document mutation", async () => {
    const { migrateInternalIds } = require("../src/scripts/migrateInternalIds");
    const Capacity = mongoose.model("IntegrationMigrationCapacity", new mongoose.Schema({ internalId: mongoose.Schema.Types.BigInt, label: String }));
    await Capacity.init();
    await Capacity.collection.insertMany([{ internalId: MAX - 1n, label: "maximum" }, { label: "missing one" }, { label: "missing two" }]);
    await Counter.collection.insertOne({ _id: Capacity.modelName, value: MAX - 1n });
    async function snapshot() {
      const documents = await Capacity.collection.find({}, { useBigInt64: true }).sort({ _id: 1 }).toArray();
      const counters = await Counter.collection.find({}, { useBigInt64: true }).sort({ _id: 1 }).toArray();
      return { documents: documents.map(doc => BSON.serialize(doc).toString("hex")), counters: counters.map(doc => BSON.serialize(doc).toString("hex")) };
    }
    const before = await snapshot();
    const audit = await migrateInternalIds({ models: [Capacity] });
    assert.equal(audit.models[Capacity.modelName].requiredAllocations, "2");
    assert.ok(audit.conflicts.some(item => /capacity/i.test(item.reason)));
    await assert.rejects(migrateInternalIds({ apply: true, models: [Capacity] }), /blocked|conflict/i);
    assert.deepEqual(await snapshot(), before);
  });

  test("migration audits a string-stored health identity against another record's reserved int64 key before writing", async () => {
    const { migrateInternalIds } = require("../src/scripts/migrateInternalIds");
    const storedHealthId = new mongoose.Types.ObjectId(), reservedHealthId = new mongoose.Types.ObjectId();
    const submissionId = new mongoose.Types.ObjectId(), collisionKey = BASE + 950000n;
    await Health.collection.insertOne({ _id: storedHealthId, internalId: collisionKey.toString(),
      userId: person._id, citizenId: person.citizenId, type: "sugar", value: { fbs: 100 } });
    await Submission.collection.insertOne({ _id: submissionId, userId: person._id, citizenId: person.citizenId,
      records: [{ _id: reservedHealthId, internalId: collisionKey, type: "sugar", value: { fbs: 101 } }] });
    async function snapshot() {
      const state = {};
      const collections = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
      for (const { name } of collections.sort((a, b) => a.name.localeCompare(b.name))) {
        const collection = mongoose.connection.db.collection(name);
        const docs = await collection.find({}, { useBigInt64: true }).sort({ _id: 1 }).toArray();
        state[name] = { documents: docs.map(doc => BSON.serialize(doc).toString("hex")), indexes: await collection.indexes() };
      }
      return state;
    }
    try {
      const before = await snapshot();
      const audit = await migrateInternalIds();
      assert.ok(audit.conflicts.some(item => item.field === "records.internalId" && /another health record/i.test(item.reason)),
        "Canonical decimal strings and BSON int64 reservations must collide by their exact normalized value");
      assert.deepEqual(await snapshot(), before, "Dry-run must preserve every collection, counter and index");
      await assert.rejects(migrateInternalIds({ apply: true }), error =>
        /blocked|conflict/i.test(error.message) && error.report.conflicts.some(item => item.field === "records.internalId"));
      assert.deepEqual(await snapshot(), before, "A normalization collision must block all writes, including counter seeding");
    } finally {
      await Health.collection.deleteOne({ _id: storedHealthId });
      await Submission.collection.deleteOne({ _id: submissionId });
    }
  });

  test("legacy identity allocation is stable under races and numeric relation filters reject conflicting keys", async () => {
    await User.collection.insertOne({ citizenId: "1000000000103" });
    const legacy = await User.findOne({ citizenId: "1000000000103" });
    const assigned = await Promise.all(Array.from({ length: 8 }, () => ids.ensureInternalId(User, legacy._id.toString())));
    assert.equal(new Set(assigned.map(String)).size, 1); assert.ok(assigned[0] > BASE);
    await ids.ensureInternalId(User, legacy); assert.equal(legacy.internalId, assigned[0]);
    const query = ids.relationFilter({ keyField: "userKey", key: person.internalId, legacyField: "userId", legacyId: person._id });
    const inserted = await Health.collection.insertMany([
      { type: "sugar", userKey: person.internalId, value: { fbs: 91 } },
      { type: "sugar", userId: person._id, value: { fbs: 92 } },
      { type: "sugar", userKey: person.internalId + 999n, userId: person._id, value: { fbs: 93 } },
    ]);
    const rows = await Health.find(query).lean();
    assert.deepEqual(rows.filter(row => Object.values(inserted.insertedIds).some(id => id.equals(row._id))).map(row => row.value.fbs).sort(), [91, 92]);
    assert.throws(() => ids.relationFilter({ keyField: "userKey", legacyField: "userId" }), /identity|required/i);
  });

  test("BigInt virtual population and aggregation lookup join on internalId with exact precision", async () => {
    const health = await Health.create({ userId: person._id, citizenId: person.citizenId, type: "sugar", value: { fbs: 95 } });
    assert.equal(health.userKey, person.internalId);
    const populated = await Health.findById(health._id).populate("userByKey").populate("userId");
    assert.equal(populated.userByKey._id.toString(), person._id.toString());
    assert.equal(populated.userByKey.internalId, BASE);
    assert.equal(populated.userId._id.toString(), person._id.toString());
    const lean = await Health.findById(health._id).populate("userByKey").lean();
    assert.equal(lean.userKey, BASE); assert.equal(lean.userByKey.internalId, BASE);
    const aggregated = await Health.aggregate([{ $match: { _id: health._id } },
      { $lookup: { from: User.collection.name, localField: "userKey", foreignField: "internalId", as: "person" } }]).option({ useBigInt64: true });
    assert.equal(aggregated[0].userKey, BASE); assert.equal(aggregated[0].person[0].internalId, BASE);
    assert.equal((await User.aggregate([{ $match: { internalId: BASE.toString() } }])).length, 0, "Aggregation string IDs must be cast explicitly");
  });

  test("JSON boundaries preserve BigInt and BSON Long as decimal strings and public BSON IDs as strings", async () => {
    const doc = await User.findById(person._id);
    const now = new Date("2026-11-01T00:00:00.000Z");
    const value = jsonSafe({ user: doc, nested: [BASE, { maximum: Long.fromBigInt(MAX) }], publicId: person._id, at: now, count: 5 });
    assert.equal(value.user.internalId, BASE.toString());
    assert.deepEqual(value.nested, [BASE.toString(), { maximum: MAX.toString() }]);
    assert.equal(value.publicId, person._id.toHexString()); assert.equal(value.at, now.toISOString()); assert.equal(value.count, 5);
    assert.equal(JSON.parse(JSON.stringify({ key: BASE }, jsonReplacer)).key, BASE.toString());
    const lean = await User.findById(person._id).lean();
    assert.equal(jsonSafe(lean).internalId, BASE.toString());
  });

  test("submission, health materialization and notification relations share exact reserved keys", async () => {
    const recordKey = await ids.allocateInternalId("Health");
    const submission = await Submission.create({ citizenId: person.citizenId, userId: person._id,
      profile: { firstName: "Integration" }, records: [{ _id: new mongoose.Types.ObjectId(), internalId: recordKey, type: "sugar", value: { fbs: 96 } }],
      clientRequestId: randomUUID(), requestKeyHash: randomUUID(), payloadHash: randomUUID(), receiptHash: randomUUID(),
      submittedAt: new Date(), reviewDueAt: new Date(), receiptExpiresAt: new Date(Date.now() + 10000) });
    assert.equal(submission.userKey, BASE); assert.equal(submission.records[0].internalId, recordKey);
    const { materializeSubmission } = require("../src/services/review.service");
    await materializeSubmission(submission); await materializeSubmission(submission);
    const row = await Health.findById(submission.records[0]._id);
    assert.equal(row.internalId, recordKey); assert.equal(row.userKey, BASE); assert.equal(row.submissionKey, submission.internalId);
    assert.equal(await Health.countDocuments({ _id: row._id }), 1);
    const admin = await Admin.create({ email: "integration@example.invalid" });
    const notification = await Outbox.create({ submissionId: submission._id, adminId: admin._id, recipient: admin.email,
      tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 10000) });
    assert.equal(notification.submissionKey, submission.internalId); assert.equal(notification.adminKey, admin.internalId);
    const hydrated = await Outbox.findById(notification._id).populate("submissionByKey").populate("adminByKey");
    assert.equal(hydrated.submissionByKey.internalId, submission.internalId); assert.equal(hydrated.adminByKey.internalId, admin.internalId);
  });

  test("dashboard joins count one person across mixed legacy/numeric rows and keep metric counts numeric", async () => {
    const dashboard = require("../src/controllers/dashboard.controller");
    async function invoke(handler, query = {}) {
      const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = jsonSafe(body); return this; } };
      await handler({ query }, res); assert.equal(res.code, 200, res.body?.message); return res.body;
    }
    const baseline = await invoke(dashboard.summary);
    const owner = await User.create({ citizenId: "1000000000200", firstName: "Numeric owner", province: "Integration numeric province" });
    const wrongLegacy = await User.create({ citizenId: "1000000000201", firstName: "Wrong legacy", province: "Integration wrong province" });
    // Simulate a historical disagreement; current model writes reject conflicting relations.
    const keyed = { _id: new mongoose.Types.ObjectId(), internalId: await ids.allocateInternalId("Health"),
      userKey: owner.internalId, userId: wrongLegacy._id, citizenId: owner.citizenId,
      type: "blood_pressure", value: { systolic: 120, diastolic: 80 }, cvdRisk: { level: "risk_high" } };
    await Health.collection.insertOne(keyed);
    const legacy = await Health.collection.insertMany(Array.from({ length: 2 }, () => ({ userId: owner._id, citizenId: owner.citizenId,
      type: "blood_pressure", value: { systolic: 120, diastolic: 80 }, cvdRisk: { level: "risk_high" }, createdAt: new Date() })));
    const summary = (await invoke(dashboard.summary)).data;
    assert.equal(summary.highRiskRecords, baseline.data.highRiskRecords + 3);
    assert.equal(summary.highRiskUsers, baseline.data.highRiskUsers + 1);
    for (const field of ["totalUsers", "totalHealthRecords", "highRiskUsers", "highRiskRecords"]) assert.equal(typeof summary[field], "number");
    const analytics = await invoke(dashboard.healthAnalytics, { page: "1", limit: "100" });
    const fixtureIds = [keyed._id, ...Object.values(legacy.insertedIds)].map(String);
    const rows = analytics.data.records.filter(row => fixtureIds.includes(row._id));
    assert.equal(rows.length, 3); rows.forEach(row => assert.equal(row.user._id, owner._id.toString()));
    assert.equal(rows.find(row => row._id === keyed._id.toString()).userKey, owner.internalId.toString());
    assert.equal(typeof analytics.total, "number"); assert.equal(typeof analytics.data.summary.blood_pressure, "number");
    const provinces = (await invoke(dashboard.riskByProvince)).data;
    assert.equal(provinces.find(row => row._id === owner.province).total, 3);
    assert.equal(provinces.some(row => row._id === wrongLegacy.province), false);
    assert.equal(typeof provinces[0].total, "number");
  });
});
