package com.mindbase.pay.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * .env 加载：占位符变量注入、真实环境变量优先、找不到文件静默跳过（Docker 容器形态常态）。
 * 用包级重载入口显式传起始目录——Windows 下改 user.dir 对 Path.of("") 无效（默认目录随 FileSystem 固化）。
 */
class PayDotenvEnvironmentPostProcessorTest {

    @TempDir
    Path tempDir;

    private StandardEnvironment process(Path startDir) {
        StandardEnvironment env = new StandardEnvironment();
        new PayDotenvEnvironmentPostProcessor().postProcessEnvironment(env, startDir);
        return env;
    }

    @Test
    void loadsEnvFileFromModuleDirParent() throws IOException {
        // 模拟 IDE 运行：工作目录 = 模块目录 app-pay，.env 在其上级（项目根）
        Path moduleDir = Files.createDirectories(tempDir.resolve("app-pay"));
        Files.writeString(moduleDir.getParent().resolve(".env"), """
                # comment line
                PAY_DOTENV_TEST_KEY=plain-value
                PAY_DOTENV_QUOTED='v a l'
                PAY_DOTENV_EQ=a=b=c

                NOT_A_KV_LINE
                """);

        StandardEnvironment env = process(moduleDir);

        // 首个 = 分隔：值本身可含 =（密钥 base64 可能有 = 填充）；引号剥离；注释/空行/非 KV 行跳过
        assertThat(env.getProperty("PAY_DOTENV_TEST_KEY")).isEqualTo("plain-value");
        assertThat(env.getProperty("PAY_DOTENV_QUOTED")).isEqualTo("v a l");
        assertThat(env.getProperty("PAY_DOTENV_EQ")).isEqualTo("a=b=c");
        assertThat(env.getPropertySources().contains(PayDotenvEnvironmentPostProcessor.SOURCE_NAME)).isTrue();
    }

    @Test
    void realEnvironmentVariableWinsOverDotenv() throws IOException {
        Files.writeString(tempDir.resolve(".env"), "PAY_DOTENV_TEST_KEY=from-file\n");

        StandardEnvironment env = new StandardEnvironment();
        // 真实环境变量位于 systemEnvironment 源——用同名源模拟其恒胜出
        env.getPropertySources().remove(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME);
        env.getPropertySources().addFirst(new MapPropertySource(
                StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                Map.of("PAY_DOTENV_TEST_KEY", "from-real-env")));

        new PayDotenvEnvironmentPostProcessor().postProcessEnvironment(env, tempDir);

        assertThat(env.getProperty("PAY_DOTENV_TEST_KEY")).isEqualTo("from-real-env");
    }

    @Test
    void missingDotenvIsNoop() {
        StandardEnvironment env = process(tempDir);

        // 起始目录向上均无 .env（Docker 容器常态）：不加源、不抛异常
        assertThat(env.getPropertySources().contains(PayDotenvEnvironmentPostProcessor.SOURCE_NAME)).isFalse();
    }
}
