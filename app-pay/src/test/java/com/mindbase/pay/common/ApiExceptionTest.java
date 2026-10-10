package com.mindbase.pay.common;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Factory status-code mapping, message preservation, and no stack-trace capture for control flow. */
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
        ApiException e = ApiException.of(418, "TEAPOT", "short connection");
        assertThat(e.getStatus()).isEqualTo(418);
        assertThat(e.getCode()).isEqualTo("TEAPOT");
        assertThat(e.getMessage()).isEqualTo("short connection");
    }

    @Test
    void controlFlowExceptionHasNoStackTrace() {
        // Control-flow contract: no stack capture (zero overhead for hot-path 4xx); getStackTrace is an empty array
        ApiException e = ApiException.notFound("ORDER_NOT_FOUND", "order not found");
        assertThat(e.fillInStackTrace()).isSameAs(e);
        assertThat(e.getStackTrace()).isEmpty();
    }

    @Test
    void messageIsPreservedForLogging() {
        assertThat(ApiException.conflict("IDEMPOTENCY_CONFLICT", "idempotency key already held by another user").getMessage())
                .isEqualTo("idempotency key already held by another user");
    }
}
