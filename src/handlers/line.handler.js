const {
  replyText,
  replyMenu,
  replyEmergency,
  replyProfile,
} = require("../services/line.service");

const { getProfile } = require("../services/api.service");
const { askAI } = require("../services/openai.service");

// ===============================
// 🤖 MAIN HANDLER
// ===============================
module.exports = async (event, client) => {
  try {
    // ===============================
    // ❌ ignore non-message
    // ===============================
    if (!event || event.type !== "message") return;

    if (!event.message || event.message.type !== "text") return;

    const text = (event.message.text || "").trim();

    console.log("📩 USER:", text);

    // ===============================
    // 📋 MENU
    // ===============================
    if (text === "เมนู") {
      return await replyMenu(client, event.replyToken);
    }

    // ===============================
    // 👤 PROFILE
    // ===============================
    if (text.startsWith("profile")) {
      const citizenId = text.split(" ")[1];

      if (!citizenId) {
        return await replyText(
          client,
          event.replyToken,
          "กรุณาระบุเลขบัตร เช่น profile 1103xxxxxxx"
        );
      }

      try {
        const res = await getProfile(citizenId);

        const user = res?.data?.data?.user;

        return await replyProfile(client, event.replyToken, user);
      } catch (err) {
        console.error("❌ PROFILE ERROR:", err.message);

        return await replyText(
          client,
          event.replyToken,
          "ไม่พบข้อมูลผู้ใช้"
        );
      }
    }

    // ===============================
    // 🚨 EMERGENCY
    // ===============================
    if (
      text === "ฉุกเฉิน" ||
      text === "ช่วยด้วย" ||
      text.toLowerCase().includes("help")
    ) {
      return await replyEmergency(client, event.replyToken);
    }

    // ===============================
    // 🤖 AI RESPONSE (DEFAULT)
    // ===============================
    try {
      const ai = await askAI(text);

      return await replyText(
        client,
        event.replyToken,
        (ai || "ไม่สามารถตอบได้").slice(0, 2000)
      );
    } catch (err) {
      console.error("❌ AI ERROR:", err.message);

      return await replyText(
        client,
        event.replyToken,
        "ขออภัย ระบบ AI มีปัญหา"
      );
    }
  } catch (err) {
    // 🔥 สำคัญ: ห้าม throw เด็ดขาด
    console.error("❌ HANDLER FATAL:", err);

    return;
  }
};