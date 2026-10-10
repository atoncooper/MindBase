package com.mindbase.pay.config;

import com.zaxxer.hikari.HikariDataSource;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.time.Clock;

/**
 * The data source is built from pay.rdbms (rather than spring.datasource),
 * keeping the PAY__RDBMS__URL contract identical in shape to app-task's APPTASK__RDBMS__URL.
 *
 * <p>⚠️ The DataSource is built manually, so yaml properties like spring.datasource.hikari.* have no
 * effect on this bean; connection pool parameters must be coded here; TimeoutExecutionQueue's worker count
 * (pay.job.executor-workers) is anchored to this pool size and enforced below with a startup assertion
 * (configuration drift is better refused at startup).
 */
@Configuration
public class DataSourceConfig {

    /** Fixed pool size: beyond the 8 executor workers, headroom must remain for fallback jobs / web requests. */
    private static final int POOL_SIZE = 10;

    @Bean
    @Primary
    public DataSource dataSource(PayProperties props) {
        // Pool self-guard assertion: in-flight executor UPDATEs are always <= workers; workers exceeding the pool's safe
        // limit means queuing crowds out web/job connections. Same principle as EnvSummaryRunner: a fund system should fail to start rather than run unsafe.
        int workers = props.job().executorWorkers();
        if (workers > POOL_SIZE - 2) {
            throw new IllegalStateException(("[PAY] unsafe_config: pay.job.executor-workers=%d "
                    + "exceeds the safe limit of connection pool %d (must be <= %d)")
                    .formatted(workers, POOL_SIZE, POOL_SIZE - 2));
        }

        PayProperties.Rdbms rdbms = props.rdbms();
        HikariDataSource ds = DataSourceBuilder.create()
                .type(HikariDataSource.class)
                .url(rdbms.url())
                .username(rdbms.username())
                .password(rdbms.password())
                .build();
        ds.setPoolName("pay-hikari");
        ds.setMaximumPoolSize(POOL_SIZE);
        ds.setMinimumIdle(POOL_SIZE);
        // Fail fast when the pool is saturated (the default 30s turns transient overload into HTTP pile-up); callers already have retry semantics
        ds.setConnectionTimeout(5_000);
        // A fund service must have leak warnings (diagnostic only: connections not returned within the timeout log WARN, without affecting behavior)
        ds.setLeakDetectionThreshold(30_000);
        // Far below MySQL wait_timeout (default 8h), preventing half-open connections caused by network devices dropping them
        ds.setMaxLifetime(1_800_000);
        return ds;
    }

    /** Programmatic transaction template for OrderService (explicitly declared, not relying on autoconfiguration). */
    @Bean
    public TransactionTemplate transactionTemplate(PlatformTransactionManager txManager) {
        return new TransactionTemplate(txManager);
    }

    /**
     * Centralized clock injection: business time (order timeout/membership extension) is testable and the time zone is uniformly Asia/Shanghai.
     */
    @Bean
    public Clock clock() {
        return Clock.system(com.mindbase.pay.common.PayTime.ZONE);
    }
}
