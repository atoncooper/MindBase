package com.mindbase.pay.common;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 资金审计：事件写入 PAY_AUDIT logger（logback 路由到 pay-audit.jsonl），
 * 每条为单行 JSON，自动携带 ts/trace_id，kv 成对序列化。
 */
class PayAuditLoggerTest {

    private final PayAuditLogger auditLogger = new PayAuditLogger();

    @AfterEach
    void tearDown() {
        org.slf4j.MDC.clear();
    }

    @Test
    void auditEventIsSingleJsonLineWithMdcContext() {
        Logger payAudit = (Logger) LoggerFactory.getLogger("PAY_AUDIT");
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        payAudit.addAppender(appender);
        try {
            org.slf4j.MDC.put(TraceIdFilter.TRACE_ID, "trace-1");
            org.slf4j.MDC.put(TraceIdFilter.UID, "10086");

            auditLogger.audit("ORDER_PAID", "order_no", "PO1",
                    "amount_cents", 1800, "channel", "ALIPAY");

            assertThat(appender.list).hasSize(1);
            ILoggingEvent event = appender.list.get(0);
            assertThat(event.getLevel()).isEqualTo(Level.INFO);
            String line = event.getFormattedMessage();
            assertThat(line)
                    .contains("\"event\":\"ORDER_PAID\"")
                    .contains("\"order_no\":\"PO1\"")
                    .contains("\"amount_cents\":1800")
                    .contains("\"channel\":\"ALIPAY\"")
                    .contains("\"trace_id\":\"trace-1\"")
                    .contains("\"uid\":\"10086\"")
                    .contains("\"ts\":\"");
            assertThat(line.lines().count()).isEqualTo(1); // 单行 JSONL
        } finally {
            payAudit.detachAppender(appender);
        }
    }

    @Test
    void auditWithoutMdcStillEmitsRecord() {
        Logger payAudit = (Logger) LoggerFactory.getLogger("PAY_AUDIT");
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        payAudit.addAppender(appender);
        try {
            auditLogger.audit("CALLBACK_REJECTED", "channel", "alipay");

            assertThat(appender.list).hasSize(1);
            String line = appender.list.get(0).getFormattedMessage();
            assertThat(line).contains("\"event\":\"CALLBACK_REJECTED\"")
                    .doesNotContain("trace_id");
        } finally {
            payAudit.detachAppender(appender);
        }
    }
}
