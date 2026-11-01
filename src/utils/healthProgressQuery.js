const TYPES = ["blood_pressure", "sugar", "cholesterol", "bmi"];
const KEYS = new Set(["citizenId", "days", "from", "to", "reviewStatus", "page", "limit"]);
const DAY = 86400000, OFFSET = 7 * 3600000;

function invalid() {
  const error = new Error("ตัวกรองประวัติสุขภาพไม่ถูกต้อง กรุณาตรวจสอบช่วงวันที่และเลขหน้า");
  error.code = "INVALID_PROGRESS_QUERY";
  throw error;
}
function integer(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return invalid();
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? number : invalid();
}
function calendarDay(value) {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
  const utc = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, 10) !== value) return invalid();
  return new Date(utc.getTime() - OFFSET);
}

function healthProgressQuery(query = {}, now = new Date()) {
  if (!query || typeof query !== "object" || Array.isArray(query) || Object.keys(query).some(key => !KEYS.has(key))) return invalid();
  if (typeof query.citizenId !== "string" || !/^\d{13}$/.test(query.citizenId)) return invalid();
  if (Object.values(query).some(value => typeof value !== "string")) return invalid();
  const page = integer(query.page, 1), limit = integer(query.limit, 20, 50), skip = (page - 1) * limit;
  if (!Number.isSafeInteger(skip)) return invalid();
  const reviewStatus = query.reviewStatus === undefined ? "all" : query.reviewStatus;
  if (!["all", "approved", "pending", "rejected"].includes(reviewStatus)) return invalid();
  const custom = query.from !== undefined || query.to !== undefined;
  if (custom && (query.from === undefined || query.to === undefined || query.days !== undefined)) return invalid();
  const asOf = new Date(now);
  const today = new Date(asOf.getTime() + OFFSET).toISOString().slice(0, 10);
  let from = null, to = today, start = null, end;
  if (custom) {
    start = calendarDay(query.from); end = new Date(calendarDay(query.to).getTime() + DAY);
    if (start.getTime() >= end.getTime()) return invalid();
    from = query.from; to = query.to;
  } else {
    const days = query.days === undefined ? "90" : query.days;
    if (!["30", "90", "365", "all"].includes(days)) return invalid();
    end = new Date(calendarDay(today).getTime() + DAY);
    if (days !== "all") {
      start = new Date(calendarDay(today).getTime() - (Number(days) - 1) * DAY);
      from = new Date(start.getTime() + OFFSET).toISOString().slice(0, 10);
    }
  }
  return { citizenId: query.citizenId, page, limit, skip, reviewStatus, start, end, asOf,
    range: { from, to, asOf: asOf.toISOString(), timeZone: "Asia/Bangkok" } };
}

module.exports = { healthProgressQuery, TYPES };
