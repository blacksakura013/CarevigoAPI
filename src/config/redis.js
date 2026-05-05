const Redis = require("ioredis");

let redis = null;

if (process.env.REDIS_URL && process.env.REDIS_URL !== "disabled") {
  redis = new Redis(process.env.REDIS_URL, {
    retryStrategy: () => null // ❌ ไม่ retry
  });

  redis.on("connect", () => {
    console.log("✅ Redis connected");
  });

  redis.on("error", (err) => {
    console.log("❌ Redis error:", err.message);
  });

} else {
  console.log("⚠️ Redis disabled");
}

module.exports = redis;