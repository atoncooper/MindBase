import JSZip from "jszip";

/**
 * Word (.docx) package generation for the academic manuscript workspace
 * (contract: docs/manuscript-docx.md).
 *
 * Layer: service-domain pure module; no HTTP, no repositories, no cloud calls.
 * This is the WRITE half of the Word round-trip: title + sections → OOXML
 * package. The READ half (docx bytes → text / sections) lives in
 * `src/doc-parser/docx.ts`, so mammoth/linkedom stay in the parser layer and
 * this file only authors OOXML.
 *
 * Two modes, both producing a standards-compliant package:
 *  - no template: a minimal but complete docx is authored here
 *    ([Content_Types].xml / _rels/.rels / word/document.xml /
 *     word/_rels/document.xml.rels / word/styles.xml with Title/Heading1/
 *     Heading2/Normal);
 *  - with template (an existing manuscript the user uploaded): only
 *    word/document.xml is replaced, so the document's styles, theme, headers
 *    and footers, numbering and page setup survive. Body paragraphs reference
 *    the template's own style ids, resolved from word/styles.xml by style name
 *    (name → styleId), falling back to Heading1/Heading2/Normal when absent.
 *    The template's body-level `<w:sectPr>` (page size/margins/headers) is
 *    copied into the new body, and the template's root element is reused so its
 *    namespace declarations stay valid.
 *
 * No new dependency is introduced: jszip (OOXML zip) was already used by the
 * doc-parser, whose mammoth/linkedom handle the parsing side.
 */

/** One section as consumed by the generator (a subset of the repository's AcademicSection). */
export interface DocxSectionInput {
  title: string;
  content?: string;
}

export interface BuildDocxOptions {
  /** Document title; rendered with the Title style (omitted when blank). */
  title?: string;
  sections: DocxSectionInput[];
  /** Existing .docx package to reuse (styles/theme/headers/footers/page setup preserved). */
  template?: Uint8Array;
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
/** XML declaration shared by every authored part. */
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** Default A4 portrait page with 1in/1.25in margins (used when the template has no sectPr). */
const DEFAULT_SECT_PR =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/>' +
  "</w:sectPr>";

const STYLES_XML =
  XML_DECL +
  '<w:styles xmlns:w="' + W_NS + '">' +
  "<w:docDefaults>" +
  "<w:rPrDefault><w:rPr>" +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Times New Roman"/>' +
  '<w:sz w:val="24"/><w:szCs w:val="24"/>' +
  '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>' +
  "</w:rPr></w:rPrDefault>" +
  '<w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  "</w:docDefaults>" +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
  '<w:name w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr>' +
  '<w:rPr><w:sz w:val="24"/></w:rPr>' +
  "</w:style>" +
  '<w:style w:type="paragraph" w:styleId="Title">' +
  '<w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr>' +
  '<w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr>' +
  "</w:style>" +
  '<w:style w:type="paragraph" w:styleId="Heading1">' +
  '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="360" w:after="120"/></w:pPr>' +
  '<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>' +
  "</w:style>" +
  '<w:style w:type="paragraph" w:styleId="Heading2">' +
  '<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="240" w:after="120"/></w:pPr>' +
  '<w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>' +
  "</w:style>" +
  "</w:styles>";

const CONTENT_TYPES_XML =
  XML_DECL +
  '<Types xmlns="' + CT_NS + '">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  "</Types>";

const PACKAGE_RELS_XML =
  XML_DECL +
  '<Relationships xmlns="' + RELS_NS + '">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

const DOCUMENT_RELS_XML =
  XML_DECL +
  '<Relationships xmlns="' + RELS_NS + '">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  "</Relationships>";

/** Root element used when the template does not provide one to reuse. */
const DOCUMENT_ROOT =
  '<w:document xmlns:w="' + W_NS + '"' +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
  ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
  ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
  ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"' +
  ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"' +
  ' xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"' +
  ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"' +
  ' mc:Ignorable="w14 w15">';

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/** XML text escaping; invalid control characters are dropped so Word never sees a broken part. */
function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\t/g, "    ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** One paragraph in the given style; text runs preserve leading/trailing spaces. */
function paragraphXml(styleId: string, text: string): string {
  return (
    "<w:p><w:pPr>" +
    '<w:pStyle w:val="' + escapeXml(styleId) + '"/>' +
    "</w:pPr><w:r><w:t xml:space=\"preserve\">" +
    escapeXml(text) +
    "</w:t></w:r></w:p>"
  );
}

/** Body XML for one section: Heading1 title, then one Normal paragraph per content line. */
function sectionBodyXml(section: DocxSectionInput, styleIds: ResolvedStyleIds): string {
  const lines = (section.content ?? "").split(/\r?\n/);
  const parts = [paragraphXml(styleIds.heading1, section.title ?? "")];
  for (const line of lines) {
    if (line.length === 0) continue;
    parts.push(paragraphXml(styleIds.normal, line));
  }
  return parts.join("");
}

/** Styles resolvable from a template's word/styles.xml; fallbacks keep the export valid on thin templates. */
interface ResolvedStyleIds {
  title: string;
  heading1: string;
  heading2: string;
  normal: string;
}

/** Normalized style key: case/space/underscore/hyphen insensitive ("heading 1" → "heading1"). */
function normalizeStyleName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_\-]+/g, "");
}

