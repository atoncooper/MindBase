package com.mindbase.pay.mapper;

import org.junit.jupiter.api.Test;
import org.w3c.dom.Document;

import javax.xml.parsers.DocumentBuilderFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 约定守护（不连数据库）：手写 SQL 一律进 resources/mapper/*.xml，接口不放注解 SQL。
 * - XML 必须可解析且 namespace 对应真实接口文件；
 * - 每个 statement id 必须有同名接口方法（防止改接口忘改 XML 的运行期才暴露的错）。
 */
class MapperXmlConsistencyTest {

    private static final Path MAPPER_XML_DIR = Paths.get("src", "main", "resources", "mapper");
    private static final Path MAPPER_JAVA_DIR = Paths.get("src", "main", "java", "com", "mindbase", "pay", "mapper");

    @Test
    void xmlStatementsMatchInterfaceMethods() throws Exception {
        assertThat(MAPPER_XML_DIR.toFile().exists()).as("resources/mapper 目录存在").isTrue();
        List<Path> xmlFiles;
        try (Stream<Path> files = Files.list(MAPPER_XML_DIR)) {
            xmlFiles = files.filter(p -> p.toString().endsWith(".xml")).toList();
        }
        assertThat(xmlFiles).as("至少存在一个 mapper XML").isNotEmpty();

        for (Path xml : xmlFiles) {
            Document doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(xml.toFile());
            String namespace = doc.getDocumentElement().getAttribute("namespace");
            Path javaFile = MAPPER_JAVA_DIR.resolve(
                    namespace.substring(namespace.lastIndexOf('.') + 1) + ".java");
            assertThat(javaFile.toFile().exists()).as("接口存在: %s", namespace).isTrue();
            String javaSource = Files.readString(javaFile);

            var nodes = doc.getDocumentElement().getChildNodes();
            for (int i = 0; i < nodes.getLength(); i++) {
                var node = nodes.item(i);
                if (node.getAttributes() == null || node.getAttributes().getNamedItem("id") == null) {
                    continue;
                }
                String id = node.getAttributes().getNamedItem("id").getNodeValue();
                assertThat(Pattern.compile("\\b" + id + "\\s*\\(").matcher(javaSource).find())
                        .as("%s.%s 在接口中有同名方法", namespace, id).isTrue();
            }
        }
    }

    @Test
    void mapperInterfacesCarryNoAnnotationSql() throws Exception {
        List<Path> javaFiles;
        try (Stream<Path> files = Files.list(MAPPER_JAVA_DIR)) {
            javaFiles = files.filter(p -> p.toString().endsWith(".java")).toList();
        }
        for (Path javaFile : javaFiles) {
            String source = Files.readString(javaFile);
            assertThat(source).as("%s 不含注解式 SQL", javaFile.getFileName())
                    .doesNotContain("@Update", "@Select", "@Insert", "@Delete");
        }
    }
}
