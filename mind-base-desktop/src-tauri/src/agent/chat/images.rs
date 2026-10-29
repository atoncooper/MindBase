//! User-attached image (data URL) validation: MIME, base64, size caps.

use base64::Engine as _;

// ---------------------------------------------------------------------------
// 用户主动附带的图片（data URL）校验
// ---------------------------------------------------------------------------

/// 一轮最多附带的图片数量。
const MAX_USER_IMAGES: usize = 4;
/// 单张图片解码后的上限（5MB）。
const MAX_USER_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// 一轮所有图片解码后的合计上限（15MB）。
const MAX_USER_IMAGES_TOTAL_BYTES: u64 = 15 * 1024 * 1024;
/// 允许的 data URL 前缀（MIME 大小写不敏感）。jpeg / jpg 都接受——webview
/// 的 FileReader 对 .jpg 可能产出 image/jpeg，也可能保留 image/jpg。
const USER_IMAGE_PREFIXES: [&str; 5] = [
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
    "data:image/jpg;base64,",
    "data:image/webp;base64,",
    "data:image/gif;base64,",
];

/// 取出 data URL 里 `base64,` 之后的原始 base64 段。
fn image_data_url_payload(image: &str) -> Result<&str, String> {
    for prefix in USER_IMAGE_PREFIXES {
        if image
            .get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        {
            return Ok(&image[prefix.len()..]);
        }
    }
    Err(
        "格式不支持：必须是以 data:image/(png|jpeg|jpg|webp|gif);base64, 开头的 data URL"
            .to_string(),
    )
}

/// base64 段的解码字节数：先做字符集 / 长度 / 填充校验，再按 3/4 估算。
/// 估算超过单张上限时直接返回估算值，**不真正解码**——否则一张几十 MB 的
/// 图片会在参数校验阶段就把内存打满（前端拦不住恶意调用方）。
fn image_base64_decoded_bytes(payload: &str) -> Result<u64, String> {
    let bytes = payload.as_bytes();
    if bytes.is_empty() {
        return Err("的内容为空：base64 数据缺失".to_string());
    }
    if bytes.len() % 4 != 0 {
        return Err("的 base64 数据非法：长度必须是 4 的倍数".to_string());
    }
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    if padding > 2 {
        return Err("的 base64 数据非法：填充符 '=' 过多".to_string());
    }
    let data = &bytes[..bytes.len() - padding];
    if data
        .iter()
        .any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/')))
    {
        return Err("的 base64 数据非法：包含非 base64 字符".to_string());
    }
    let estimated = (bytes.len() as u64 / 4) * 3 - padding as u64;
    if estimated > MAX_USER_IMAGE_BYTES {
        return Ok(estimated);
    }
    // 估算在上限内才真正解码：既精确校验尾部填充位，也拿到准确字节数。
    base64::engine::general_purpose::STANDARD
        .decode(payload.as_bytes())
        .map(|decoded| decoded.len() as u64)
        .map_err(|_| "的 base64 数据非法：无法解码".to_string())
}

