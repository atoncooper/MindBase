# app-pay 生产镜像（多阶段构建）
# ============================================================
# 优化点（2026-11）：
#  - BuildKit 缓存挂载 ~/.m2/repository：依赖只下载一次，改代码重建秒级完成；
#  - 去掉 dependency:go-offline（它常因解析插件/测试依赖而“假死”并重复下载）；
#  - 保留 timeout 上限，失败快速退出并打印 Maven 日志（不再静默重试 3×30 分钟）；
#  - -Dmaven.test.skip=true 跳过测试编译与测试依赖，镜像构建更快；
#  - .dockerignore 排除 logs/certs/src/test/target 非 jar 内容，减小上下文并避免私钥入镜像。
#
# 快速本地构建（不下载依赖，直接用宿主机 target 里的 jar）：
#   mvn -DskipTests package
#   APP_PAY_TEST_DOCKERFILE=Dockerfile.local docker compose -f docker-compose.test.yml up -d --build
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build

# 阿里云镜像（仅构建期使用；不进入运行镜像）
COPY maven-settings.xml /root/.m2/settings.xml

# 先只拷 pom，配合缓存挂载让依赖解析层尽量稳定
COPY pom.xml ./

# 源码（.dockerignore 已排除 src/test）
COPY src ./src

# 依赖缓存放在 BuildKit cache mount 里：
#  - 首次构建仍需联网下载，但日志可见、失败快速退出；
#  - 后续构建/改代码不再重新下载；
#  - sharing=locked 避免并发构建写坏本地仓库。
RUN --mount=type=cache,target=/root/.m2/repository,sharing=locked \
    timeout 1200 mvn -B \
      -Dmaven.artifact.threads=16 \
      -Dmaven.test.skip=true \
      -Dmaven.wagon.http.retryHandler.count=3 \
      package

# ---- runtime ----
FROM eclipse-temurin:21-jre
# 统一时区/编码（会员到期、订单超时均按北京时间计算）
ENV TZ=Asia/Shanghai \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    JAVA_TOOL_OPTIONS="-Dfile.encoding=UTF-8 -Duser.timezone=Asia/Shanghai"
WORKDIR /app
COPY --from=build /build/target/app-pay-*.jar /app/app.jar
EXPOSE 8002
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
