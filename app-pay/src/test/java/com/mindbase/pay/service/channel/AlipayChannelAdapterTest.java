package com.mindbase.pay.service.channel;

import com.alipay.api.internal.util.AlipaySignature;
import com.mindbase.pay.config.PayProperties;
import org.junit.jupiter.api.Test;
import org.mockito.MockedStatic;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mockStatic;

/** 支付宝适配器：启动配置校验、金额换算、异步通知验签分支（静态验签 mock，不连网）。 */
class AlipayChannelAdapterTest {

    private static final String APP_ID = "test-app";

    private static PayProperties props(boolean enabled, String privateKey) {
        return new PayProperties(null, null, null,
                new PayProperties.Alipay(enabled,
                        "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
                        APP_ID, privateKey, "alipay-public-key", ""),
                null, null, null);
    }

    @Test
    void initFailsFastWhenKeysMissing() {
        AlipayChannelAdapter adapter = new AlipayChannelAdapter(props(true, ""));
        assertThatThrownBy(adapter::init)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("missing key config");
    }

    @Test
    void disabledAdapterSkipsInitAndStaysDisabled() {
        AlipayChannelAdapter adapter = new AlipayChannelAdapter(props(false, ""));
        adapter.init();
        assertThat(adapter.enabled()).isFalse();
    }

    @Test
    void verifyNotifyAcceptsSignedSuccess() {
        AlipayChannelAdapter adapter = new AlipayChannelAdapter(props(true, "private-key"));
        adapter.init();
        try (MockedStatic<AlipaySignature> sign = mockStatic(AlipaySignature.class)) {
            sign.when(() -> AlipaySignature.rsaCheckV1(anyMap(), anyString(), anyString(), anyString()))
                    .thenReturn(true);

            var result = adapter.verifyNotify(Map.of(
                    "app_id", APP_ID,
                    "out_trade_no", "PO1",
                    "trade_no", "ALI1",
                    "trade_status", "TRADE_SUCCESS",
                    "total_amount", "18.00"));

            assertThat(result.status()).isEqualTo(AlipayChannelAdapter.AlipayNotifyResult.Status.PAID);
            assertThat(result.orderNo()).isEqualTo("PO1");
            assertThat(result.tradeNo()).isEqualTo("ALI1");
            assertThat(result.paidAmountCents()).isEqualTo(1800L);
        }
    }

    @Test
    void verifyNotifyRejectsBadSignature() {
        AlipayChannelAdapter adapter = new AlipayChannelAdapter(props(true, "private-key"));
        adapter.init();
        try (MockedStatic<AlipaySignature> sign = mockStatic(AlipaySignature.class)) {
            sign.when(() -> AlipaySignature.rsaCheckV1(anyMap(), anyString(), anyString(), anyString()))
                    .thenReturn(false);

            var result = adapter.verifyNotify(Map.of(
                    "app_id", APP_ID, "out_trade_no", "PO1",
                    "trade_status", "TRADE_SUCCESS", "total_amount", "18.00"));

            assertThat(result.status()).isEqualTo(AlipayChannelAdapter.AlipayNotifyResult.Status.INVALID);
        }
    }

    @Test
    void verifyNotifyRejectsForeignAppId() {
        AlipayChannelAdapter adapter = new AlipayChannelAdapter(props(true, "private-key"));
        adapter.init();
        try (MockedStatic<AlipaySignature> sign = mockStatic(AlipaySignature.class)) {
            sign.when(() -> AlipaySignature.rsaCheckV1(anyMap(), anyString(), anyString(), anyString()))
                    .thenReturn(true);

            var result = adapter.verifyNotify(Map.of(
                    "app_id", "another-app", "out_trade_no", "PO1",
                    "trade_status", "TRADE_SUCCESS", "total_amount", "18.00"));

            assertThat(result.status()).isEqualTo(AlipayChannelAdapter.AlipayNotifyResult.Status.INVALID);
        }
    }

    @Test
    void amountConversionBetweenCentsAndYuan() {
        assertThat(AlipayChannelAdapter.toYuan(1800L)).isEqualTo("18.00");
        assertThat(AlipayChannelAdapter.toYuan(15800L)).isEqualTo("158.00");
        assertThat(AlipayChannelAdapter.toCents("18.00")).isEqualTo(1800L);
        assertThat(AlipayChannelAdapter.toCents("158.0")).isEqualTo(15800L);
        assertThat(AlipayChannelAdapter.toCents("not-a-number")).isNull();
    }
}
