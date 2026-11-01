const CODES = new Set([
  "EAUTH", "EENVELOPE", "EMESSAGE", "ECONNECTION", "ESOCKET", "ETIMEDOUT", "ETLS", "EPROTO", "EDNS",
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER",
]);
const COMMANDS = new Set([
  "API", "CONN", "CONNECT", "DNS", "EHLO", "HELO", "STARTTLS", "AUTH", "AUTH PLAIN", "AUTH LOGIN",
  "AUTH XOAUTH2", "MAIL FROM", "RCPT TO", "DATA", "RSET", "NOOP", "QUIT",
]);
const NETWORK = new Set(["ECONNECTION", "ESOCKET", "ETIMEDOUT", "EDNS", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE"]);
const TLS = new Set(["ETLS", "EPROTO", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER"]);
const safeChoice = (value, choices) => typeof value === "string" && choices.has(value.trim().toUpperCase()) ? value.trim().toUpperCase() : "UNKNOWN";
const safeText = value => typeof value === "string" ? value.slice(0, 4096) : "";

// SMTP errors frequently contain the recipient, credentials or the complete
// message. Never return or spread the error itself, its text, response or stack.
function smtpFailure(error) {
  try {
    const code = safeChoice(error?.code, CODES), command = safeChoice(error?.command, COMMANDS);
    const rawCode = error?.responseCode;
    const candidate = typeof rawCode === "number" ? rawCode : typeof rawCode === "string" && /^[2-5]\d{2}$/.test(rawCode) ? Number(rawCode) : null;
    const responseCode = Number.isInteger(candidate) && candidate >= 200 && candidate <= 599 ? candidate : null;
    const response = safeText(error?.response);
    const enhanced = typeof error?.enhancedStatus === "string" && /^[245]\.\d{1,3}\.\d{1,3}$/.test(error.enhancedStatus)
      ? error.enhancedStatus : response.match(/^(?:[2-5]\d{2}[ -])?([245]\.\d{1,3}\.\d{1,3})(?=\s|$|[-:])/)?.[1];
    const text = `${response}\n${safeText(error?.message)}`;
    let category = "unknown";
    if (/\b(?:quota|rate[ -]?limit(?:ed)?|too many (?:messages|requests|connections|login attempts)|sending limit|daily limit)\b/i.test(text) || enhanced === "4.2.2" || enhanced === "5.2.2") category = "rate_quota";
    else if (code === "EAUTH" || responseCode === 535 || responseCode === 534) category = "authentication";
    else if (TLS.has(code) || /\b(?:TLS|SSL|certificate)\b/i.test(text)) category = "tls";
    else if (NETWORK.has(code)) category = "network_timeout";
    else if (code === "EENVELOPE" && command !== "MAIL FROM" || command === "RCPT TO" && responseCode >= 500 || enhanced?.startsWith("5.1.")) category = "recipient_rejected";
    else if (code === "EMESSAGE" || command === "DATA" && responseCode >= 400 || command === "MAIL FROM" && responseCode >= 400) category = "message_rejected";
    return { category, code, responseCode, command, ...(enhanced ? { enhancedStatus: enhanced } : {}) };
  } catch {
    return { category: "unknown", code: "UNKNOWN", responseCode: null, command: "UNKNOWN" };
  }
}

module.exports = { smtpFailure };
