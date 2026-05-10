const bcrypt = require("bcrypt");

let redis = null;

try {
  redis = require("../config/redis");
} catch (err) {
  console.log("⚠️ Redis unavailable, using memory OTP");
}

const OTP_EXPIRE = parseInt(process.env.OTP_EXPIRE) || 300;
const OTP_MAX_ATTEMPT = parseInt(process.env.OTP_MAX_ATTEMPT) || 5;

// 🔥 memory fallback
const otpStore = new Map();

// ===============================
// GENERATE OTP
// ===============================
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// ===============================
// SEND OTP
// ===============================
exports.sendOTP = async (email) => {
  const otp = generateOTP();
  const hashedOTP = await bcrypt.hash(otp, 10);

  const key = `admin:otp:${email}`;

  // ✅ Redis mode
  if (redis) {
    await redis.set(
      key,
      JSON.stringify({
        otp: hashedOTP,
        attempts: 0
      }),
      "EX",
      OTP_EXPIRE
    );
  }

  // ✅ Memory fallback
  else {
    otpStore.set(key, {
      otp: hashedOTP,
      attempts: 0,
      expiresAt: Date.now() + OTP_EXPIRE * 1000
    });
  }

  return otp;
};

// ===============================
// VERIFY OTP
// ===============================
exports.verifyOTP = async (email, inputOTP) => {
  const key = `admin:otp:${email}`;

  let parsed = null;

  // ✅ Redis mode
  if (redis) {
    const data = await redis.get(key);

    if (!data) {
      throw new Error("OTP expired");
    }

    parsed = JSON.parse(data);
  }

  // ✅ Memory mode
  else {
    parsed = otpStore.get(key);

    if (!parsed) {
      throw new Error("OTP expired");
    }

    if (Date.now() > parsed.expiresAt) {
      otpStore.delete(key);
      throw new Error("OTP expired");
    }
  }

  // ❌ too many attempts
  if (parsed.attempts >= OTP_MAX_ATTEMPT) {
    throw new Error("Too many attempts");
  }

  const isValid = await bcrypt.compare(inputOTP, parsed.otp);

  // ❌ invalid OTP
  if (!isValid) {
    parsed.attempts += 1;

    // Redis
    if (redis) {
      await redis.set(
        key,
        JSON.stringify(parsed),
        "KEEPTTL"
      );
    }

    // Memory
    else {
      otpStore.set(key, parsed);
    }

    throw new Error("Invalid OTP");
  }

  // ✅ success
  if (redis) {
    await redis.del(key);
  } else {
    otpStore.delete(key);
  }

  return true;
};