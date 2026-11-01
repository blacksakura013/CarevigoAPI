// Versionless staff credentials predate revocation support and represent only
// version zero. Once credentials rotate, those legacy tokens cannot authenticate.
function credentialVersion(account) {
  const version = account?.tokenVersion ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("Invalid staff credential version");
  return version;
}

function versionFilter(version) {
  if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid staff credential version");
  return version === 0 ? { $or: [{ tokenVersion: 0 }, { tokenVersion: { $exists: false } }] } : { tokenVersion: version };
}

module.exports = { credentialVersion, versionFilter };
