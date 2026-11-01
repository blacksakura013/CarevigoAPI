const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const AuthSession = require("../models/AuthSession");
const ids = require("./internalIds.service");
const { permittedBrowserOrigin } = require("../config/origins");
const { credentialVersion } = require("../utils/adminCredentials");

const SCOPES = ["patient", "admin"];
const COOKIE_NAMES = { patient: "carevigo_patient_session", admin: "carevigo_admin_session" };
const cookieMode = req => req.headers?.["x-carevigo-session"] === "cookie";
const scopeFor = req => SCOPES.includes(req.headers?.["x-carevigo-scope"]) ? req.headers["x-carevigo-scope"] : null;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function cookies(req) {
  const values = {};
  for (const part of String(req.headers?.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!Object.values(COOKIE_NAMES).includes(name) || Object.hasOwn(values, name)) continue;
    try { values[name] = decodeURIComponent(part.slice(separator + 1).trim()); } catch { /* Ignore malformed cookies. */ }
  }
  return values;
}

function cookieOptions() {
  const production = process.env.NODE_ENV === "production";
  const configured = process.env.COOKIE_SAME_SITE?.trim().toLowerCase();
  const sameSite = ["none", "lax", "strict"].includes(configured) ? configured : production ? "none" : "lax";
  return { httpOnly: true, secure: production || sameSite === "none", sameSite, path: "/api" };
}

function clearCookie(res, scope) {
  if (SCOPES.includes(scope)) res.clearCookie(COOKIE_NAMES[scope], cookieOptions());
}

function metadata(decoded) {
  return { scope: decoded.type, sessionId: decoded.sid, expiresAt: new Date(decoded.exp * 1000).toISOString(), csrfToken: decoded.csrf };
}

function reject(res, statusCode, message, code) {
  return res.status(statusCode).json({ statusCode, title: "Error", message, ...(code ? { code } : {}), data: null });
}

function browserRequest(req, res, next) {
  if (!cookieMode(req)) return next();
  const scope = scopeFor(req);
  if (!scope || !permittedBrowserOrigin(req) || req.headers.authorization) {
    return reject(res, 403, "Cookie session requires an allowed browser origin and scope");
  }
  if (req.query?.scope && req.query.scope !== scope || req.body?.scope && req.body.scope !== scope) {
    return reject(res, 403, "Session scope mismatch");
  }
  return next();
}

function loginRequest(scope) {
  return (req, res, next) => browserRequest(req, res, () => {
    if (cookieMode(req) && scopeFor(req) !== scope) return reject(res, 403, "Session scope mismatch");
    return next();
  });
}

function verifyToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  if (!SCOPES.includes(decoded.type) || typeof decoded.sid !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(decoded.sid) ||
      typeof decoded.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(decoded.csrf)) throw new Error("Invalid cookie session");
  return decoded;
}

async function authenticate(req) {
  const scope = scopeFor(req);
  const token = cookies(req)[COOKIE_NAMES[scope]];
  if (!token) throw new Error("No scoped cookie session");
  const decoded = verifyToken(token);
  if (decoded.type !== scope) throw new Error("Session scope mismatch");
  const session = await AuthSession.findOne({ _id: hash(decoded.sid), scope, accountId: decoded.id, expiresAt: { $gt: new Date() } });
  if (!session || String(session.accountId) !== String(decoded.id) || session.scope !== scope) throw new Error("Session revoked");
  if (session.accountKey !== undefined && session.accountKey !== null && ids.toInternalId(session.accountKey).toString() !== decoded.internalId) {
    throw new Error("Session account mismatch");
  }
  req.cookieSession = decoded;
  return decoded;
}

function csrfGuard(req, res) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const supplied = req.headers?.["x-csrf-token"];
  const expected = req.cookieSession?.csrf;
  if (typeof supplied !== "string" || typeof expected !== "string" || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    reject(res, 403, "Invalid CSRF token", "CSRF_INVALID");
    return false;
  }
  return true;
}

async function revoke(decoded) {
  if (decoded?.sid && SCOPES.includes(decoded.type)) await AuthSession.deleteOne({ _id: hash(decoded.sid), scope: decoded.type });
}

async function revokeAccount(scope, accountId, beforeVersion) {
  const filter = { scope, accountId };
  if (beforeVersion !== undefined) {
    if (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1) throw new RangeError("Invalid session revocation version");
    // A new-password login may complete after the credential update but before
    // this deletion. Remove only earlier generations and legacy unversioned
    // rows; the committed or any newer generation must survive.
    filter.$or = [{ tokenVersion: { $lt: beforeVersion } }, { tokenVersion: { $exists: false } }];
  }
  await AuthSession.deleteMany(filter);
}

async function issue(req, res, scope, account) {
  const now = Math.floor(Date.now() / 1000);
  const maxAgeSeconds = scope === "patient" ? 8 * 60 * 60 : 7 * 24 * 60 * 60;
  const internalId = ids.getInternalId(account);
  const decoded = { id: String(account._id), role: scope === "patient" ? "user" : account.role, type: scope,
    sid: crypto.randomBytes(24).toString("base64url"), csrf: crypto.randomBytes(32).toString("base64url"),
    iat: now, exp: now + maxAgeSeconds,
    ...(scope === "patient" ? { tokenVersion: account.tokenVersion } : { email: account.email, tokenVersion: credentialVersion(account) }),
    ...(internalId === undefined ? {} : { internalId: internalId.toString() }) };
  const token = jwt.sign(decoded, process.env.JWT_SECRET, { algorithm: "HS256" });
  await AuthSession.create({ _id: hash(decoded.sid), scope, accountId: account._id,
    ...(internalId === undefined ? {} : { accountKey: internalId }), tokenVersion: decoded.tokenVersion, expiresAt: new Date(decoded.exp * 1000) });
  // Login and password rotation replace only the current browser's same scope.
  // Keep its previous session usable if persisting the replacement failed.
  let previous = req.cookieSession;
  if (!previous) {
    try { previous = verifyToken(cookies(req)[COOKIE_NAMES[scope]]); } catch { /* First login or expired cookie. */ }
  }
  if (previous?.type === scope) await revoke(previous);
  res.cookie(COOKIE_NAMES[scope], token, { ...cookieOptions(), maxAge: maxAgeSeconds * 1000 });
  res.set("X-Carevigo-Session-Id", decoded.sid);
  req.cookieSession = decoded;
  return metadata(decoded);
}

module.exports = { SCOPES, COOKIE_NAMES, cookieMode, scopeFor, cookies, cookieOptions, clearCookie, metadata,
  browserRequest, loginRequest, authenticate, csrfGuard, issue, revoke, revokeAccount, hash };
