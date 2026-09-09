package com.mindbase.pay.service.channel;

import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.model.PayOrder;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/** 渠道注册表：按 PayChannel 找适配器；未启用/未实现的渠道统一拒绝。 */
@Component
public class PayChannelRouter {

    private final Map<PayOrder.PayChannel, PayChannelAdapter> adapters;

    public PayChannelRouter(List<PayChannelAdapter> adapterList) {
        this.adapters = adapterList.stream()
                .collect(Collectors.toUnmodifiableMap(PayChannelAdapter::channel, Function.identity()));
    }

    public PayChannelAdapter requireAdapter(PayOrder.PayChannel channel) {
        PayChannelAdapter adapter = adapters.get(channel);
        if (adapter == null || !adapter.enabled()) {
            throw ApiException.badRequest("CHANNEL_NOT_SUPPORTED", "Payment channel not supported yet");
        }
        return adapter;
    }
}