/**
 * Builds the name → styleId index of a styles.xml part. Both the style name
 * ("heading 1") and the style id are indexed, because Chinese Word documents
 * often keep an opaque id ("2") with a readable name, while some generators only
 * carry a recognizable id.
 */
function parseStyleIds(stylesXml: string | undefined): Map<string, string> {
  const index = new Map<string, string>();
  if (!stylesXml) return index;
  for (const match of stylesXml.matchAll(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g)) {
    const block = match[0];
    const styleId = /\bw:styleId="([^"]+)"/.exec(block)?.[1];
    if (!styleId) continue;
    const type = /\bw:type="([^"]+)"/.exec(block)?.[1];
    if (type !== undefined && type !== "paragraph") continue;
    const name = /<w:name\b[^>]*\bw:val="([^"]*)"/.exec(block)?.[1];
    if (name) {
      const key = normalizeStyleName(name);
      if (!index.has(key)) index.set(key, styleId);
    }
    const idKey = normalizeStyleName(styleId);
    if (idKey && !index.has(idKey)) index.set(idKey, styleId);
  }
  return index;
}

/** Resolves the four paragraph styles this module emits, falling back to the built-in ids. */
function resolveStyleIds(index: Map<string, string>): ResolvedStyleIds {
  const pick = (candidates: string[], fallback: string): string => {
    for (const candidate of candidates) {
      const found = index.get(normalizeStyleName(candidate));
      if (found) return found;
    }
    return fallback;
  };
  const heading1 = pick(["heading 1", "heading1", "标题 1", "标题1"], "Heading1");
  return {
    // A missing Title style degrades to the heading style so the document title stays a heading.
    title: pick(["title", "标题", "document title"], heading1),
    heading1,
    heading2: pick(["heading 2", "heading2", "标题 2", "标题2"], "Heading2"),
    normal: pick(["normal", "normal (web)", "正文"], "Normal"),
  };
}

/** Reads a zip part as UTF-8 text; undefined when the part is absent. */
async function readZipText(zip: JSZip, path: string): Promise<string | undefined> {
  const entry = zip.file(path);
  return entry ? entry.async("string") : undefined;
}

/**
 * Copies the last body-level `<w:sectPr>` out of a template document.xml so
 * page size, margins, header/footer references and columns survive the rewrite.
 */
function extractSectPr(templateDocumentXml: string | undefined): string | undefined {
  if (!templateDocumentXml) return undefined;
  const matches = [...templateDocumentXml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)];
  return matches.length > 0 ? matches[matches.length - 1][0] : undefined;
}

/** Reuses the template's `<w:document ...>` opening tag (its namespace declarations must stay declared). */
function extractDocumentRoot(templateDocumentXml: string | undefined): string {
  const root = templateDocumentXml ? /<w:document\b[^>]*>/.exec(templateDocumentXml)?.[0] : undefined;
  return root && root.includes("xmlns:w=") ? root : DOCUMENT_ROOT;
}

/** Full document.xml for the given body. */
function documentXml(root: string, body: string, sectPr: string): string {
  return XML_DECL + root + "<w:body>" + body + sectPr + "</w:body></w:document>";
}

/** Body + page setup for the standard (template-less) package. */
function standardBody(title: string | undefined, sections: DocxSectionInput[], styleIds: ResolvedStyleIds): string {
  const parts: string[] = [];
  if (title && title.trim().length > 0) parts.push(paragraphXml(styleIds.title, title.trim()));
  for (const section of sections) parts.push(sectionBodyXml(section, styleIds));
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Style ids of the authored package (matches the styles.xml above). */
const STANDARD_STYLE_IDS: ResolvedStyleIds = {
  title: "Title",
  heading1: "Heading1",
  heading2: "Heading2",
  normal: "Normal",
};

/**
 * Builds a .docx package from title + sections.
 *
 * With a template the whole package is reused and only word/document.xml is
 * regenerated: the template's styles.xml is left untouched (styles/theme/headers/
 * footers/numbering preserved), its style names are resolved to ids, and its
 * body-level sectPr is carried over. Without a template a minimal complete
 * package is authored with Title/Heading1/Heading2/Normal styles.
 */
export async function buildDocxBuffer(options: BuildDocxOptions): Promise<Buffer> {
  const sections = options.sections ?? [];
  const title = options.title?.trim() ?? "";

  if (options.template && options.template.byteLength > 0) {
    const zip = await JSZip.loadAsync(options.template);
    const templateDocument = await readZipText(zip, "word/document.xml");
    const stylesXml = await readZipText(zip, "word/styles.xml");
    const styleIds = resolveStyleIds(parseStyleIds(stylesXml));
    const root = extractDocumentRoot(templateDocument);
    const sectPr = extractSectPr(templateDocument) ?? DEFAULT_SECT_PR;
    zip.file("word/document.xml", documentXml(root, standardBody(title, sections, styleIds), sectPr));
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  }

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("_rels/.rels", PACKAGE_RELS_XML);
  zip.file("word/document.xml", documentXml(DOCUMENT_ROOT, standardBody(title, sections, STANDARD_STYLE_IDS), DEFAULT_SECT_PR));
  zip.file("word/_rels/document.xml.rels", DOCUMENT_RELS_XML);
  zip.file("word/styles.xml", STYLES_XML);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
