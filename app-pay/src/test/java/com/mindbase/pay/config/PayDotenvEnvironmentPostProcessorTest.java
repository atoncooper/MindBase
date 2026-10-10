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
 * .env loading: placeholder variable injection, real environment variables take precedence, silently skip when the file is missing (the usual Docker container shape).
 * Uses the package-level overload entry point to pass the start directory explicitly -- on Windows, changing user.dir has no effect on Path.of("") (the default directory is fixed with the FileSystem).
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
        // simulate an IDE run: working directory = module directory app-pay, with .env one level up (project root)
        Path moduleDir = Files.createDirectories(tempDir.resolve("app-pay"));
        Files.writeString(moduleDir.getParent().resolve(".env"), """
                # comment line
                PAY_DOTENV_TEST_KEY=plain-value
                PAY_DOTENV_QUOTED='v a l'
                PAY_DOTENV_EQ=a=b=c

                NOT_A_KV_LINE
                """);

        StandardEnvironment env = process(moduleDir);

        // split on the first =: the value itself may contain = (base64 secrets may have = padding); quotes are stripped; comments/blank lines/non-KV lines are skipped
        assertThat(env.getProperty("PAY_DOTENV_TEST_KEY")).isEqualTo("plain-value");
        assertThat(env.getProperty("PAY_DOTENV_QUOTED")).isEqualTo("v a l");
        assertThat(env.getProperty("PAY_DOTENV_EQ")).isEqualTo("a=b=c");
        assertThat(env.getPropertySources().contains(PayDotenvEnvironmentPostProcessor.SOURCE_NAME)).isTrue();
    }

    @Test
    void realEnvironmentVariableWinsOverDotenv() throws IOException {
        Files.writeString(tempDir.resolve(".env"), "PAY_DOTENV_TEST_KEY=from-file\n");

        StandardEnvironment env = new StandardEnvironment();
        // real environment variables live in the systemEnvironment source -- simulate its constant precedence with a source of the same name
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

        // no .env in the start directory or any ancestor (the usual Docker container shape): no source added, no exception thrown
        assertThat(env.getPropertySources().contains(PayDotenvEnvironmentPostProcessor.SOURCE_NAME)).isFalse();
    }
}
