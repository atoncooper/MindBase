package com.mindbase.pay.common;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 资金审计日志：独立 JSONL 文件（logback PAY_AUDIT logger → logs/pay-audit.jsonl，保留 365 天），
 * 与运行日志分离，专供对账/客诉取证/合规审计。
 *
 * 原则：只记资金事实（谁、哪笔、多少钱、什么状态），不记敏感密钥；
 * 每条自带 ts + trace_id + uid（MDC），可与运行日志互相关联。
 * 用法：audit("ORDER_PAID", "order_no", po, "amount_cents", 1800)——kv 成对传入。
 */
@Component
public class PayAuditLogger {

    private static final Logger AUDIT = LoggerFactory.getLogger("PAY_AUDIT");
    private static final ObjectMapper MAPPER = new ObjectMapper();

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
        try {
            AUDIT.info(MAPPER.writeValueAsString(record));
        } catch (JsonProcessingException e) {
            AUDIT.info(record.toString());
        }
    }
}
