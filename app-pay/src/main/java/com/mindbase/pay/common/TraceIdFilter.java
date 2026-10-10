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
 * Request-level traceId: threaded through all logs from controller -> service -> Mapper -> channel adapter
 * (the logback pattern references %X{traceId}).
 * Prefers to reuse the X-Trace-Id passed in by the gateway/upstream (allowlist-validated to prevent log injection),
 * otherwise generates one;
 * the response echoes X-Trace-Id so user feedback can be matched against logs. Also emits one access log (latency/status).
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
            // MDC.clear() would also clear keys written later in the chain; this filter is the outermost, so it is safe
            response.setHeader(HEADER, traceId);
            MDC.clear();
        }
    }
}
