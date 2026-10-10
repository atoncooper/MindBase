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
 * Fund audit log: a dedicated JSONL file (logback PAY_AUDIT logger -> logs/pay-audit.jsonl, retained 365 days),
 * separate from runtime logs, used for reconciliation/customer-complaint forensics/compliance audits.
 *
 * Principle: record only fund facts (who, which transaction, how much, what status), never sensitive secrets;
 * every entry carries ts + trace_id + uid (MDC) so it can be correlated with runtime logs.
 * Usage: audit("ORDER_PAID", "order_no", po, "amount_cents", 1800) -- key/value pairs passed in pairs.
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
