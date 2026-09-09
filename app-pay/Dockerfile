# 多阶段构建：Maven 构建（阿里云镜像，防国内依赖下载超时）→ JRE 运行
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build
COPY maven-settings.xml /root/.m2/settings.xml
# 先拷 pom 拉依赖，利用 Docker 层缓存
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src ./src
RUN mvn -B -q package -DskipTests

FROM eclipse-temurin:17-jre
# 时区统一 Asia/Shanghai（会员到期/订单超时均按北京时间计算）；
# LANG + file.encoding 双保险：基础镜像默认 locale 是 ASCII，Java 17 默认字符集跟随环境，
# 不固定会导致容器内默认字符集路径（系统输出/第三方库）中文乱码
ENV TZ=Asia/Shanghai \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8\ -Duser.timezone=Asia/Shanghai
WORKDIR /app
COPY --from=build /build/target/app-pay-*.jar /app/app.jar
EXPOSE 8002
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
