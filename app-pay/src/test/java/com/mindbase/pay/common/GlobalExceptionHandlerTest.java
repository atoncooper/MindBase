package com.mindbase.pay.common;

import org.junit.jupiter.api.Test;
import org.springframework.core.MethodParameter;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.mock.http.MockHttpInputMessage;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.lang.reflect.Method;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 框架异常显式分类：乱码请求体/缺参数/类型不匹配 → 400，
 * 方法不支持 → 405，未知路径 → 404——都不许落进 500 兜底污染监控。
 */
class GlobalExceptionHandlerTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    @Test
    void malformedBodyIs400Not500() {
        ResponseEntity<Map<String, String>> response = handler.handleNotReadable(
                new HttpMessageNotReadableException("bad json", new MockHttpInputMessage(new byte[0])));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).containsEntry("code", "MALFORMED_BODY");
    }

    @Test
    void missingParamIs400() {
        ResponseEntity<Map<String, String>> response = handler.handleMissingParam(
                new MissingServletRequestParameterException("uid", "long"));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).containsEntry("code", "MISSING_PARAM");
        assertThat(response.getBody()).containsEntry("message", "Missing required parameter: uid");
    }

    @Test
    void typeMismatchIs400() throws Exception {
        MethodParameter mp = new MethodParameter(
                Dummy.class.getDeclaredMethod("take", Long.class), 0);
        ResponseEntity<Map<String, String>> response = handler.handleTypeMismatch(
                new MethodArgumentTypeMismatchException("abc", Long.class, "uid", mp,
                        new NumberFormatException()));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).containsEntry("code", "TYPE_MISMATCH");
    }

    @Test
    void methodNotSupportedIs405() {
        ResponseEntity<Map<String, String>> response = handler.handleMethodNotSupported(
                new HttpRequestMethodNotSupportedException("DELETE"));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.METHOD_NOT_ALLOWED);
    }

    @Test
    void unknownResourceIs404Not500() {
        ResponseEntity<Map<String, String>> response = handler.handleNoResource(
                new NoResourceFoundException(HttpMethod.GET, "/no/such/path"));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(response.getBody()).containsEntry("code", "NOT_FOUND");
    }

    static class Dummy {
        @SuppressWarnings("unused")
        void take(Long value) {
        }
    }
}
