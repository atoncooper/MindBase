package com.mindbase.pay.common;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

/** QR rendering: emits a valid PNG (shared by the /pay/orders/{no}/qr endpoint and the test console). */
class QrCodesTest {

    @Test
    void rendersPngWithMagicBytes() {
        byte[] png = QrCodes.png("https://qr.alipay.com/abc", 64);

        assertThat(png).hasSizeGreaterThan(50);
        assertThat(png[0] & 0xFF).isEqualTo(0x89);
        assertThat(new String(png, 1, 3, StandardCharsets.US_ASCII)).isEqualTo("PNG");
    }
}
