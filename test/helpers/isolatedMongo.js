// Local test infrastructure only. Never reads .env, MONGO_URI, or a remote URI.
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

function installedMongod() {
  const candidates = [process.env.CAREVIGO_TEST_MONGOD,
    ...(process.platform === "win32" ? ["C:\\Program Files\\MongoDB\\Server\\8.2\\bin\\mongod.exe"] : []), "mongod"].filter(Boolean);
  for (const binary of candidates) {
    const result = spawnSync(binary, ["--version"], { windowsHide: true, timeout: 5000, encoding: "utf8" });
    if (!result.error && result.status === 0) return { binary, version: result.stdout.split(/\r?\n/)[0] };
  }
  return null;
}

async function isolatedMongo({ mongoose, database = "carevigo_workflow_integration", prefix = "carevigo-workflow-integration-" } = {}) {
  assert.equal(mongoose.connection.readyState, 0, "Refuse to reuse an existing database connection");
  const executable = installedMongod();
  if (!executable) return null;
  const { MongoClient } = require("mongodb");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const assigned = listener.address().port;
      listener.close(error => error ? reject(error) : resolve(assigned));
    });
  });
  const uri = `mongodb://127.0.0.1:${port}/${database}`;
  const child = spawn(executable.binary, ["--bind_ip", "127.0.0.1", "--port", String(port), "--dbpath", temporaryDirectory,
    // The fixture is tiny and may run on a low-space developer system. Disable
    // MongoDB 7.1+'s 500 MB index-build reserve only in this disposable process.
    "--setParameter", "indexBuildMinAvailableDiskSpaceMB=0",
    "--wiredTigerCacheSizeGB", "0.25", "--quiet", "--logpath", path.join(temporaryDirectory, "mongod.log")],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let startupError = "", didExit = false;
  const exit = new Promise(resolve => child.once("exit", () => { didExit = true; resolve(); }));
  child.stdout.on("data", () => {});
  child.stderr.on("data", data => { startupError = String(data).slice(-1000); });
  child.on("error", error => { startupError = error.message; });
  let stopped = false;
  async function stop() {
    if (stopped) return { pid: child.pid, exited: didExit, removed: !fs.existsSync(temporaryDirectory) };
    try {
      if (mongoose.connection.readyState === 1) {
        try { await mongoose.connection.db.admin().command({ shutdown: 1, force: true }); } catch { /* Expected disconnect. */ }
      }
      await mongoose.disconnect();
    } finally {
      if (!didExit) await Promise.race([exit, delay(5000)]);
      if (!didExit) { child.kill(); await Promise.race([exit, delay(5000)]); }
      assert.ok(didExit, "Refuse to remove the data directory while our mongod is running");
      const absolute = path.resolve(temporaryDirectory);
      assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
      assert.ok(path.basename(absolute).startsWith(prefix));
      assert.ok(path.isAbsolute(absolute));
      fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      stopped = true;
    }
    return { pid: child.pid, exited: didExit, removed: !fs.existsSync(temporaryDirectory) };
  }
  try {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      if (didExit || startupError && !child.pid) throw new Error(`Isolated mongod failed: ${startupError}`);
      const probe = new MongoClient(uri, { serverSelectionTimeoutMS: 400, connectTimeoutMS: 400 });
      try { await probe.connect(); ready = true; break; }
      catch { await delay(100); }
      finally { await probe.close(); }
    }
    assert.ok(ready, `Isolated mongod startup timed out: ${startupError}`);
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000 });
    return { uri, port, pid: child.pid, version: executable.version, temporaryDirectory, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

module.exports = { isolatedMongo, installedMongod };
