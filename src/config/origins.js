// Share the browser allowlist between CORS and cookie authentication.
function allowedOrigins() {
  const configured = process.env.CORS_ALLOWED_ORIGINS;
  const defaults = ["http://localhost:3000", "http://127.0.0.1:3000", "https://carevigo-frontend.onrender.com"];
  // CRA selects 3001 when another local checkout already occupies 3000. Keep
  // this development convenience exact and out of the production default list.
  if (process.env.NODE_ENV !== "production") defaults.push("http://localhost:3001", "http://127.0.0.1:3001");
  const values = configured === undefined
    ? defaults
    : configured.split(",").map(value => value.trim()).filter(Boolean);
  return values.filter(value => {
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && url.origin === value; }
    catch { return false; }
  });
}

function permittedBrowserOrigin(req) {
  const origin = req.headers?.origin;
  if (origin) return allowedOrigins().includes(origin);
  // Browsers may omit Origin on requests to the API's own origin. Fetch metadata
  // cannot be set by JavaScript on a different site.
  return req.headers?.["sec-fetch-site"] === "same-origin";
}

module.exports = { allowedOrigins, permittedBrowserOrigin };
