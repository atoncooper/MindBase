package com.mindbase.pay.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * pay.* 配置绑定。配置唯一入口 application.yaml（+ docker/test profile 变体），
 * 敏感值经 ${VAR:默认} 占位符引用 .env。
 */
@ConfigurationProperties(prefix = "pay")
public record PayProperties(Rdbms rdbms, Mock mock, Order order, Alipay alipay, Test test,
                            Apptask apptask, Job job) {

    public record Rdbms(String url, String username, String password) {
    }

    public record Mock(boolean enabled) {
    }

    public record Order(int timeoutMinutes) {
    }

    /**
     * 支付宝当面付（M2）。enabled=true 时启动即校验密钥齐全，缺失直接拒绝启动。
     * 密钥命名对齐支付宝控制台，杜绝"哪把公钥"歧义（两把都以 MII 开头极易混淆）：
     * app-private-key = 应用私钥（商户密钥工具生成，签名请求）；
     * platform-public-key = 支付宝公钥（平台控制台"接口加签方式"提供，验证平台响应/回调签名
     * ——不是你自己生成的应用公钥，填错 SDK 会报"当前配置的支付宝公钥为应用公钥"）。
     * notify-url 留空 = 不依赖异步回调、以 ChannelQueryJob 查单为主（本地无公网时的现实选择）。
     */
    public record Alipay(boolean enabled, String gatewayUrl, String appId,
                         String appPrivateKey, String platformPublicKey, String notifyUrl) {
    }

    /**
     * 本机测试入口（/test/pay/*）：默认关闭；开启后仍需令牌匹配。
     * 结构性隔离：APISIX 不路由 /test/*，app-pay 端口仅回环绑定，公网不可达。
     * 生产必须 enabled=false。
     */
    public record Test(boolean enabled, String token) {
    }

    /**
     * 超时委托注册（plan/1.0.8）：下单事务提交后向 app-task 注册精确定时委托。
     * register-enabled=false 或注册失败时，兜底轮询（jittered backoff）接管，最终一致。
     */
    public record Apptask(String baseUrl, String consumerKey, boolean registerEnabled,
                          String executorBaseUrl) {
    }

    /** 兜底 job 与 executor 并发控制参数。workers 锚定 DB 连接池（Hikari 10 → 8）。 */
    public record Job(int executorWorkers, int executorQueueCapacity,
                      int timeoutBaseSeconds, int timeoutCapSeconds,
                      int deliveryBaseSeconds, int deliveryCapSeconds,
                      int queryBaseSeconds) {
    }
}
