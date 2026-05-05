const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: "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",
});

exports.askAI = async (message) => {
  const res = await client.chat.completions.create({
    model: "gpt-5-mini",
    messages: [
      {
        role: "system",
        content: "คุณคือผู้ช่วยด้านสุขภาพ ให้คำแนะนำแบบเข้าใจง่าย",
      },
      {
        role: "user",
        content: message,
      },
    ],
  });

  return res.choices[0].message.content;
};