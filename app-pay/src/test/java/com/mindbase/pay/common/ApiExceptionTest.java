package com.mindbase.pay.common;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** 工厂状态码映射、message 保留、控制流无堆栈采集。 */
class ApiExceptionTest {

    @Test
    void factoryStatusAndCodeMapping() {
        assertThat(ApiException.badRequest("A", "m").getStatus()).isEqualTo(400);
        assertThat(ApiException.unauthorized("A", "m").getStatus()).isEqualTo(401);
        assertThat(ApiException.forbidden("A", "m").getStatus()).isEqualTo(403);
        assertThat(ApiException.notFound("A", "m").getStatus()).isEqualTo(404);
        assertThat(ApiException.conflict("A", "m").getStatus()).isEqualTo(409);
        assertThat(ApiException.tooManyRequests("A", "m").getStatus()).isEqualTo(429);
        assertThat(ApiException.internalServerError("A", "m").getStatus()).isEqualTo(500);
        assertThat(ApiException.serviceUnavailable("A", "m").getStatus()).isEqualTo(503);
    }

    @Test
    void ofAllowsArbitraryStatus() {
        ApiException e = ApiException.of(418, "TEAPOT", "短连接");
        assertThat(e.getStatus()).isEqualTo(418);
        assertThat(e.getCode()).isEqualTo("TEAPOT");
        assertThat(e.getMessage()).isEqualTo("短连接");
    }

    @Test
    void controlFlowExceptionHasNoStackTrace() {
        // 控制流约定：不采集堆栈（热路径 4xx 零开销）；getStackTrace 为空数组
        ApiException e = ApiException.notFound("ORDER_NOT_FOUND", "订单不存在");
        assertThat(e.fillInStackTrace()).isSameAs(e);
        assertThat(e.getStackTrace()).isEmpty();
    }

    @Test
    void messageIsPreservedForLogging() {
        assertThat(ApiException.conflict("IDEMPOTENCY_CONFLICT", "幂等键已被其他用户占用").getMessage())
                .isEqualTo("幂等键已被其他用户占用");
    }
}
