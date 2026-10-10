package com.mindbase.pay.controller;

import com.mindbase.pay.config.PayProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Liveness endpoint (used by APISIX active health checks).
 *
 * <p>/health genuinely probes the database (SELECT 1): previously it always returned UP, so when the
 * DB was down the gateway still considered the upstream healthy and kept sending transaction traffic.
 * When the DB is unavailable it returns 503 and the gateway removes the upstream.
 * For detailed dependency health use /actuator/health (same source as probes/openapi).
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class HealthController {

    private final PayProperties payProperties;
    private final DataSource dataSource;

    @GetMapping("/health")
    public ResponseEntity<Map<String, String>> health() {
        Map<String, String> body = new LinkedHashMap<>();
        body.put("service", "app-pay");
        try (Connection connection = dataSource.getConnection();
             Statement statement = connection.createStatement()) {
            statement.execute("SELECT 1");
            body.put("status", "UP");
            return ResponseEntity.ok(body);
        } catch (Exception e) {
            log.error("[PAY] health_db_probe_failed err={}", e.toString());
            body.put("status", "DOWN");
            body.put("db", "unreachable");
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(body);
        }
    }

    /**
     * Root path: in test/local form redirect straight to the end-to-end test console (opening
     * localhost:8002 lands on the console); in production form (test.enabled=false) keep 404 so the
     * console's existence is not exposed.
     */
    @GetMapping("/")
    public ResponseEntity<Void> root() {
        if (!payProperties.test().enabled()) {
            return ResponseEntity.notFound().build();
        }
        // The console static page is deliberately not under the /test/pay/* prefix (it would be shadowed by PayTestController's class-level mapping and 404)
        return ResponseEntity.status(HttpStatus.FOUND)
                .location(java.net.URI.create("/pay-console.html"))
                .build();
    }
}
