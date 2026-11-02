const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

function reviewNotificationEmail({ patientName, recordCount, profileOnly = false, deadlineLabel, approveUrl, rejectUrl }) {
  const name = patientName || "ผู้ส่งข้อมูล";
  const summary = profileOnly
    ? "มีข้อมูลส่วนตัวใหม่โดยไม่ได้ระบุผลตรวจสุขภาพ"
    : `มีบันทึกสุขภาพใหม่ ${recordCount} รายการ`;
  const subject = profileOnly
    ? "Save Stroke: มีข้อมูลส่วนตัวใหม่รอตรวจสอบ"
    : "Save Stroke: มีบันทึกสุขภาพใหม่รอตรวจสอบ";
  const text = `${summary} จาก ${name}\nกำหนดตรวจสอบ: ${deadlineLabel} (Asia/Bangkok)\nหากยังไม่ตรวจสอบ ระบบอนุมัติอัตโนมัติตามกำหนด\n\nตรวจสอบและยืนยันอนุมัติ: ${approveUrl}\nตรวจสอบและยืนยันยกเลิก: ${rejectUrl}\n\nการเปิดลิงก์จะยังไม่เปลี่ยนสถานะ ต้องกดยืนยันในหน้าที่เปิด ลิงก์นี้มีสิทธิ์เฉพาะชุดข้อมูลนี้ กรุณาอย่าส่งต่อ`;
  const html = `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(subject)}</title>
  <style>
    @media (prefers-color-scheme: dark) {
      .email-page { background-color: #142724 !important; }
      .email-card { background-color: #203630 !important; border-color: #47635b !important; }
      .email-text { color: #f1f8f5 !important; }
      .email-muted { color: #d0e1d9 !important; }
      .email-badge { background-color: #493b16 !important; color: #ffe4a3 !important; }
      .email-deadline { background-color: #30463e !important; border-color: #718c80 !important; }
      .email-divider { border-color: #47635b !important; }
    }
  </style>
</head>
<body class="email-page" style="margin:0;padding:0;background-color:#f1f6f3;font-family:Tahoma,Arial,sans-serif;font-size:18px;line-height:1.7;color:#153e35;">
  <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(summary)} · ตรวจสอบภายใน ${escapeHtml(deadlineLabel)} (เวลาไทย)</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-page" bgcolor="#f1f6f3" style="width:100%;background-color:#f1f6f3;">
    <tr><td align="center" style="padding:24px 12px;">
      <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-card" bgcolor="#ffffff" style="width:100%;max-width:600px;border:1px solid #cfddd5;border-radius:20px;background-color:#ffffff;">
        <tr><td bgcolor="#087e72" style="padding:20px;border-radius:19px 19px 0 0;background-color:#087e72;color:#ffffff;">
          <p style="margin:0;font-size:28px;font-weight:700;line-height:1.4;color:#ffffff;">Save Stroke</p>
          <p style="margin:6px 0 0;font-size:18px;line-height:1.7;color:#ffffff;">แจ้งเตือนสำหรับเจ้าหน้าที่</p>
        </td></tr>
        <tr><td class="email-text" style="padding:24px 20px;color:#153e35;">
          <p style="margin:0 0 14px;"><span class="email-badge" style="display:inline-block;padding:4px 12px;border-radius:8px;background-color:#fff1ce;color:#704900;font-size:18px;font-weight:700;">รอตรวจสอบ</span></p>
          <h1 class="email-text" style="margin:0 0 12px;font-size:26px;font-weight:700;line-height:1.5;color:#153e35;">ตรวจสอบรายการใหม่</h1>
          <p class="email-text" style="margin:0 0 18px;font-size:18px;line-height:1.7;color:#153e35;">${escapeHtml(summary)}<br>จาก <strong style="font-size:20px;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(name)}</strong></p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 22px;">
            <tr><td class="email-deadline email-text" bgcolor="#eef6f0" style="padding:16px;border:1px solid #c6dbce;border-radius:12px;background-color:#eef6f0;color:#153e35;">
              <p style="margin:0 0 4px;font-size:18px;line-height:1.7;">กำหนดตรวจสอบ (เวลาไทย)</p>
              <p style="margin:0;font-size:20px;font-weight:700;line-height:1.6;">${escapeHtml(deadlineLabel)}</p>
              <p style="margin:8px 0 0;font-size:18px;line-height:1.7;">หากยังไม่ตรวจสอบ ระบบจะอนุมัติอัตโนมัติเมื่อถึงกำหนด</p>
            </td></tr>
          </table>
          <h2 class="email-text" style="margin:0 0 12px;font-size:20px;font-weight:700;line-height:1.5;color:#153e35;">เลือกการดำเนินการ</h2>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;">
            <tr>
              <td width="48%" align="center" valign="middle" bgcolor="#087e72" style="width:48%;border-radius:12px;background-color:#087e72;mso-padding-alt:16px 6px;">
                <a href="${escapeHtml(approveUrl)}" target="_blank" rel="noopener noreferrer" aria-label="เปิดรายการเพื่อยืนยันอนุมัติ" style="display:block;padding:16px 6px;border-radius:12px;background-color:#087e72;color:#ffffff;font-size:18px;font-weight:700;line-height:28px;text-align:center;text-decoration:none;">ยืนยัน</a>
              </td>
              <td width="4%" style="width:4%;font-size:0;line-height:0;">&nbsp;</td>
              <td width="48%" align="center" valign="middle" bgcolor="#b42318" style="width:48%;border-radius:12px;background-color:#b42318;mso-padding-alt:16px 6px;">
                <a href="${escapeHtml(rejectUrl)}" target="_blank" rel="noopener noreferrer" aria-label="เปิดรายการเพื่อยืนยันยกเลิก" style="display:block;padding:16px 6px;border-radius:12px;background-color:#b42318;color:#ffffff;font-size:18px;font-weight:700;line-height:28px;text-align:center;text-decoration:none;">ยกเลิก</a>
              </td>
            </tr>
          </table>
          <p class="email-muted" style="margin:16px 0 0;font-size:18px;line-height:1.7;color:#476358;">ทั้งสองปุ่มจะเปิดหน้าตรวจสอบข้อมูล กรุณาตรวจสอบและกดยืนยันอีกครั้งเพื่อดำเนินการ</p>
        </td></tr>
        <tr><td class="email-divider email-muted" style="padding:20px;border-top:1px solid #dce6df;color:#476358;">
          <p style="margin:0;font-size:18px;line-height:1.7;">ลิงก์นี้ใช้เฉพาะชุดข้อมูลในอีเมลนี้ กรุณาอย่าส่งต่อลิงก์ให้ผู้อื่น</p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
}

module.exports = { reviewNotificationEmail };
