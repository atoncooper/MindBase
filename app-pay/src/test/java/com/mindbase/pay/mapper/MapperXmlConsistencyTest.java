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
 * Convention guard (no database connection): hand-written SQL always goes into resources/mapper/*.xml, and interfaces carry no annotation SQL.
 * - The XML must be parseable and its namespace must correspond to a real interface file;
 * - Every statement id must have a same-named interface method (prevents errors that only surface at runtime when an interface is changed but the XML is forgotten).
 */
class MapperXmlConsistencyTest {

    private static final Path MAPPER_XML_DIR = Paths.get("src", "main", "resources", "mapper");
    private static final Path MAPPER_JAVA_DIR = Paths.get("src", "main", "java", "com", "mindbase", "pay", "mapper");

    @Test
    void xmlStatementsMatchInterfaceMethods() throws Exception {
        assertThat(MAPPER_XML_DIR.toFile().exists()).as("resources/mapper directory exists").isTrue();
        List<Path> xmlFiles;
        try (Stream<Path> files = Files.list(MAPPER_XML_DIR)) {
            xmlFiles = files.filter(p -> p.toString().endsWith(".xml")).toList();
        }
        assertThat(xmlFiles).as("at least one mapper XML exists").isNotEmpty();

        for (Path xml : xmlFiles) {
            Document doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(xml.toFile());
            String namespace = doc.getDocumentElement().getAttribute("namespace");
            Path javaFile = MAPPER_JAVA_DIR.resolve(
                    namespace.substring(namespace.lastIndexOf('.') + 1) + ".java");
            assertThat(javaFile.toFile().exists()).as("interface exists: %s", namespace).isTrue();
            String javaSource = Files.readString(javaFile);

            var nodes = doc.getDocumentElement().getChildNodes();
            for (int i = 0; i < nodes.getLength(); i++) {
                var node = nodes.item(i);
                if (node.getAttributes() == null || node.getAttributes().getNamedItem("id") == null) {
                    continue;
                }
                String id = node.getAttributes().getNamedItem("id").getNodeValue();
                assertThat(Pattern.compile("\\b" + id + "\\s*\\(").matcher(javaSource).find())
                        .as("%s.%s has a same-named method in the interface", namespace, id).isTrue();
            }
        }
    }

    @Test
    void timeoutExecutorCannotCloseNonExpiredOrder() throws Exception {
        // trust-boundary hardening: even if the executor is spoof-called from the same network, the SQL requires expires_at <= now
        String xml = Files.readString(MAPPER_XML_DIR.resolve("PayOrderMapper.xml"));
        String stmt = statement(xml, "closeOrderAtVersion");
        assertThat(stmt).contains("expires_at &lt;= #{now}");
    }

    @Test
    void refundPrevStatusIsCapturedBeforeStatusIsOverwritten() throws Exception {
        // MySQL evaluates assignments left to right: refund_prev_status must be assigned before status, otherwise it records REFUNDING
        String xml = Files.readString(MAPPER_XML_DIR.resolve("PayOrderMapper.xml"));
        String stmt = statement(xml, "markRefunding");
        assertThat(stmt.indexOf("refund_prev_status = status"))
                .as("refund_prev_status must be assigned before status")
                .isLessThan(stmt.indexOf("'REFUNDING'"));
    }

    private static String statement(String xml, String id) {
        int start = xml.indexOf("id=\"" + id + "\"");
        assertThat(start).as("statement %s exists", id).isGreaterThanOrEqualTo(0);
        int end = xml.indexOf("</update>", start);
        return xml.substring(start, end);
    }

    @Test
    void mapperInterfacesCarryNoAnnotationSql() throws Exception {
        List<Path> javaFiles;
        try (Stream<Path> files = Files.list(MAPPER_JAVA_DIR)) {
            javaFiles = files.filter(p -> p.toString().endsWith(".java")).toList();
        }
        for (Path javaFile : javaFiles) {
            String source = Files.readString(javaFile);
            assertThat(source).as("%s contains no annotation-based SQL", javaFile.getFileName())
                    .doesNotContain("@Update", "@Select", "@Insert", "@Delete");
        }
    }
}
