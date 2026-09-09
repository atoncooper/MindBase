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
 * 数据源从 pay.rdbms 构建（而非 spring.datasource），
 * 保持 PAY__RDBMS__URL 与 app-task 的 APPTASK__RDBMS__URL 同形契约。
 *
 * <p>⚠️ DataSource 为手动构建，spring.datasource.hikari.* 这类 yaml 属性对本 bean 不生效，
 * 连接池参数必须代码化在此；TimeoutExecutionQueue 的 worker 数（pay.job.executor-workers）
 * 锚定本池大小，并在下方以启动断言强制（配置漂移宁可拒绝启动）。
 */
@Configuration
public class DataSourceConfig {

    /** 固定池大小：8 个 executor worker 之外，仍须为兜底 job / web 请求留余量。 */
    private static final int POOL_SIZE = 10;

    @Bean
    @Primary
    public DataSource dataSource(PayProperties props) {
        // 池自守断言：executor 在途 UPDATE 恒 ≤ workers，workers 超过池的安全上限 =
        // 排队挤占 web/job 连接。与 EnvSummaryRunner 同一原则：资金系统宁可起不来。
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
        // 池打满快速失败（默认 30s 会把瞬时超载放大成 HTTP 堆积），调用方本就有重试语义
        ds.setConnectionTimeout(5_000);
        // 资金服务必须有泄漏告警（纯诊断：超时未归还的连接打 WARN，不影响行为）
        ds.setLeakDetectionThreshold(30_000);
        // 远小于 MySQL wait_timeout（默认 8h），防网络设备掐断产生的半开连接
        ds.setMaxLifetime(1_800_000);
        return ds;
    }

    /** OrderService 的程序化事务模板（显式声明，不依赖自动装配的有无）。 */
    @Bean
    public TransactionTemplate transactionTemplate(PlatformTransactionManager txManager) {
        return new TransactionTemplate(txManager);
    }

    /**
     * 时钟集中注入：业务时间（订单超时/会员顺延）可测试、时区统一 Asia/Shanghai。
     */
    @Bean
    public Clock clock() {
        return Clock.system(com.mindbase.pay.common.PayTime.ZONE);
    }
}
