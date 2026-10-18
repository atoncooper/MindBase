package com.mindbase.pay.common;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** 买家信息掩码：null 透传 / 邮箱保首 2 字符 + 域名 / 手机号保前 3 后 2 / userId 保末 4。 */
class MaskingTest {

    @Test
    void nullAndBlankPassThrough() {
        assertThat(Masking.maskLogonId(null)).isNull();
        assertThat(Masking.maskLogonId("")).isEmpty();
        assertThat(Masking.maskUserId(null)).isNull();
    }

    @Test
    void emailKeepsPrefixAndDomain() {
        assertThat(Masking.maskLogonId("ab1234@gmail.com")).isEqualTo("ab***@gmail.com");
        assertThat(Masking.maskLogonId("a@x.com")).isEqualTo("a***@x.com");
    }

    @Test
    void phoneKeepsHeadAndTail() {
        assertThat(Masking.maskLogonId("13812345678")).isEqualTo("138***78");
        assertThat(Masking.maskLogonId("12345")).isEqualTo("123***45");
        assertThat(Masking.maskLogonId("1234")).isEqualTo("***");
    }

    @Test
    void userIdKeepsLastFour() {
        assertThat(Masking.maskUserId("2088123456789")).isEqualTo("***6789");
        assertThat(Masking.maskUserId("123")).isEqualTo("***");
    }
}
