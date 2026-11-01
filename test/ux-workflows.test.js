const { test } = require("node:test");
const assert = require("node:assert/strict");

const User = require("../src/models/User");
const Health = require("../src/models/Health");
const publicController = require("../src/controllers/public.controller");
const userController = require("../src/controllers/user.controller");
const dashboardController = require("../src/controllers/dashboard.controller");

const citizenId = "1234567890123";

async function invoke(handler, req) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await handler(req, res);
  return res;
}

function queryResult(rows) {
  let offset = 0;
  return {
    sort() { return this; },
    skip(value) { offset = value; return this; },
    limit(value) { return Promise.resolve(rows.slice(offset, offset + value)); }
  };
}

test("public history filters records and pagination totals by the requested type", async (t) => {
  const rows = [
    { _id: "bp-1", citizenId, type: "blood_pressure" },
    { _id: "sugar-1", citizenId, type: "sugar" },
    { _id: "sugar-2", citizenId, type: "sugar" },
    { _id: "other-user", citizenId: "9999999999999", type: "sugar" }
  ];
  const select = filter => rows.filter(row =>
    Object.entries(filter).every(([key, value]) => row[key] === value)
  );
  t.mock.method(Health, "find", filter => queryResult(select(filter)));
  t.mock.method(Health, "countDocuments", async filter => select(filter).length);

  const first = await invoke(publicController.getHealthByCitizen, {
    query: { citizenId, type: "sugar", page: "1", limit: "1" }
  });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body.data.map(row => row._id), ["sugar-1"]);
  assert.equal(first.body.total, 2);
  assert.equal(first.body.hasMore, true);

  const second = await invoke(publicController.getHealthByCitizen, {
    query: { citizenId, type: "sugar", page: "2", limit: "1" }
  });
  assert.deepEqual(second.body.data.map(row => row._id), ["sugar-2"]);
  assert.equal(second.body.hasMore, false);
});

test("public history keeps all types when no type filter is supplied", async (t) => {
  const rows = [{ type: "blood_pressure" }, { type: "bmi" }];
  t.mock.method(Health, "find", filter => {
    assert.deepEqual(filter, { citizenId });
    return queryResult(rows);
  });
  t.mock.method(Health, "countDocuments", async () => rows.length);

  const res = await invoke(publicController.getHealthByCitizen, { query: { citizenId } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data, rows);
  assert.equal(res.body.total, 2);
});

test("public history rejects query objects instead of forwarding database operators", async (t) => {
  const find = t.mock.method(Health, "find", () => { throw new Error("Unexpected database query"); });
  for (const query of [
    {},
    { citizenId: { $ne: "" } },
    { citizenId, type: { $ne: "" } }
  ]) {
    const res = await invoke(publicController.getHealthByCitizen, { query });
    assert.equal(res.statusCode, 400);
  }
  assert.equal(find.mock.callCount(), 0);
});

test("history normalizes invalid pagination and limits oversized pages", async (t) => {
  t.mock.method(Health, "find", () => queryResult([]));
  t.mock.method(Health, "countDocuments", async () => 0);
  const res = await invoke(publicController.getHealthByCitizen, {
    query: { citizenId, page: "-4", limit: "10000" }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.page, 1);
  assert.equal(res.body.limit, 100);
});

for (const [name, handler] of [
  ["member details", userController.getUserById],
  ["full member history", userController.getUserFullProfile]
]) {
  for (const role of ["admin", "superadmin"]) {
    test(`${role} can read ${name}`, async (t) => {
      const user = { _id: "member-1", citizenId };
      t.mock.method(User, "findById", async () => user);
      t.mock.method(Health, "find", () => ({ sort: async () => [] }));
      const res = await invoke(handler, {
        params: { id: user._id }, user: { id: "administrator-1", role }
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.body.data.user || res.body.data)._id, user._id);
    });
  }

  test(`ordinary members cannot read another person's ${name}`, async (t) => {
    const find = t.mock.method(User, "findById", async () => null);
    const res = await invoke(handler, {
      params: { id: "member-1" }, user: { id: "member-2", role: "user" }
    });
    assert.equal(res.statusCode, 403);
    assert.equal(find.mock.callCount(), 0);
  });
}

test("verification queue combines status with literal full-name search and accurate totals", async (t) => {
  const rows = [
    { _id: "pending", firstName: "Eve", lastName: "[care]", status: "pending" },
    { _id: "active", firstName: "Eve", lastName: "[care]", status: "active" },
    { _id: "unrelated", firstName: "Eve", lastName: "care", status: "pending" }
  ];
  const select = filter => rows.filter(row =>
    row.status === filter.status && filter.$or.some(condition => {
      if (condition.$expr) {
        const { regex, options } = condition.$expr.$regexMatch;
        return new RegExp(regex, options).test(`${row.firstName} ${row.lastName}`);
      }
      const [field, { $regex, $options }] = Object.entries(condition)[0];
      return new RegExp($regex, $options).test(row[field] || "");
    })
  );
  t.mock.method(User, "find", filter => queryResult(select(filter)));
  t.mock.method(User, "countDocuments", async filter => select(filter).length);

  const res = await invoke(userController.getUsers, {
    query: { status: "pending", search: "eve [care]", page: "1", limit: "10" }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.map(row => row._id), ["pending"]);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.hasMore, false);
});

test("member list rejects operator objects in filters", async () => {
  const res = await invoke(userController.getUsers, {
    query: { status: { $ne: "active" }, search: "" }
  });
  assert.equal(res.statusCode, 400);
});

test("summary reports unique people separately from high-BMI record count", async (t) => {
  t.mock.method(User, "countDocuments", async () => 8);
  t.mock.method(User, "aggregate", async () => [{ _id: { status: "calculated", level: "high" }, total: 2 }, { _id: {}, total: 6 }]);
  t.mock.method(Health, "countDocuments", async filter => filter?.["cvdRisk.level"] ? 5 : 12);
  t.mock.method(Health, "aggregate", async pipeline => {
    assert.equal(pipeline[0].$match["cvdRisk.level"], "risk_high");
    assert.ok(pipeline.some(stage => stage.$group), "Count distinct people before counting rows");
    return [{ total: 2 }];
  });
  const res = await invoke(dashboardController.summary, {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.highRiskUsers, 2);
  assert.equal(res.body.data.highRiskRecords, 5);
  assert.equal(res.body.data.totalHealthRecords, 12);
  assert.equal(res.body.data.thaiCvRisk.high, 2);
  assert.equal(res.body.data.thaiCvRisk.incomplete, 6);
  assert.equal(res.body.data.thaiCvRisk.totalCalculated, 2);
});

test("summary returns zero unique high-BMI users for an empty aggregate", async (t) => {
  t.mock.method(User, "countDocuments", async () => 0);
  t.mock.method(User, "aggregate", async () => []);
  t.mock.method(Health, "countDocuments", async () => 0);
  t.mock.method(Health, "aggregate", async () => []);
  const res = await invoke(dashboardController.summary, {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.highRiskUsers, 0);
  assert.equal(res.body.data.highRiskRecords, 0);
});
