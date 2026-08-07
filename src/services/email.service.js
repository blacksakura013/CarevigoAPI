// ======================================
// src/services/email.service.js
// ======================================

const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");

// ======================================
// SMTP
// ======================================

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ======================================
// VERIFY SMTP
// ======================================

transporter.verify((err, success) => {
  if (err) {
    console.error("❌ SMTP VERIFY ERROR");
    console.error(err);
  } else {
    console.log("✅ Gmail SMTP Ready");
  }
});

// ======================================
// TEMPLATE
// ======================================

const getOTPTemplate = (otp) => `
<table width="100%" style="padding:20px;background:#f5f5f5">
<tr>
<td align="center">

<table width="500" style="background:#ffffff;border-radius:12px;padding:30px">

<tr>
<td align="center">
<h2 style="color:#2e7d32">
CareVigo Verification
</h2>
</td>
</tr>

<tr>
<td align="center">

<div
style="
font-size:34px;
font-weight:bold;
letter-spacing:8px;
background:#e8f5e9;
padding:16px 24px;
border-radius:10px;
display:inline-block;
color:#2e7d32;
"
>
${otp}
</div>

</td>
</tr>

<tr>
<td align="center"
style="
padding-top:20px;
color:#666;
font-size:14px;
"
>
OTP นี้สามารถใช้งานได้ภายใน 5 นาที
<br>
กรุณาอย่าเปิดเผยรหัสนี้กับผู้อื่น
</td>
</tr>

</table>

</td>
</tr>
</table>
`;

// ======================================
// SEND OTP
// ======================================

exports.sendOTPEmail = async (email, otp) => {
  console.log("=================================");
  console.log("📧 SEND OTP EMAIL");
  console.log("TO:", email);
  console.log("EMAIL_USER:", process.env.EMAIL_USER);
  console.log("=================================");

  const mailOptions = {
    from: `"CareVigo" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "CareVigo - OTP Verification",
    html: getOTPTemplate(otp),
  };

  // แนบ logo ถ้ามีจริง
  const logoPath = path.join(__dirname, "logo.png");

  if (fs.existsSync(logoPath)) {
    mailOptions.attachments = [
      {
        filename: "logo.png",
        path: logoPath,
        cid: "logo",
      },
    ];
  } else {
    console.warn("⚠ logo.png not found, sending without logo.");
  }

  try {
    const info = await transporter.sendMail(mailOptions);

    console.log("✅ EMAIL SENT");
    console.log(info);

    return info;
  } catch (err) {
    console.error("❌ SEND EMAIL ERROR");
    console.error(err);

    throw err;
  }
};