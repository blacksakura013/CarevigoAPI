const { test } = require("node:test");
const assert = require("node:assert/strict");

test("optional AI can load without a credential and rejects before any network call", async t => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  const service = require("../src/services/openai.service");
  assert.equal(typeof service.askAI, "function");
  await assert.rejects(service.askAI("synthetic configuration check"), /AI service is not configured/);
});
