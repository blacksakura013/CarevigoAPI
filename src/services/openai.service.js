const OpenAI = require("openai");

let client;
function configuredClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error("AI service is not configured");
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

exports.askAI = async (message) => {
  const res = await configuredClient().chat.completions.create({
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