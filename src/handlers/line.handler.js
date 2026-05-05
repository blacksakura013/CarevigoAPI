const {
  replyText,
  replyMenu,
  replyEmergency,
  replyProfile,
} = require("../services/line.service");

const { getProfile } = require("../services/api.service");
const { askAI } = require("../services/openai.service");

module.exports = async (event, client) => {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();

  // ===============================
  // 📋 เมนู
  // ===============================
  if (text === "เมนู") {
    return replyMenu(client, event.replyToken);
  }

  // ===============================
  // 👤 profile
  // ===============================
  if (text.startsWith("profile")) {
    const citizenId = text.split(" ")[1];

    if (!citizenId) {
      return replyText(client, event.replyToken, "กรุณาระบุเลขบัตร");
    }

    try {
      const res = await getProfile(citizenId);
      return replyProfile(client, event.replyToken, res.data.data.user);
    } catch {
      return replyText(client, event.replyToken, "ไม่พบข้อมูล");
    }
  }

  // ===============================
  // 🚨 ฉุกเฉิน
  // ===============================
  if (text === "ฉุกเฉิน") {
    return replyEmergency(client, event.replyToken);
  }

  // ===============================
  // 🤖 AI fallback
  // ===============================
  try {
    const ai = await askAI(text);
    return replyText(client, event.replyToken, ai);
  } catch {
    return replyText(client, event.replyToken, "ขออภัย ระบบมีปัญหา");
  }
};