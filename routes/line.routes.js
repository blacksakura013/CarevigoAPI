const express = require("express");
const line = require("@line/bot-sdk");
const handleEvent = require("../handlers/line.handler");

const router = express.Router();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

// webhook
router.post(
  "/webhook",
  line.middleware(config),
  async (req, res) => {
    try {
      const events = req.body.events || [];

      await Promise.all(
        events.map((event) => handleEvent(event, client))
      );

      res.status(200).end(); // 🔥 LINE ต้องได้ 200
    } catch (err) {
      console.error("LINE ERROR:", err);
      res.status(200).end(); // 🔥 ห้าม throw
    }
  }
);

module.exports = router;