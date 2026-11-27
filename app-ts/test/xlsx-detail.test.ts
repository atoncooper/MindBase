import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  MAX_XLSX_BYTES,
  XlsxDetailError,
  parseXlsxDetail,
  renderXlsxDetailText,
} from "../src/doc-parser/xlsx-detail.js";

/**
 * xlsx detail inspection: the OOXML fixtures are hand-built with JSZip (no
 * binary workbook is committed) and cover shared strings + rich text runs,
 * inline strings, numeric / boolean / formula cells, worksheet order from
 * workbook.xml + rels, dimension present and missing (computed from cells),
 * merged cells, frozen pane, auto filter, column widths and the parse caps.
 * Offline only: no network, no real Excel file.
 */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

const WORKBOOK =
  XML_DECL +
  '<workbook xmlns="' +
  S_NS +
  '" xmlns:r="' +
  R_NS +
  '"><sheets>' +
  '<sheet name="销售数据" sheetId="1" r:id="rId1"/>' +
  '<sheet name="汇总" sheetId="2" r:id="rId2"/>' +
  '<sheet name="隐藏表" sheetId="3" r:id="rId3"/>' +
  "</sheets></workbook>";

const WORKBOOK_RELS =
  XML_DECL +
  '<Relationships xmlns="' +
  REL_NS +
  '">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>' +
  "</Relationships>";

const SHARED_STRINGS =
  XML_DECL +
  '<sst xmlns="' +
  S_NS +
  '" count="4" uniqueCount="4">' +
  "<si><t>名称</t></si>" +
  "<si><t>数量</t></si>" +
  "<si><r><t>苹</t></r><r><t>果</t></r></si>" +
  "<si><t>备注</t></si>" +
  "</sst>";

const SHEET_SALES =
  XML_DECL +
  '<worksheet xmlns="' +
  S_NS +
  '"><dimension ref="A1:C4"/>' +
  '<sheetViews><sheetView workbookViewId="0">' +
  '<pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/>' +
  "</sheetView></sheetViews>" +
  '<cols><col min="1" max="1" width="14" customWidth="1"/><col min="2" max="2" width="9.5" customWidth="1"/></cols>' +
  "<sheetData>" +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>3</v></c></row>' +
  '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12.5</v></c><c r="C2" t="b"><v>1</v></c></row>' +
  '<row r="3"><c r="A3" t="inlineStr"><is><t>香蕉</t></is></c><c r="B3"><f>SUM(B2:B2)</f><v>12.5</v></c>' +
  '<c r="C3" t="str"><f>CONCAT(A2,"!")</f><v>苹果!</v></c></row>' +
  '<row r="4"><c r="A4" t="inlineStr"><is><t>合计</t></is></c><c r="B4"><f>SUM(B2:B3)</f><v>12.5</v></c></row>' +
  "</sheetData>" +
  '<mergeCells count="1"><mergeCell ref="A4:C4"/></mergeCells>' +
  '<autoFilter ref="A1:C4"/>' +
  "</worksheet>";

/** No <dimension>: counts must be inferred from the cells that carry text. */
const SHEET_SUMMARY =
  XML_DECL +
  '<worksheet xmlns="' +
  S_NS +
  '"><sheetData>' +
  '<row r="1"><c r="A1" t="inlineStr"><is><t>项目</t></is></c></row>' +
  '<row r="3"><c r="B3"><v>200</v></c></row>' +
  "</sheetData></worksheet>";

const SHEET_HIDDEN =
  XML_DECL + '<worksheet xmlns="' + S_NS + '"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';

async function makeXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", WORKBOOK);
  zip.file("xl/_rels/workbook.xml.rels", WORKBOOK_RELS);
  zip.file("xl/sharedStrings.xml", SHARED_STRINGS);
  zip.file("xl/worksheets/sheet1.xml", SHEET_SALES);
  zip.file("xl/worksheets/sheet2.xml", SHEET_SUMMARY);
  zip.file("xl/worksheets/sheet3.xml", SHEET_HIDDEN);
  return zip.generateAsync({ type: "nodebuffer" });
}

const XLSX_PROMISE = makeXlsx();

