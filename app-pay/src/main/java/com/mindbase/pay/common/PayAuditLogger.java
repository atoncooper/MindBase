package com.mindbase.pay.common;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Money audit log: a dedicated JSONL file (logback PAY_AUDIT logger -> logs/pay-audit.jsonl, retained 365 days),
 * separate from runtime logs, used for reconciliation/customer-complaint forensics/compliance audits.
 *
 * <p>Principle: record only fund facts (who, which transaction, how much, what status), never sensitive secrets;
 * every entry carries ts + trace_id + uid (MDC) so it can be correlated with runtime logs.
 * Usage: audit("ORDER_PAID", "order_no", po, "amount_cents", 1800) -- key/value pairs passed in pairs.
 *
 * <p><b>防篡改哈希链</b>：每条记录携带 {@code chain}/{@code prev}/{@code hash} 三个字段，
 * hash = SHA-256(prev + "|" + 不含链字段的记录体)。启动时从磁盘上最后一条记录续链（跨重启不断链），
 * 因此攻击者修改/删除历史行会破坏后续所有 hash 的可验证性。已知限制：多实例同写一个文件时链会分叉
 * （各实例交错 append），验证器需按 chain id 分组校验；单实例部署为完整链。GENESIS = 链头。
 */
@Component
public class PayAuditLogger {

    private static final Logger AUDIT = LoggerFactory.getLogger("PAY_AUDIT");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String AUDIT_FILE = "logs/pay-audit.jsonl";
    private static final String GENESIS = "GENESIS";
    /** 本进程的链 id：多实例同写文件时验证器按 chain 分组校验。 */
    private static final String CHAIN_ID = "ch-" + UUID.randomUUID().toString().substring(0, 8);

    private static final AtomicReference<String> PREV_HASH = new AtomicReference<>();
    private static boolean resumed;

    public void audit(String event, Object... kv) {
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("event", event);
        record.put("ts", Instant.now().toString());
        String traceId = MDC.get(TraceIdFilter.TRACE_ID);
        if (traceId != null) {
            record.put("trace_id", traceId);
        }
        String uid = MDC.get(TraceIdFilter.UID);
        if (uid != null) {
            record.put("uid", uid);
        }
        for (int i = 0; i + 1 < kv.length; i += 2) {
            record.put(String.valueOf(kv[i]), kv[i + 1]);
        }

        String line;
        // 链状态读-算-写必须原子，否则并发资金事件会产生同 prev 的分叉
        synchronized (PayAuditLogger.class) {
            String prev = prevHash();
            record.put("chain", CHAIN_ID);
            record.put("prev", prev);
            String hash = sha256Hex(prev + "|" + toJson(record));
            record.put("hash", hash);
            PREV_HASH.set(hash);
            line = toJson(record);
        }
        AUDIT.info(line);
    }

    private static String toJson(Map<String, Object> record) {
        try {
            return MAPPER.writeValueAsString(record);
        } catch (JsonProcessingException e) {
            return record.toString();
        }
    }

    /** 惰性续链：首条记录从磁盘最后一条取 hash；文件缺失/损坏/被清空都从 GENESIS 重开（记 WARN 由日志侧可见）。 */
    private static String prevHash() {
        if (!resumed) {
            synchronized (PayAuditLogger.class) {
                if (!resumed) {
                    PREV_HASH.set(resumeFromDisk());
                    resumed = true;
                }
            }
        }
        String prev = PREV_HASH.get();
        return prev != null ? prev : GENESIS;
    }

    /** 只读文件尾部 64KB 找最后一条非空 JSON 行（审计文件可达 GB 级，禁止全量读取）。 */
    private static String resumeFromDisk() {
        try (RandomAccessFile raf = new RandomAccessFile(AUDIT_FILE, "r")) {
            long size = raf.length();
            if (size == 0) {
                return GENESIS;
            }
            int window = (int) Math.min(64 * 1024L, size);
            raf.seek(size - window);
            byte[] buf = new byte[window];
            raf.readFully(buf);
            String tail = new String(buf, StandardCharsets.UTF_8);
            String[] lines = tail.split("\\R");
            for (int i = lines.length - 1; i >= 0; i--) {
                String candidate = lines[i].trim();
                if (candidate.isEmpty()) {
                    continue;
                }
                JsonNode node = MAPPER.readTree(candidate);
                JsonNode hash = node.get("hash");
                if (hash != null && !hash.asText().isBlank()) {
                    return hash.asText();
                }
            }
            return GENESIS;
        } catch (IOException e) {
            // 文件不存在 = 首次启动；解析失败 = 尾部被截断/外部改动 —— 都从 GENESIS 重开，告警交给日志
            LoggerFactory.getLogger(PayAuditLogger.class)
                    .warn("[PAY] audit_chain_resume_failed file={} err={}", AUDIT_FILE, e.toString());
            return GENESIS;
        }
    }

    private static String sha256Hex(String input) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] out = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(2 * out.length);
            for (byte b : out) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
