"""Email service — sends verification codes and password-reset links via Resend.

Resend docs: https://resend.com/docs/api-reference/emails/send-emails
Free tier: 100 emails/day, 3000/month. For quick testing without domain
verification, use the shared address "onboarding@resend.dev" as the From.

This module is the only place that knows about Resend. Swap to another
provider (SMTP, Aliyun DirectMail, etc.) by replacing this file.
"""
from __future__ import annotations

import httpx
from loguru import logger

from app.config import settings


RESEND_API_URL = "https://api.resend.com/emails"


class EmailServiceError(Exception):
    """Raised when the email provider rejects the request."""


async def send_verification_code(
    to_email: str, code: str, purpose: str
) -> None:
    """Send a 6-digit verification code to the given email.

    Args:
        to_email: Recipient address.
        code: The 6-digit code (or reset token for purpose=reset_password).
        purpose: One of: bind_email | reset_password | twofa.
    """
    if not settings.email_enabled:
        logger.warning(
            "[EMAIL] disabled (email.enabled=false); skipping send to=%s",
            to_email,
        )
        return

    api_key = settings.email_api_key
    if not api_key:
        raise EmailServiceError("邮件服务未配置 API Key")

    subject, body = _render_template(code, purpose)

    payload = {
        "from": settings.email_from,
        "to": [to_email],
        "subject": subject,
        "html": body,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(RESEND_API_URL, json=payload, headers=headers)
    except httpx.HTTPError as e:
        logger.error("[EMAIL] transport error to=%s err=%s", to_email, e)
        raise EmailServiceError("邮件发送失败，请稍后重试") from e

    if resp.status_code >= 400:
        logger.error(
            "[EMAIL] resend rejected status=%s body=%s",
            resp.status_code,
            resp.text,
        )
        # Don't leak Resend error body to user; surface a safe message.
        raise EmailServiceError("邮件发送失败，请稍后重试")

    logger.info("[EMAIL] sent to=%s purpose=%s", to_email, purpose)


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------

_PURPOSE_LABEL = {
    "bind_email": "绑定邮箱",
    "reset_password": "重置密码",
    "twofa": "二次验证",
}


def _render_template(code: str, purpose: str) -> tuple[str, str]:
    """Return (subject, html_body) for the given purpose."""
    label = _PURPOSE_LABEL.get(purpose, "验证")
    subject = f"【MindBase】您的{label}验证码"

    if purpose == "reset_password":
        # `code` is actually a reset token; render a link.
        link = f"{settings.email_frontend_url}/reset-password?token={code}"
        body = f"""
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                    max-width:480px;margin:0 auto;padding:24px;color:#202124;">
          <h2 style="margin:0 0 16px 0;">重置您的 MindBase 密码</h2>
          <p style="margin:0 0 12px 0;">点击下方按钮设置新密码，链接 10 分钟内有效：</p>
          <p style="margin:24px 0;">
            <a href="{link}"
               style="display:inline-block;padding:12px 24px;
                      background:#1a73e8;color:#fff;text-decoration:none;
                      border-radius:6px;font-weight:500;">
              重置密码
            </a>
          </p>
          <p style="margin:0 0 8px 0;color:#5f6368;font-size:13px;">
            如果按钮无法点击，请直接访问以下链接：
          </p>
          <p style="margin:0 0 24px 0;word-break:break-all;color:#1a73e8;font-size:13px;">
            {link}
          </p>
          <p style="margin:0;color:#5f6368;font-size:13px;">
            如果这不是您本人的操作，请忽略此邮件。
          </p>
        </div>
        """
        return subject, body

    # Numeric verification code for bind_email / twofa
    body = f"""
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                max-width:480px;margin:0 auto;padding:24px;color:#202124;">
      <h2 style="margin:0 0 16px 0;">MindBase {label}</h2>
      <p style="margin:0 0 12px 0;">您正在进行{label}操作，验证码为：</p>
      <p style="margin:24px 0;font-size:32px;font-weight:600;
                letter-spacing:8px;color:#1a73e8;text-align:center;">
        {code}
      </p>
      <p style="margin:0 0 24px 0;color:#5f6368;font-size:13px;">
        验证码 5 分钟内有效。如非本人操作，请忽略此邮件。
      </p>
    </div>
    """
    return subject, body