describe("parseXlsxDetail", () => {
  it("按 workbook 顺序解析工作表、共享字符串、表头、公式与布局信息", async () => {
    const detail = await parseXlsxDetail(await XLSX_PROMISE);
    expect(detail.sheetCount).toBe(3);
    expect(detail.sheets.map((sheet) => sheet.name)).toEqual(["销售数据", "汇总", "隐藏表"]);

    const sales = detail.sheets[0];
    expect(sales.dimension).toBe("A1:C4");
    expect(sales.rowCount).toBe(4);
    expect(sales.colCount).toBe(3);
    expect(sales.headers).toEqual(["名称", "数量", "备注"]);
    expect(sales.rows).toEqual([
      ["苹果", "12.5", "TRUE"],
      ["香蕉", "12.5", "苹果!"],
      ["合计", "12.5", ""],
    ]);
    expect(sales.formulas).toEqual([
      { cell: "B3", formula: "SUM(B2:B2)" },
      { cell: "C3", formula: 'CONCAT(A2,"!")' },
      { cell: "B4", formula: "SUM(B2:B3)" },
    ]);
    expect(sales.merged).toEqual(["A4:C4"]);
    expect(sales.columnWidths).toEqual([14, 9.5]);
    expect(sales.freezePane).toBe("B3");
    expect(sales.autoFilter).toBe("A1:C4");
  });

  it("缺少 dimension 时按实际单元格推算行列数与范围", async () => {
    const detail = await parseXlsxDetail(await XLSX_PROMISE);
    const summary = detail.sheets[1];
    expect(summary.dimension).toBe("A1:B3");
    expect(summary.rowCount).toBe(3);
    expect(summary.colCount).toBe(2);
    expect(summary.headers).toEqual(["项目", ""]);
    expect(summary.rows).toEqual([["", "200"]]);
    expect(summary.formulas).toEqual([]);
    expect(summary.merged).toEqual([]);
  });

  it("maxRows / maxSheets / maxFormulas 限制生效", async () => {
    const limited = await parseXlsxDetail(await XLSX_PROMISE, { maxRows: 2, maxSheets: 2, maxFormulas: 1 });
    expect(limited.sheetCount).toBe(3);
    expect(limited.sheets).toHaveLength(2);
    expect(limited.sheets[0].headers).toEqual(["名称", "数量", "备注"]);
    expect(limited.sheets[0].rows).toEqual([["苹果", "12.5", "TRUE"]]);
    expect(limited.sheets[0].formulas).toHaveLength(1);
  });

  it("空文件 / 损坏 zip / 超过大小上限 / 缺少 workbook / 没有工作表都抛清晰错误", async () => {
    await expect(parseXlsxDetail(Buffer.alloc(0))).rejects.toThrow(/文件为空/);
    await expect(parseXlsxDetail(Buffer.from("this is not a zip"))).rejects.toBeInstanceOf(XlsxDetailError);
    await expect(parseXlsxDetail(Buffer.from("this is not a zip"))).rejects.toThrow(/无法打开 Excel 包/);

    await expect(parseXlsxDetail(Buffer.alloc(MAX_XLSX_BYTES + 1))).rejects.toThrow(/文件过大/);

    const noWorkbook = new JSZip();
    noWorkbook.file("xl/worksheets/sheet1.xml", SHEET_HIDDEN);
    await expect(parseXlsxDetail(await noWorkbook.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(
      /缺少 xl\/workbook\.xml/,
    );

    const noSheets = new JSZip();
    noSheets.file("xl/workbook.xml", XML_DECL + '<workbook xmlns="' + S_NS + '"><sheets/></workbook>');
    await expect(parseXlsxDetail(await noSheets.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/没有工作表/);
  });
});

describe("renderXlsxDetailText", () => {
  it("输出中文摘要：概览、规模、表头、预览、公式、合并、冻结与筛选", async () => {
    const text = renderXlsxDetailText(await parseXlsxDetail(await XLSX_PROMISE));
    expect(text).toContain("【Excel 概览】");
    expect(text).toContain("工作表：3 个");
    expect(text).toContain("【表 1】销售数据");
    expect(text).toContain("规模：4 行 × 3 列，范围 A1:C4");
    expect(text).toContain("表头：名称 | 数量 | 备注");
    expect(text).toContain("| 名称 | 数量 | 备注 |");
    expect(text).toContain("| 苹果 | 12.5 | TRUE |");
    expect(text).toContain("公式（3 个）");
    expect(text).toContain("B3 = SUM(B2:B2)");
    expect(text).toContain("合并单元格：A4:C4");
    expect(text).toContain("冻结窗格：B3");
    expect(text).toContain("自动筛选：A1:C4");
    expect(text).toContain("【表 2】汇总");
  });

  it("遵守 maxChars 预算", async () => {
    const detail = await parseXlsxDetail(await XLSX_PROMISE);
    const clipped = renderXlsxDetailText(detail, { maxChars: 160 });
    expect(clipped.length).toBeLessThanOrEqual(160);
    expect(clipped).toContain("已截断");
  });
});
