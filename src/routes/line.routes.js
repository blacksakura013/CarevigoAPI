const express = require("express");
const line = require("@line/bot-sdk");
const handleEvent = require("../handlers/line.handler");

const router = express.Router();

// ===============================
// 🔐 CONFIG
// ===============================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// ===============================
// 🚀 CLIENT (v11)
// ===============================
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// ===============================
// 🧪 GET (debug)
// ===============================
router.get("/webhook", (req, res) => {
  res.status(200).send("LINE webhook ready ✅");
});

// ===============================
// 🔥 POST WEBHOOK
// ===============================
router.post(
  "/webhook",

  // 🔥 สำคัญ: ใช้ middleware ของ LINE ตรง ๆ
  line.middleware(config),

  async (req, res) => {
    try {
      console.log("🔥 WEBHOOK HIT");

      const events = req.body.events || [];

      await Promise.all(
        events.map(async (event) => {
          try {
            await handleEvent(event, client);
          } catch (err) {
            console.error("❌ HANDLE EVENT ERROR:", err);
          }
        })
      );

      return res.status(200).json({ ok: true });

    } catch (err) {
      console.error("❌ WEBHOOK ERROR:", err);

      // 🔥 ต้องตอบ 200 เท่านั้น
      return res.status(200).json({ error: "handled" });
    }
  }
);

module.exports = router;