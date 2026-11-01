const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const mongoose = require("mongoose");
const { createApp, startServer } = require("../src/app");

let previousWorkerSetting;
test.beforeEach(() => { previousWorkerSetting = process.env.REVIEW_WORKER_ENABLED; delete process.env.REVIEW_WORKER_ENABLED; });
test.afterEach(() => {
  if (previousWorkerSetting === undefined) delete process.env.REVIEW_WORKER_ENABLED;
  else process.env.REVIEW_WORKER_ENABLED = previousWorkerSetting;
});

test("startup does not listen or start review jobs when database connection fails", async () => {
  let built = false, worked = false;
  const options = {
    buildApp: () => { built = true; },
    startWorker: () => { worked = true; },
  };
  await assert.rejects(startServer({ ...options, connect: async () => { throw new Error("offline"); } }), /offline/);
  await assert.rejects(startServer({ ...options, connect: async () => null }), /not ready/);
  await assert.rejects(startServer({ ...options, connect: async () => ({ connection: { readyState: 0 } }) }), /not ready/);
  assert.equal(built, false);
  assert.equal(worked, false);
});

test("startup waits for the database and a listening server before starting review jobs", async () => {
  const order = [];
  const listener = new EventEmitter();
  listener.address = () => ({ port: 12345 });
  const result = await startServer({
    connect: async () => { order.push("database"); return { connection: { readyState: 1 } }; },
    buildApp: () => ({ listen(port, host, ready) {
      order.push("listen");
      setImmediate(() => { order.push("ready"); ready(); });
      return listener;
    } }),
    startWorker: () => { order.push("worker"); return "test-worker"; },
  });
  assert.deepEqual(order, ["database", "listen", "ready", "worker"]);
  assert.equal(result.server, listener);
  assert.equal(result.worker, "test-worker");
});

test("binding failure never starts a review worker", async () => {
  let started = false;
  await assert.rejects(startServer({
    connect: async () => ({ connection: { readyState: 1 } }),
    buildApp: () => ({ listen() {
      const listener = new EventEmitter();
      setImmediate(() => listener.emit("error", new Error("port unavailable")));
      return listener;
    } }),
    startWorker: () => { started = true; },
  }), /port unavailable/);
  assert.equal(started, false);
});

test("explicit worker opt-out keeps HTTP and database startup but never consumes the review or outbox backlog", async () => {
  process.env.REVIEW_WORKER_ENABLED = " false ";
  let connected = false, listened = false, started = false;
  const listener = new EventEmitter();
  listener.address = () => ({ port: 12345 });
  const result = await startServer({
    connect: async () => { connected = true; return { connection: { readyState: 1 } }; },
    buildApp: () => ({ listen(port, host, ready) {
      assert.equal(connected, true); listened = true; setImmediate(ready); return listener;
    } }),
    startWorker: () => { started = true; throw new Error("Disabled worker must not run"); },
  });
  assert.equal(listened, true); assert.equal(started, false);
  assert.equal(result.server, listener); assert.equal(result.worker, null);
});

test("an enabled worker setting preserves normal review startup", async () => {
  process.env.REVIEW_WORKER_ENABLED = "true";
  const listener = new EventEmitter();
  listener.address = () => ({ port: 12345 });
  let starts = 0;
  const result = await startServer({
    connect: async () => ({ connection: { readyState: 1 } }),
    buildApp: () => ({ listen(port, host, ready) { setImmediate(ready); return listener; } }),
    startWorker: () => { starts++; return "enabled-worker"; },
  });
  assert.equal(starts, 1); assert.equal(result.worker, "enabled-worker");
});

test("health reports actual database readiness and API errors are never cached", async (t) => {
  assert.equal(mongoose.connection.readyState, 0);
  const app = createApp({ enableLine: false, logRequests: false });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 503);
  assert.equal((await health.json()).mongodb, "DISCONNECTED");
  assert.equal(health.headers.get("cache-control"), "no-store");
  const blocked = await fetch(`${base}/api/health`, { headers: { Origin: "https://blocked.example.test" } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get("cache-control"), "no-store");
  const invalid = await fetch(`${base}/api/public/submissions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{broken",
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("cache-control"), "no-store");
});
