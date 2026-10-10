package com.mindbase.pay.service.channel;

import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.model.PayOrder;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/** Channel registry: finds an adapter by PayChannel; disabled/unimplemented channels are uniformly rejected. */
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

    /** All channel adapters are registered at startup; only currently enabled ones are returned here for the frontend to render payment methods. */
    public java.util.List<PayOrder.PayChannel> availableChannels() {
        return adapters.values().stream()
                .filter(PayChannelAdapter::enabled)
                .map(PayChannelAdapter::channel)
                .sorted()
                .toList();
    }
}
