exports.replyText = async (client, token, text) => {
  return client.replyMessage(token, {
    type: "text",
    text: String(text).slice(0, 2000),
  });
};

exports.replyMenu = async (client, token) => {
  return client.replyMessage(token, {
    type: "flex",
    altText: "เมนู",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "Carevigo", weight: "bold", size: "lg" },
          { type: "text", text: "เลือกเมนู", margin: "md" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: {
              type: "message",
              label: "ดูข้อมูล",
              text: "profile 1103701234567",
            },
          },
          {
            type: "button",
            action: {
              type: "uri",
              label: "🚨 โทร 1669",
              uri: "line://nv/call/1669",
            },
          },
        ],
      },
    },
  });
};

exports.replyEmergency = async (client, token) => {
  return client.replyMessage(token, {
    type: "template",
    altText: "ฉุกเฉิน",
    template: {
      type: "buttons",
      text: "ต้องการโทรฉุกเฉินหรือไม่",
      actions: [
        {
          type: "uri",
          label: "🚨 โทร 1669",
          uri: "line://nv/call/1669",
        },
      ],
    },
  });
};

exports.replyProfile = async (client, token, user) => {
  return client.replyMessage(token, {
    type: "text",
    text: `👤 ${user.firstName} ${user.lastName}
📞 ${user.phone || "-"}
📍 ${user.province || "-"}
⚖️ ${user.weight || "-"}kg / ${user.height || "-"}cm`,
  });
};