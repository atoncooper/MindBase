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
 * Loads the project root .env into the Spring Environment when starting locally (IDE / java command).
 *
 * <p>Background: the ${ALIPAY_*}/${PAY_MYSQL_*}/${PAY_TEST_TOKEN} placeholders in yaml are injected as real
 * environment variables by compose env_file in the container form; the local form previously had no source and
 * fell back entirely to the yaml defaults
 * -- so values set in .env had no effect (typical symptom: ALIPAY_ENABLED=true but the local instance reports "payment channel not open yet").
 *
 * <p>Precedence: real environment variables > .env > yaml defaults. Implemented by inserting the .env source after
 * systemEnvironment -- variables injected by env_file in the container and those explicitly exported by the shell
 * always win, matching container behavior.
 *
 * <p>Docker container images have no .env file -> skipped automatically (a missing file is normal, not an error);
 * a read failure only warns and does not block startup, and placeholders fall back to the yaml defaults.
 * Security: only the path and entry count are logged, never the values (.env contains payment secrets).
 */
@Slf4j
public class PayDotenvEnvironmentPostProcessor implements EnvironmentPostProcessor, Ordered {

    /** Property source name (for troubleshooting/testing). */
    public static final String SOURCE_NAME = "payDotenv";

    /** Maximum number of levels to walk up from the working directory: .env is at the project root (the IDE's default working directory is the parent of the module directory app-pay), preventing accidental capture of a same-named file in a higher directory. */
    private static final int MAX_PARENT_LEVELS = 3;

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        postProcessEnvironment(environment, Path.of(""));
    }

    /** Test entry point: explicitly specify the starting directory (on Windows the default directory of Path.of("") is fixed when the FileSystem is created, so changing user.dir in tests has no effect). */
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
        // LOWEST_PRECEDENCE: runs after ConfigData (HIGHEST+10, which loads application.yaml)
        return Ordered.LOWEST_PRECEDENCE;
    }

    /** Search upward from startDir for .env (the IDE's default working directory is the module directory, and .env is at the parent project root). */
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

    /** Minimal .env parsing: KEY=VALUE (split at the first =, the value itself may contain =, since base64 secrets may have = padding), # comments, blank lines, optional stripping of paired quotes. */
    private Map<String, Object> parse(Path dotenv) {
        Map<String, Object> entries = new HashMap<>();
        try (Stream<String> lines = Files.lines(dotenv)) {
            lines.map(String::trim)
                    .filter(line -> !line.isEmpty() && !line.startsWith("#"))
                    .forEach(line -> {
                        int eq = line.indexOf('=');
                        if (eq <= 0) {
                            return; // skip lines with no = or an empty key
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

    /** Strip paired leading/trailing quotes (KEY="v" / KEY='v'); inner quotes are left untouched. */
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
