const {
  replyText,
  replyMenu,
  replyEmergency,
} = require("../services/line.service");

const { askAI } = require("../services/openai.service");
function patientLoginUrl() {
  const fallback = "https://carevigo-frontend.onrender.com/login";
  try {
    const configured = new URL(process.env.FRONTEND_URL || fallback);
    if (configured.protocol !== "https:" && !(configured.protocol === "http:" && ["localhost", "127.0.0.1"].includes(configured.hostname))) return fallback;
    return `${configured.origin}/login`;
  } catch { return fallback; }
}

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
      return await replyText(client, event.replyToken,
        `เพื่อความเป็นส่วนตัว กรุณาเข้าสู่ระบบผู้รับบริการเพื่อดูข้อมูลของคุณ\n${patientLoginUrl()}\nขณะนี้ยังไม่เปิดการเชื่อมบัญชีส่วนตัวผ่าน LINE`);
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
