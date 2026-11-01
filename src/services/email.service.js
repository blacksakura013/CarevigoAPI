// ======================================
// src/services/email.service.js
// ======================================

const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");

// ======================================
// SMTP
// ======================================

let transporter;
const getTransporter = () => transporter || (transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
}));

// ======================================
// VERIFY SMTP
// ======================================

// Create SMTP connections only when sending; importing this module performs no IO.

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
Save Stroke Verification
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
    from: `"Save Stroke" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Save Stroke - OTP Verification",
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
    const info = await getTransporter().sendMail(mailOptions);

    console.log("✅ EMAIL SENT");
    console.log(info);

    return info;
  } catch (err) {
    console.error("❌ SEND EMAIL ERROR");
    console.error(err);

    throw err;
  }
};

exports.sendReviewNotification = async ({ recipient, patientName, recordCount, deadlineLabel, approveUrl, rejectUrl }) => {
  return getTransporter().sendMail({
    from: `"Save Stroke" <${process.env.EMAIL_USER}>`, to: recipient,
    subject: "Save Stroke: มีบันทึกสุขภาพใหม่รอตรวจสอบ",
    text: `มีบันทึกสุขภาพใหม่ ${recordCount} รายการ จาก ${patientName || "ผู้ส่งข้อมูล"}\nกำหนดตรวจสอบ: ${deadlineLabel} (Asia/Bangkok)\nหากยังไม่ตรวจสอบ ระบบอนุมัติอัตโนมัติตามกำหนด\n\nตรวจสอบและยืนยันอนุมัติ: ${approveUrl}\nตรวจสอบและยืนยันยกเลิก: ${rejectUrl}\n\nการเปิดลิงก์จะยังไม่เปลี่ยนสถานะ ต้องกดยืนยันในหน้าที่เปิด ลิงก์นี้มีสิทธิ์เฉพาะชุดข้อมูลนี้ กรุณาอย่าส่งต่อ`
  });
};

// The capability is sent only to the account's stored email. Do not log the
// recipient, reset URL, SMTP response or errors containing message contents.
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
exports.sendAdminPasswordReset = async ({ recipient, resetUrl }) => getTransporter().sendMail({
  from: `"Save Stroke" <${process.env.EMAIL_USER}>`, to: recipient,
  subject: "Save Stroke: ตั้งรหัสผ่านเจ้าหน้าที่ใหม่",
  text: `ได้รับคำขอตั้งรหัสผ่านบัญชีเจ้าหน้าที่ Save Stroke ใหม่\n\nตั้งรหัสผ่านใหม่: ${resetUrl}\n\nลิงก์นี้มีอายุ 30 นาที ใช้ได้ครั้งเดียว และลิงก์ล่าสุดจะแทนลิงก์ก่อนหน้า\nหากคุณไม่ได้ขอเปลี่ยนรหัสผ่าน ไม่ต้องดำเนินการใด ๆ รหัสผ่านเดิมยังใช้งานได้\nกรุณาอย่าส่งต่อลิงก์นี้`,
  html: `<div lang="th" style="margin:0;padding:24px 16px;background:#f3f7f5;font-family:Tahoma,Arial,sans-serif;font-size:18px;line-height:1.7;color:#183e35">
    <table role="presentation" style="width:100%;max-width:560px;margin:0 auto;border-collapse:collapse;background:#ffffff"><tr><td style="padding:28px">
      <p style="margin:0 0 12px;font-size:24px;font-weight:700;color:#147d64">Save Stroke</p>
      <h1 style="margin:0 0 16px;font-size:26px;line-height:1.5">ตั้งรหัสผ่านเจ้าหน้าที่ใหม่</h1>
      <p style="margin:0 0 20px">ได้รับคำขอตั้งรหัสผ่านบัญชีเจ้าหน้าที่ของคุณใหม่ กดปุ่มด้านล่างเพื่อตั้งรหัสผ่านใหม่</p>
      <p style="margin:0 0 24px"><a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:16px 24px;background:#147d64;color:#ffffff;border-radius:12px;font-size:18px;font-weight:700;text-decoration:none;line-height:1.5">ตั้งรหัสผ่านใหม่</a></p>
      <p style="margin:0 0 16px">ลิงก์นี้มีอายุ <strong>30 นาที</strong> และใช้ได้ครั้งเดียว หากขอลิงก์ใหม่ กรุณาใช้ลิงก์ล่าสุด</p>
      <p style="margin:0">หากคุณไม่ได้ขอเปลี่ยนรหัสผ่าน ไม่ต้องดำเนินการใด ๆ รหัสผ่านเดิมยังใช้งานได้ กรุณาอย่าส่งต่อลิงก์นี้</p>
    </td></tr></table></div>`,
});
