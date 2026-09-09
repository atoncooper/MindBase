package com.mindbase.pay.config;

import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.MutablePropertySources;
import org.springframework.core.env.StandardEnvironment;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.stream.Stream;

/**
 * 本地直启（IDE / java 命令）时加载项目根 .env 到 Spring Environment。
 *
 * <p>背景：yaml 中的 ${ALIPAY_*}/${PAY_MYSQL_*}/${PAY_TEST_TOKEN} 占位符，在容器形态
 * 由 compose env_file 注入为真实环境变量；本地形态此前无来源，全部回落 yaml 默认值
 * ——.env 配了也不生效（典型症状：ALIPAY_ENABLED=true 但本地实例报"支付渠道暂未开放"）。
 *
 * <p>优先级：真实环境变量 > .env > yaml 默认值。实现为把 .env 源插在 systemEnvironment
 * 之后——容器内 env_file 注入的变量与 shell 显式导出的变量恒胜出，行为与容器形态一致。
 *
 * <p>Docker 容器镜像内无 .env 文件 → 自动跳过（找不到文件是常态而非错误）；
 * 读失败仅告警不阻断启动，占位符回落 yaml 默认值。
 * 安全：只记路径与条目数，绝不打印值（.env 含支付密钥）。
 */
@Slf4j
public class PayDotenvEnvironmentPostProcessor implements EnvironmentPostProcessor, Ordered {

    /** 属性源名称（排障/测试用）。 */
    public static final String SOURCE_NAME = "payDotenv";

    /** 自工作目录向上回溯的层数上限：.env 在项目根（IDE 默认工作目录是模块目录 app-pay 的上级），防止误抓更上层目录的同名文件。 */
    private static final int MAX_PARENT_LEVELS = 3;

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        postProcessEnvironment(environment, Path.of(""));
    }

    /** 测试入口：显式指定起始目录（Windows 下 Path.of("") 的默认目录在 FileSystem 创建时固化，测试改 user.dir 无效）。 */
    void postProcessEnvironment(ConfigurableEnvironment environment, Path startDir) {
        if (environment.getPropertySources().contains(SOURCE_NAME)) {
            return;
        }
        Path dotenv = locateDotenv(startDir);
        if (dotenv == null) {
            return;
        }
        Map<String, Object> entries = parse(dotenv);
        if (entries.isEmpty()) {
            return;
        }
        MutablePropertySources sources = environment.getPropertySources();
        MapPropertySource source = new MapPropertySource(SOURCE_NAME, entries);
        if (sources.contains(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME)) {
            sources.addAfter(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME, source);
        } else {
            sources.addFirst(source);
        }
        log.info("[PAY] dotenv_loaded path={} keys={}", dotenv, entries.size());
    }

    @Override
    public int getOrder() {
        // LOWEST_PRECEDENCE：跑在 ConfigData（HIGHEST+10，加载 application.yaml）之后
        return Ordered.LOWEST_PRECEDENCE;
    }

    /** 自 startDir 向上找 .env（IDE 默认工作目录是模块目录，.env 在其上级项目根）。 */
    private Path locateDotenv(Path startDir) {
        Path dir = startDir.toAbsolutePath();
        for (int i = 0; i <= MAX_PARENT_LEVELS && dir != null; i++, dir = dir.getParent()) {
            Path candidate = dir.resolve(".env");
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    /** 极简 .env 解析：KEY=VALUE（首个 = 分隔，值本身可含 =，密钥 base64 可能有 = 填充）、# 注释、空行、可选成对引号剥离。 */
    private Map<String, Object> parse(Path dotenv) {
        Map<String, Object> entries = new HashMap<>();
        try (Stream<String> lines = Files.lines(dotenv)) {
            lines.map(String::trim)
                    .filter(line -> !line.isEmpty() && !line.startsWith("#"))
                    .forEach(line -> {
                        int eq = line.indexOf('=');
                        if (eq <= 0) {
                            return; // 无 = 或空 key 的行跳过
                        }
                        String key = line.substring(0, eq).trim();
                        String value = stripQuotes(line.substring(eq + 1).trim());
                        if (!key.isEmpty()) {
                            entries.put(key, value);
                        }
                    });
        } catch (IOException e) {
            log.warn("[PAY] dotenv_read_failed path={} err={}", dotenv, e.toString());
        }
        return entries;
    }

    /** 剥离成对的首尾引号（KEY="v" / KEY='v'），内部引号不动。 */
    private String stripQuotes(String value) {
        if (value.length() >= 2) {
            char first = value.charAt(0);
            char last = value.charAt(value.length() - 1);
            if ((first == '"' && last == '"') || (first == '\'' && last == '\'')) {
                return value.substring(1, value.length() - 1);
            }
        }
        return value;
    }
}
