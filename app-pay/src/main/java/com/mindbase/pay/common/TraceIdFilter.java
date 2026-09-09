package com.mindbase.pay.common;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * 请求级 traceId：贯穿 控制器→服务→Mapper→渠道适配器 的所有日志（logback pattern 引 %X{traceId}）。
 * 优先复用网关/上游传入的 X-Trace-Id（白名单校验防日志注入），否则生成；
 * 响应回写 X-Trace-Id 便于把用户反馈与日志对上。同时输出一条访问日志（耗时/状态码）。
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TraceIdFilter extends OncePerRequestFilter {

    public static final String TRACE_ID = "traceId";
    public static final String UID = "uid";
    private static final String HEADER = "X-Trace-Id";
    private static final Pattern SAFE = Pattern.compile("[A-Za-z0-9._-]{1,32}");
    private static final Logger log = LoggerFactory.getLogger(TraceIdFilter.class);

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String incoming = request.getHeader(HEADER);
        String traceId = incoming != null && SAFE.matcher(incoming).matches()
                ? incoming : UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        MDC.put(TRACE_ID, traceId);
        long start = System.currentTimeMillis();
        try {
            chain.doFilter(request, response);
            if (!"/health".equals(request.getRequestURI())) {
                log.info("[PAY] access method={} path={} status={} cost_ms={}",
                        request.getMethod(), request.getRequestURI(),
                        response.getStatus(), System.currentTimeMillis() - start);
            }
        } finally {
            // MDC.clear() 会连带清掉链内后续写入的键，过滤器是最外层，安全
            response.setHeader(HEADER, traceId);
            MDC.clear();
        }
    }
}
