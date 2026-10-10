import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { parseDocument, isSupportedDocument, UnsupportedDocumentError } from "../src/doc-parser/index.js";

/**
 * Document parser coverage: pptx (fabricated OOXML zip), docx (minimal valid
 * package fed to mammoth), html structure preservation, plain passthrough,
 * unsupported types.
 */

const slideXml = (paragraphs: string[]) => `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    ${paragraphs
      .map(
        (text) =>
          `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`,
      )
      .join("\n")}
  </p:spTree></p:cSld>
</p:sld>`;

async function makePptx(slides: Record<number, string[]>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [n, paragraphs] of Object.entries(slides)) {
    zip.file(`ppt/slides/slide${n}.xml`, slideXml(paragraphs));
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

const DOCX_PARTS = {
  "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  </Types>`,
  "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  </Relationships>`,
  "word/_rels/document.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  </Relationships>`,
  "word/styles.xml": `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  </w:styles>`,
  "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>RAG &amp; 检索</w:t></w:r></w:p>
      <w:p><w:r><w:t>正文段落，讲述向量检索。</w:t></w:r></w:p>
      <w:tbl>
        <w:tr><w:tc><w:p><w:r><w:t>方法</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>召回</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
    </w:body>
  </w:document>`,
};

async function makeDocx(): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(DOCX_PARTS)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("doc-parser", () => {
  it("pptx: slides in numeric order (slide10 after slide2), paragraphs joined, entities decoded", async () => {
    const buffer = await makePptx({
      1: ["向量检索", "概 & 述"],
      2: ["分块策略"],
      10: ["重排序"],
    });
    const { text, mime } = await parseDocument("deck.pptx", buffer);
    expect(mime).toContain("presentationml");

    const slideIdx = (n: number) => text.indexOf(`# 幻灯片 ${n}`);
    expect(slideIdx(1)).toBeGreaterThanOrEqual(0);
    expect(slideIdx(1)).toBeLessThan(slideIdx(2));
    expect(slideIdx(2)).toBeLessThan(slideIdx(10)); // numeric, not lexicographic

    expect(text).toContain("概 & 述"); // &amp; decoded
    expect(text).toContain("分块策略");
    expect(text).toContain("重排序");
  });

  it("pptx with no slides / broken zip → UnsupportedDocumentError", async () => {
    const empty = new JSZip();
    const emptyBuf = await empty.generateAsync({ type: "nodebuffer" });
    await expect(parseDocument("empty.pptx", emptyBuf)).rejects.toThrow(UnsupportedDocumentError);
    await expect(parseDocument("broken.pptx", Buffer.from("not a zip"))).rejects.toThrow(UnsupportedDocumentError);
  });

  it("docx: heading → markdown, paragraphs kept, table cells joined", async () => {
    const { text } = await parseDocument("report.docx", await makeDocx());
    expect(text).toContain("# RAG & 检索");
    expect(text).toContain("正文段落，讲述向量检索。");
    expect(text).toContain("方法 | 召回");
  });

  it("html: headings/lists/tables survive as structure", async () => {
    const { text } = await parseDocument(
      "page.html",
      Buffer.from("<h2>标题甲</h2><p>段落乙</p><ul><li>项丙</li></ul><table><tr><td>A</td><td>B</td></tr></table>"),
    );
    expect(text).toContain("## 标题甲");
    expect(text).toContain("段落乙");
    expect(text).toContain("- 项丙");
    expect(text).toContain("A | B");
  });

  it("txt/md passthrough", async () => {
    const md = "# 标题\n\n正文";
    expect((await parseDocument("a.md", Buffer.from(md))).text).toBe(md);
  });

  it("unsupported: legacy .ppt and unknown extensions", async () => {
    await expect(parseDocument("legacy.ppt", Buffer.from("binary"))).rejects.toThrow(UnsupportedDocumentError);
    await expect(parseDocument("x.exe", Buffer.from("binary"))).rejects.toThrow(UnsupportedDocumentError);
    expect(() => {
      throw new UnsupportedDocumentError("legacy.ppt");
    }).toThrow(/pptx/);
  });

  it("isSupportedDocument: pptx yes, images require OCR", () => {
    expect(isSupportedDocument("a.pptx", false)).toBe(true);
    expect(isSupportedDocument("a.docx", false)).toBe(true);
    expect(isSupportedDocument("a.png", false)).toBe(false);
    expect(isSupportedDocument("a.png", true)).toBe(true);
  });
});
