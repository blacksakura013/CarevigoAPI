const test = require("node:test");
const assert = require("node:assert/strict");
const { allowedOrigins, permittedBrowserOrigin } = require("../src/config/origins");

function environment(t, nodeEnv, configured) {
  const previous = { NODE_ENV: process.env.NODE_ENV, CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.NODE_ENV = nodeEnv;
  if (configured === undefined) delete process.env.CORS_ALLOWED_ORIGINS; else process.env.CORS_ALLOWED_ORIGINS = configured;
}

test("development origins allow exactly the two common local frontend ports without accepting other hosts or ports", t => {
  environment(t, "development");
  for (const host of ["localhost", "127.0.0.1"]) for (const port of [3000, 3001]) {
    const origin = `http://${host}:${port}`;
    assert.equal(allowedOrigins().includes(origin), true);
    assert.equal(permittedBrowserOrigin({ headers: { origin } }), true);
  }
  for (const origin of ["http://localhost:3002", "http://localhost:30010", "http://localhost.example:3001", "http://127.0.0.2:3001", "https://localhost:3001"]) {
    assert.equal(permittedBrowserOrigin({ headers: { origin } }), false);
  }
});

test("production does not inherit the development port 3001 convenience", t => {
  environment(t, "production");
  assert.deepEqual(allowedOrigins(), ["http://localhost:3000", "http://127.0.0.1:3000", "https://carevigo-frontend.onrender.com"]);
  for (const origin of ["http://localhost:3001", "http://127.0.0.1:3001"]) assert.equal(permittedBrowserOrigin({ headers: { origin } }), false);
});

test("an explicit origin allowlist replaces all defaults, including an intentionally empty list", t => {
  environment(t, "development", " https://configured.example.test,not-a-url,https://configured.example.test/path ");
  assert.deepEqual(allowedOrigins(), ["https://configured.example.test"]);
  assert.equal(permittedBrowserOrigin({ headers: { origin: "http://localhost:3001" } }), false);
  process.env.CORS_ALLOWED_ORIGINS = "";
  assert.deepEqual(allowedOrigins(), []);
});
