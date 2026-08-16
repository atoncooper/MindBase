"""Aliyun SMS (dysmsapi) sender for verification codes.

Configuration (env): SMS__ENABLED / SMS__ACCESS_KEY_ID /
SMS__ACCESS_KEY_SECRET / SMS__SIGN_NAME / SMS__TEMPLATE_CODE.
The template must declare a ``${code}`` parameter.

Degradation: enabled=false or missing credentials → SmsServiceError
("短信服务未启用") — callers surface this and the frontend hides all
phone features (GET /auth/features reports sms_enabled=false), matching
the WeChat-login degradation pattern.

The sync SDK client call is wrapped in ``asyncio.to_thread`` — the tea
client's sync path is its most stable surface and the call is a short
I/O-bound round-trip.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from loguru import logger

from app.config import settings

_ENDPOINT = "dysmsapi.aliyuncs.com"

# Aliyun business error codes → user-facing messages.
_ERR_MESSAGES = {
    "isv.BUSINESS_LIMIT_CONTROL": "短信发送过于频繁，请稍后重试",
    "isv.SMS_SIGNATURE_ILLEGAL": "短信签名未通过审核",
    "isv.SMS_TEMPLATE_ILLEGAL": "短信模板未通过审核",
    "isv.AMOUNT_NOT_ENOUGH": "短信余额不足",
    "isv.PHONE_NUMBER_ILLEGAL": "手机号格式不正确",
    "isv.MOBILE_NUMBER_ILLEGAL": "手机号格式不正确",
}


class SmsServiceError(Exception):
    """Raised when SMS is disabled/unconfigured or Aliyun rejects the send."""


def _build_client():
    if not settings.sms_enabled:
        raise SmsServiceError("短信服务未启用")
    if not (
        settings.sms_access_key_id
        and settings.sms_access_key_secret
        and settings.sms_sign_name
        and settings.sms_template_code
    ):
        raise SmsServiceError("短信服务未配置")
    # Imports stay below the config gate so unconfigured deployments
    # never touch (or require) the SDK.
    from alibabacloud_dysmsapi20170525.client import Client
    from alibabacloud_tea_openapi.models import Config

    return Client(
        Config(
            access_key_id=settings.sms_access_key_id,
            access_key_secret=settings.sms_access_key_secret,
            endpoint=_ENDPOINT,
        )
    )


def _mask_phone(phone: str) -> str:
    return phone[:3] + "****" + phone[-4:] if len(phone) >= 7 else "***"


async def send_sms_code(phone: str, code: str) -> None:
    """Send a verification-code SMS. Raises SmsServiceError on failure."""
    try:
        client = _build_client()
        from alibabacloud_dysmsapi20170525.models import SendSmsRequest

        request = SendSmsRequest(
            phone_numbers=phone,
            sign_name=settings.sms_sign_name,
            template_code=settings.sms_template_code,
            template_param=json.dumps({"code": code}),
        )
    except SmsServiceError:
        raise
    except Exception as e:
        logger.error("[SMS] client init failed err={}", e)
        raise SmsServiceError("短信服务暂不可用") from e
    try:
        resp = await asyncio.to_thread(client.send_sms, request)
    except Exception as e:
        logger.error("[SMS] transport error phone={} err={}", _mask_phone(phone), e)
        raise SmsServiceError("短信发送失败，请稍后重试") from e

    body: dict[str, Any] = resp.body.to_map() if resp.body else {}
    if str(body.get("Code", "OK")) != "OK":
        biz_code = str(body.get("Code", ""))
        message = _ERR_MESSAGES.get(biz_code, "短信发送失败，请稍后重试")
        logger.warning(
            "[SMS] rejected phone={} code={} message={}",
            _mask_phone(phone), biz_code, body.get("Message"),
        )
        raise SmsServiceError(message)

    logger.info("[SMS] sent phone={}", _mask_phone(phone))
