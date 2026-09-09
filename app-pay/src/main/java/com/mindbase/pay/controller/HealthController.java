package com.mindbase.pay.controller;

import com.mindbase.pay.config.PayProperties;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 根路径：测试/本地形态直接重定向到端到端测试控制台（localhost:8002 一打开即控制台）；
 * 生产形态（test.enabled=false）保持 404，不暴露控制台的存在。
 */
@RestController
@RequiredArgsConstructor
public class HealthController {

    private final PayProperties payProperties;

    @GetMapping("/health")
    public java.util.Map<String, String> health() {
        return java.util.Map.of("status", "UP", "service", "app-pay");
    }

    @GetMapping("/")
    public ResponseEntity<Void> root() {
        if (!payProperties.test().enabled()) {
            return ResponseEntity.notFound().build();
        }
        // 控制台静态页刻意不在 /test/pay/* 前缀下（会被 PayTestController 的类级映射遮蔽致 404）
        return ResponseEntity.status(HttpStatus.FOUND)
                .location(java.net.URI.create("/pay-console.html"))
                .build();
    }
}
