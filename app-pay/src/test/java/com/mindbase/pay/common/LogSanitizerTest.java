package com.mindbase.pay.common;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** 外部输入进日志前必须去控制字符并截断，防日志行伪造/日志炸弹。 */
class LogSanitizerTest {

    @Test
    void nullBecomesDash() {
        assertThat(LogSanitizer.safe(null)).isEqualTo("-");
        assertThat(LogSanitizer.safe(null, 8)).isEqualTo("-");
    }

    @Test
    void controlCharactersAreNeutralized() {
        assertThat(LogSanitizer.safe("a\r\nb\tc")).isEqualTo("a__b_c");
        assertThat(LogSanitizer.safe("\u0000")).isEqualTo("_");
    }

    @Test
    void longValuesAreTruncated() {
        assertThat(LogSanitizer.safe("x".repeat(200), 10)).hasSize(10).isEqualTo("xxxxxxxxxx");
    }

    @Test
    void normalValuesPassThrough() {
        assertThat(LogSanitizer.safe("PO-12345")).isEqualTo("PO-12345");
        assertThat(LogSanitizer.safe("")).isEqualTo("-");
    }
}
