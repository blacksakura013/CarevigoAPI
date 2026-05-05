const nodemailer = require("nodemailer");
const path = require("path");

const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// 🎨 HTML TEMPLATE
const getOTPTemplate = (otp) => {
  return `
  <html>
  <body style="margin:0; background:#f4f6f8; font-family:Arial;">
    
    <table width="100%" style="padding:20px;">
      <tr>
        <td align="center">
          
          <table width="500" style="background:#fff; border-radius:12px; padding:30px;">
            
            <!-- LOGO -->
            <tr>
              <td align="center" style="padding-bottom:20px;">
                <img src="cid:logo" width="120" />
              </td>
            </tr>

            <!-- TITLE -->
            <tr>
              <td align="center">
                <h2 style="color:#2e7d32;">Your OTP Code</h2>
              </td>
            </tr>

            <!-- OTP -->
            <tr>
              <td align="center">
                <div style="
                  font-size:32px;
                  font-weight:bold;
                  letter-spacing:6px;
                  background:#e8f5e9;
                  color:#2e7d32;
                  padding:15px 25px;
                  border-radius:8px;
                  display:inline-block;
                  margin:20px 0;
                ">
                  ${otp}
                </div>
              </td>
            </tr>

            <!-- TEXT -->
            <tr>
              <td align="center" style="color:#555;">
                OTP นี้ใช้ได้ 5 นาที กรุณาอย่าแชร์กับผู้อื่น
              </td>
            </tr>

          </table>

        </td>
      </tr>
    </table>

  </body>
  </html>
  `;
};

// 📩 send email
exports.sendOTPEmail = async (email, otp) => {
  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject: "Carevigo - OTP Code",
    html: getOTPTemplate(otp),

    attachments: [
      {
        filename: "logo.png",
        path: path.join(__dirname, "logo.png"),
        cid: "logo"
      }
    ]
  });
};