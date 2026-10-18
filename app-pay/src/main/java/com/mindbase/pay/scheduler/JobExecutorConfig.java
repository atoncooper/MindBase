package com.mindbase.pay.scheduler;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * 兜底 Job 的出网并行池：渠道 query 是 IO 密集（不占 DB 连接），8 并发把
 * "50 单/分钟" 的串行天花板提到数百单/分钟。
 * ⚠️ 必须独立于 JobSchedulingConfig：后者构造注入依赖本池的 Job，池放里面会形成
 * config -> job -> config(bean) 的循环依赖，上下文直接起不来（2026-10 实测）。
 */
@Configuration
public class JobExecutorConfig {

    @Bean(name = "payJobQueryExecutor")
    public ExecutorService payJobQueryExecutor() {
        ThreadPoolExecutor pool = new ThreadPoolExecutor(8, 8, 60, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(500),
                r -> {
                    Thread t = new Thread(r, "pay-job-query");
                    t.setDaemon(true);
                    return t;
                });
        pool.allowCoreThreadTimeOut(true);
        return pool;
    }
}
