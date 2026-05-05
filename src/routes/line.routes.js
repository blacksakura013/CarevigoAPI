const express = require("express");
const line = require("@line/bot-sdk");
const handleEvent = require("../handlers/line.handler");

const router = express.Router();

// ===============================
// 🔐 LINE CONFIG
// ===============================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// ===============================
// 🚀 LINE CLIENT (v11)
// ===============================
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// ===============================
// 🧪 HEALTH CHECK (optional)
// ===============================
router.get("/webhook", (req, res) => {
  res.status(200).send("LINE webhook ready ✅");
});

// ===============================
// 🔥 WEBHOOK (สำคัญ)
// ===============================
router.post(
  "/webhook",

  // 🔧 DEV: bypass signature (กัน error no signature)
  (req, res, next) => {
    if (process.env.NODE_ENV !== "production") {
      return next();
    }
    return line.middleware(config)(req, res, next);
  },

  async (req, res) => {
    try {
      console.log("🔥 LINE WEBHOOK HIT");
      console.log("BODY:", JSON.stringify(req.body, null, 2));

      const events = req.body.events || [];

      if (!events.length) {
        return res.status(200).json({ ok: true });
      }

      // process events
      await Promise.all(
        events.map(async (event) => {
          try {
            await handleEvent(event, client);
          } catch (err) {
            console.error("❌ HANDLE EVENT ERROR:", err);
          }
        })
      );

      // 🔥 สำคัญ: ต้อง 200 เสมอ
      return res.status(200).json({ success: true });

    } catch (err) {
      console.error("❌ WEBHOOK ERROR:", err);

      // 🔥 ห้าม throw → LINE จะ fail
      return res.status(200).json({ error: "handled" });
    }
  }
);

module.exports = router;