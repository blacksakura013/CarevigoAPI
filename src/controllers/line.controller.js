// src/controllers/line.controller.js
const { client } = require("../config/line");

exports.handleWebhook = async (req, res) => {
  try {
    const events = req.body.events;

    await Promise.all(events.map(handleEvent));

    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
};

async function handleEvent(event) {
  if (event.type !== "message") return null;

  const text = event.message.text;

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `คุณพิมพ์ว่า: ${text}`
  });
}