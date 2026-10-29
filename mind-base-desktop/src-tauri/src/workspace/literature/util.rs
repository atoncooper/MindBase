//! 文本 / 年份 / DOI 归一化与 cite_key 生成工具。

/// 生成 cite_key 时跳过的虚词，避免出现 smith2020the 这类键。
const CITE_STOPWORDS: [&str; 17] = [
    "the", "a", "an", "of", "on", "in", "and", "for", "to", "with", "at", "by", "from", "into",
    "toward", "towards", "using",
];

pub(super) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

/// 去 LaTeX 花括号与常见转义，并把空白折叠成单个空格。
pub(super) fn clean_bibtex_value(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '{' | '}' => {}
            '~' => out.push(' '),
            '\\' => match chars.peek().copied() {
                // 原位转义字符直接还原。
                Some(escaped @ ('&' | '%' | '_' | '#' | '$' | '{' | '}')) => {
                    out.push(escaped);
                    chars.next();
                }
                // 其余命令（\"、\'、\emph 等）丢弃：字母命令整段吃掉，避免把
                // 命令名残留在正文里；非字母转义（变音符号）只丢转义本身。
                Some(other) => {
                    chars.next();
                    if other.is_ascii_alphabetic() {
                        while matches!(chars.peek(), Some(next) if next.is_ascii_alphabetic()) {
                            chars.next();
                        }
                    }
                }
                None => {}
            },
            _ => out.push(ch),
        }
    }
    collapse_whitespace(&out)
}

pub(super) fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 保留年份前 4 位数字（"2020"、"2020-05-01"、"2020年" 均可）。
pub(super) fn parse_year(text: &str) -> Option<i64> {
    let mut digits = String::new();
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else if !digits.is_empty() {
            break;
        }
    }
    if digits.len() < 4 {
        return None;
    }
    let year = digits[..4].parse::<i64>().ok()?;
    if (1000..=2999).contains(&year) {
        Some(year)
    } else {
        None
    }
}

pub(super) fn normalize_doi(raw: &str) -> String {
    let trimmed = raw.trim();
    let lowered = trimmed.to_ascii_lowercase();
    for prefix in [
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi:",
    ] {
        if lowered.starts_with(prefix) {
            return trimmed[prefix.len()..].trim().to_string();
        }
    }
    trimmed.to_string()
}

/// (给定名, 姓)：按最后一个空白切分；无空白视为只有姓。
pub(super) fn split_display_name(name: &str) -> (String, String) {
    let trimmed = name.trim();
    match trimmed.rfind(char::is_whitespace) {
        Some(index) => (
            trimmed[..index].trim().to_string(),
            trimmed[index..].trim().to_string(),
        ),
        None => (String::new(), trimmed.to_string()),
    }
}

pub(super) fn sanitize_cite_key(raw: &str) -> String {
    let key: String = raw
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_whitespace() || matches!(ch, ',' | '{' | '}' | '\\' | '"' | '#') {
                '_'
            } else {
                ch
            }
        })
        .collect();
    key.trim_matches('_').to_string()
}

/// 缺 cite_key 时按「姓 + 年份 + 标题首个实词」生成，例如 smith2020study。
pub(super) fn make_cite_key(authors: &[String], year: Option<i64>, title: &str) -> String {
    let family = authors
        .first()
        .map(|name| split_display_name(name).1.to_ascii_lowercase())
        .unwrap_or_default();
    let family: String = family
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    let year_part = year
        .map(|value| value.to_string())
        .unwrap_or_else(|| "nd".to_string());
    let word = title
        .split_whitespace()
        .map(|token| {
            token
                .trim_matches(|ch: char| !ch.is_alphanumeric())
                .to_ascii_lowercase()
        })
        .find(|token| token.len() >= 3 && !CITE_STOPWORDS.contains(&token.as_str()))
        .unwrap_or_default();
    let key = format!("{family}{year_part}{word}");
    if key.is_empty() {
        "ref".to_string()
    } else {
        key
    }
}

pub(super) fn url_encode(text: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if unreserved || (keep_slash && byte == b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