fn bytes_to_mb(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

/// 校验用户主动附带的图片（data URL）：数量、MIME 前缀、base64 合法性与
/// 解码体积（单张 ≤5MB、合计 ≤15MB）。返回去首尾空白后的 data URL 列表；
/// 任何一项不合法都返回中文错误（指明第几张、为什么）。
pub(crate) fn validate_user_images(images: &[String]) -> Result<Vec<String>, String> {
    if images.len() > MAX_USER_IMAGES {
        return Err(format!(
            "最多只能附带 {MAX_USER_IMAGES} 张图片（当前 {} 张），请减少后再发送",
            images.len()
        ));
    }
    let mut validated = Vec::with_capacity(images.len());
    let mut total_bytes: u64 = 0;
    for (index, raw) in images.iter().enumerate() {
        let position = index + 1;
        let image = raw.trim();
        let payload = image_data_url_payload(image)
            .map_err(|reason| format!("第 {position} 张图片{reason}"))?;
        let decoded_bytes = image_base64_decoded_bytes(payload)
            .map_err(|reason| format!("第 {position} 张图片{reason}"))?;
        if decoded_bytes > MAX_USER_IMAGE_BYTES {
            return Err(format!(
                "第 {position} 张图片过大（约 {:.1}MB），单张不能超过 5MB",
                bytes_to_mb(decoded_bytes)
            ));
        }
        total_bytes += decoded_bytes;
        if total_bytes > MAX_USER_IMAGES_TOTAL_BYTES {
            return Err(format!(
                "图片总大小超过 15MB（当前约 {:.1}MB），请减少数量或压缩后再发送",
                bytes_to_mb(total_bytes)
            ));
        }
        validated.push(image.to_string());
    }
    Ok(validated)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- validate_user_images ------------------------------------------------

    fn image_data_url(mime: &str, bytes: &[u8]) -> String {
        format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    #[test]
    fn validate_user_images_accepts_one_legal_image() {
        let raw = image_data_url("image/png", b"not-really-a-png-but-bytes");
        assert_eq!(
            validate_user_images(std::slice::from_ref(&raw)).unwrap(),
            vec![raw.clone()]
        );
        // 首尾空白（前端多行拼接可能带换行）在返回前被裁掉。
        let padded = format!("  {raw}\n");
        assert_eq!(validate_user_images(&[padded]).unwrap(), vec![raw]);
        // jpg / webp / gif 前缀同样接受，MIME 大小写不敏感。
        for mime in ["image/jpeg", "image/jpg", "image/webp", "image/gif"] {
            let url = image_data_url(mime, b"x");
            assert!(validate_user_images(&[url]).is_ok(), "{mime}");
        }
        assert!(validate_user_images(&[]).unwrap().is_empty());
    }

    #[test]
    fn validate_user_images_rejects_more_than_four() {
        let images: Vec<String> = (0..5)
            .map(|index| image_data_url("image/png", &[index as u8]))
            .collect();
        let error = validate_user_images(&images).unwrap_err();
        assert!(error.contains("最多只能附带 4 张图片"), "{error}");
        assert!(error.contains("当前 5 张"), "{error}");
    }

    #[test]
    fn validate_user_images_rejects_wrong_prefix() {
        let images = vec![
            "data:text/plain;base64,aGVsbG8=".to_string(),
            "https://example.com/a.png".to_string(),
            "data:image/svg+xml;base64,PHN2Zz4=".to_string(),
        ];
        for image in images {
            let error = validate_user_images(&[image]).unwrap_err();
            assert!(error.contains("第 1 张图片格式不支持"), "{error}");
        }
    }

    #[test]
    fn validate_user_images_rejects_empty_base64() {
        for image in [
            "data:image/png;base64,".to_string(),
            "data:image/png;base64,   ".to_string(),
        ] {
            let error = validate_user_images(&[image]).unwrap_err();
            assert!(error.contains("第 1 张图片的内容为空"), "{error}");
        }
    }

    #[test]
    fn validate_user_images_rejects_oversized_single_image() {
        // 约 5.5MB 的纯 base64 文本 → 估算解码 >5MB。校验走 capped 分支，
        // 绝不解码（否则测试自身就要为一张超大图分配内存）。
        let payload = "A".repeat(7 * 1024 * 1024);
        let image = format!("data:image/png;base64,{payload}");
        let error = validate_user_images(&[image]).unwrap_err();
        assert!(error.contains("第 1 张图片过大"), "{error}");
        assert!(error.contains("单张不能超过 5MB"), "{error}");
    }

    #[test]
    fn validate_user_images_rejects_illegal_base64() {
        for payload in ["!!!!", "abcde", "ab=c", "A==="] {
            let image = format!("data:image/png;base64,{payload}");
            let error = validate_user_images(&[image]).unwrap_err();
            assert!(
                error.contains("第 1 张图片") && error.contains("base64 数据非法"),
                "payload={payload}: {error}"
            );
        }
    }

    #[test]
    fn validate_user_images_rejects_total_over_limit() {
        // 4 张各 4MB（解码后）= 16MB > 合计 15MB；单张都在 5MB 以内。
        let payload = "A".repeat(4 * 1024 * 1024 / 3 * 4 + 4);
        let image = format!("data:image/jpeg;base64,{payload}");
        let images = vec![image; 4];
        let error = validate_user_images(&images).unwrap_err();
        assert!(error.contains("图片总大小超过 15MB"), "{error}");
    }
}
