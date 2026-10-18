package com.mindbase.pay.common;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Money audit: events are written to the PAY_AUDIT logger (logback routes them to pay-audit.jsonl),
 * each entry is a single-line JSON record that automatically carries ts/trace_id, with kv pairs serialized.
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
            assertThat(line.lines().count()).isEqualTo(1); // single-line JSONL
        } finally {
            payAudit.detachAppender(appender);
        }
    }

    @Test
    void auditRecordsFormAHashChain() {
        // 第二行的 prev 必须等于第一行的 hash，且 hash != prev（链在推进）
        Logger payAudit = (Logger) LoggerFactory.getLogger("PAY_AUDIT");
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        payAudit.addAppender(appender);
        ObjectMapper mapper = new ObjectMapper();
        try {
            auditLogger.audit("TEST_CHAIN_A", "order_no", "PO1");
            auditLogger.audit("TEST_CHAIN_B", "order_no", "PO2");

            assertThat(appender.list.size()).isGreaterThanOrEqualTo(2);
            JsonNode first = mapper.readTree(appender.list.get(appender.list.size() - 2).getFormattedMessage());
            JsonNode second = mapper.readTree(appender.list.get(appender.list.size() - 1).getFormattedMessage());

            assertThat(first.get("hash").asText()).isNotBlank();
            assertThat(first.get("chain").asText()).isEqualTo(second.get("chain").asText());
            assertThat(second.get("prev").asText()).isEqualTo(first.get("hash").asText());
            assertThat(second.get("hash").asText()).isNotEqualTo(second.get("prev").asText());
        } catch (Exception e) {
            throw new IllegalStateException(e);
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