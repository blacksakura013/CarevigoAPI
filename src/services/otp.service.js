const redis = require("../config/redis");
const bcrypt = require("bcrypt");

const OTP_EXPIRE = parseInt(process.env.OTP_EXPIRE) || 300;
const OTP_MAX_ATTEMPT = parseInt(process.env.OTP_MAX_ATTEMPT) || 5;

// 🔢 generate OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// 📩 create OTP
exports.sendOTP = async (email) => {
  const otp = generateOTP();
  const hashedOTP = await bcrypt.hash(otp, 10);

  const key = `admin:otp:${email}`;

  await redis.set(
    key,
    JSON.stringify({
      otp: hashedOTP,
      attempts: 0
    }),
    "EX",
    OTP_EXPIRE
  );

  return otp;
};

// ✅ verify OTP
exports.verifyOTP = async (email, inputOTP) => {
  const key = `admin:otp:${email}`;
  const data = await redis.get(key);

  if (!data) throw new Error("OTP expired");

  const parsed = JSON.parse(data);

  if (parsed.attempts >= OTP_MAX_ATTEMPT) {
    throw new Error("Too many attempts");
  }

  const isValid = await bcrypt.compare(inputOTP, parsed.otp);

  if (!isValid) {
    parsed.attempts += 1;

    await redis.set(key, JSON.stringify(parsed), "KEEPTTL");

    throw new Error("Invalid OTP");
  }

  // ✅ success → delete OTP
  await redis.del(key);

  return true;
};