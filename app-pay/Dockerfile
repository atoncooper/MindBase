# Multi-stage build: Maven build (Alibaba Cloud mirror to avoid dependency download timeouts in China) -> JRE runtime
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY maven-settings.xml /root/.m2/settings.xml
# Copy the pom first to fetch dependencies, leveraging Docker layer caching.
# Both mvn steps retry. Two failure modes to defend against:
#  - transient truncation ("Premature end of Content-Length") → mvn exits 1
#  - stalled connection → mvn waits forever, so each attempt is capped with
#    coreutils `timeout` (30min: go-offline legitimately takes ~15min here)
# ~/.m2 persists across attempts within the same RUN, so retries resume
# incrementally instead of re-downloading everything.
COPY pom.xml .
RUN ok=0; for i in 1 2 3; do \
      if timeout 1800 mvn -B -q -Dmaven.artifact.threads=16 dependency:go-offline; then ok=1; break; fi; \
      echo "dependency:go-offline attempt $i failed/timed out, retrying in 10s..."; sleep 10; \
    done; \
    [ "$ok" = "1" ] || { echo "dependency:go-offline failed after 3 attempts"; exit 1; }
COPY src ./src
RUN ok=0; for i in 1 2 3; do \
      if timeout 1800 mvn -B -q -Dmaven.artifact.threads=16 package -DskipTests; then ok=1; break; fi; \
      echo "package attempt $i failed/timed out, retrying in 10s..."; sleep 10; \
    done; \
    [ "$ok" = "1" ] || { echo "package failed after 3 attempts"; exit 1; }

FROM eclipse-temurin:21-jre
# Unify the timezone to Asia/Shanghai (membership expiry / order timeout are all computed in Beijing time);
# Belt-and-suspenders LANG + file.encoding: since JEP 400 (Java 18+) the default charset is UTF-8 regardless of
# environment, these only pin locale-dependent paths in the container (system output / third-party libraries)
ENV TZ=Asia/Shanghai \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8\ -Duser.timezone=Asia/Shanghai
WORKDIR /app
COPY --from=build /build/target/app-pay-*.jar /app/app.jar
EXPOSE 8002
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
