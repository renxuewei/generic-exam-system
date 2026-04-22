const { Resend } = require('resend');

function getClient() {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return null;
    return new Resend(apiKey);
}

/**
 * Send account activation email
 * Falls back to console log if RESEND_API_KEY is not configured
 */
async function sendActivationEmail(toEmail, token) {
    const baseUrl = process.env.BASE_URL || 'http://localhost:8000';
    const activationUrl = `${baseUrl}/activate?token=${token}`;

    const client = getClient();

    if (!client) {
        // Fallback: log activation link to console
        console.log('');
        console.log('═══════════════════════════════════════════════');
        console.log(`  [EMAIL] 激活链接 → ${toEmail}`);
        console.log(`  ${activationUrl}`);
        console.log('═══════════════════════════════════════════════');
        console.log('');
        return { fallback: true, url: activationUrl };
    }

    try {
        await client.emails.send({
            from: process.env.EMAIL_FROM || 'noreply@yourdomain.com',
            to: toEmail,
            subject: '请激活您的题库系统账户',
            html: `
                <div style="max-width:480px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:40px 20px">
                    <h2 style="color:#4361ee;margin-bottom:24px">题库系统 — 账户激活</h2>
                    <p style="color:#555;font-size:16px;line-height:1.6">您好！请点击下方按钮激活您的账户：</p>
                    <div style="text-align:center;margin:32px 0">
                        <a href="${activationUrl}" style="display:inline-block;padding:14px 32px;background:#4361ee;color:#fff;border-radius:10px;text-decoration:none;font-size:16px;font-weight:600">
                            激活账户
                        </a>
                    </div>
                    <p style="color:#999;font-size:13px">如果按钮无法点击，请复制以下链接到浏览器：</p>
                    <p style="color:#4361ee;font-size:13px;word-break:break-all">${activationUrl}</p>
                    <p style="color:#999;font-size:13px;margin-top:24px">此链接 24 小时内有效。</p>
                </div>
            `
        });
        return { success: true };
    } catch (err) {
        console.error('Failed to send activation email:', err.message);
        // Still log the link as fallback
        console.log(`  [FALLBACK] 激活链接: ${activationUrl}`);
        return { fallback: true, url: activationUrl, error: err.message };
    }
}

/**
 * Send password reset email
 * Falls back to console log if RESEND_API_KEY is not configured
 */
async function sendResetPasswordEmail(toEmail, token) {
    const baseUrl = process.env.BASE_URL || 'http://localhost:8000';
    const resetUrl = `${baseUrl}/reset-password?token=${token}`;

    const client = getClient();

    if (!client) {
        console.log('');
        console.log('═══════════════════════════════════════════════');
        console.log(`  [EMAIL] 密码重置链接 → ${toEmail}`);
        console.log(`  ${resetUrl}`);
        console.log('═══════════════════════════════════════════════');
        console.log('');
        return { fallback: true, url: resetUrl };
    }

    try {
        await client.emails.send({
            from: process.env.EMAIL_FROM || 'noreply@yourdomain.com',
            to: toEmail,
            subject: '题库系统 — 密码重置',
            html: `
                <div style="max-width:480px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:40px 20px">
                    <h2 style="color:#4361ee;margin-bottom:24px">题库系统 — 密码重置</h2>
                    <p style="color:#555;font-size:16px;line-height:1.6">您好！请点击下方按钮重置您的密码：</p>
                    <div style="text-align:center;margin:32px 0">
                        <a href="${resetUrl}" style="display:inline-block;padding:14px 32px;background:#4361ee;color:#fff;border-radius:10px;text-decoration:none;font-size:16px;font-weight:600">
                            重置密码
                        </a>
                    </div>
                    <p style="color:#999;font-size:13px">如果按钮无法点击，请复制以下链接到浏览器：</p>
                    <p style="color:#4361ee;font-size:13px;word-break:break-all">${resetUrl}</p>
                    <p style="color:#999;font-size:13px;margin-top:24px">此链接 30 分钟内有效。如果这不是您本人的操作，请忽略此邮件。</p>
                </div>
            `
        });
        return { success: true };
    } catch (err) {
        console.error('Failed to send reset email:', err.message);
        console.log(`  [FALLBACK] 密码重置链接: ${resetUrl}`);
        return { fallback: true, url: resetUrl, error: err.message };
    }
}

module.exports = { sendActivationEmail, sendResetPasswordEmail };
