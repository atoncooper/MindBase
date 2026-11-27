import { createLogger } from "../../logger.js";
import { DOCUMENT_TEMPLATE_IDS, type DocumentTemplateId, type PageOrientation, type PageSize } from "./ir.js";
import {
  DEFAULT_TEMPLATE_REGISTRY,
  createTemplateRegistry,
  type DocTemplate,
  type DocTemplateRegistry,
  type NumberingSpec,
  type PageSpec,
  type TypographySpec,
} from "./templates.js";

/**
 * External template overrides (deployment branding).
 *
 * The built-in templates in templates.ts are the product defaults; a deployment
 * can ship a small JSON file that tweaks them without forking the code:
 *
 *   {
 *     "version": 1,
 *     "templates": {
 *       "work-report": {
 *         "typography": { "bodySizePt": 11.5 },
 *         "page": { "marginsCm": { "left": 3.2 } },
 *         "brand": { "primaryColor": "#1F4E79", "logoUploadUuid": "..." }
 *       }
 *     }
 *   }
 *
 * Contract:
 *  - only known template ids are accepted; unknown ids are ignored with a warning;
 *  - aliases/keywords are appended to the built-ins (case-insensitive, de-duplicated),
 *    so an override never breaks the stock keyword inference;
 *  - brand.primaryColor wins over typography.accentColor; brand.logoUploadUuid is
 *    passed through for the (follow-up) renderer task;
 *  - invalid input never throws: every problem lands in errors (Chinese) and the
 *    affected template keeps its built-in definition (per-template atomic);
 *  - DOC_TEMPLATES is never mutated: the merged view is a fresh registry.
 */
const log = createLogger("OFFICE-TEMPLATE");

const SUPPORTED_VERSION = 1;

const PAGE_SIZES: readonly PageSize[] = ["A4", "A3", "Letter"];
const PAGE_ORIENTATIONS: readonly PageOrientation[] = ["portrait", "landscape"];
const LINE_RULES: readonly TypographySpec["lineRule"][] = ["auto", "exact"];
const COVER_VARIANTS: readonly DocTemplate["cover"]["variant"][] = ["center", "banner", "plain"];
const PAGE_NUMBERS: readonly DocTemplate["headerFooter"]["pageNumber"][] = ["center", "right", "left"];
const PAGE_NUMBER_FORMATS: readonly DocTemplate["headerFooter"]["pageNumberFormat"][] = ["plain", "dash"];
const NUMBERING_STYLES: readonly NumberingSpec["style"][] = ["chapter-cn", "decimal", "none"];
const LIST_GLYPHS: readonly DocTemplate["listGlyph"][] = ["dot", "dash", "square"];
const TOC_DEPTHS: readonly DocTemplate["toc"]["depth"][] = [1, 2, 3];

const TOP_LEVEL_KEYS = [
  "label",
  "description",
  "aliases",
  "keywords",
  "page",
  "typography",
  "cover",
  "headerFooter",
  "toc",
  "table",
  "numbering",
  "listGlyph",
  "brand",
] as const;

export interface TemplateOverrideMarginsCm {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface TemplatePageOverride {
  size?: PageSize;
  orientation?: PageOrientation;
  marginsCm?: TemplateOverrideMarginsCm;
}

export interface TemplateTypographyOverride {
  bodyFontEastAsia?: string;
  bodyFontAscii?: string;
  bodySizePt?: number;
  lineRule?: TypographySpec["lineRule"];
  lineTwips?: number;
  indentChars?: number;
  justify?: boolean;
  headingSizesPt?: Partial<TypographySpec["headingSizesPt"]>;
  headingColors?: Partial<TypographySpec["headingColors"]>;
  headingRule?: boolean;
  titleSizePt?: number;
  accentColor?: string;
}

export interface TemplateCoverOverride {
  enabled?: boolean;
  variant?: DocTemplate["cover"]["variant"];
  spaceBeforeTwips?: number;
  rule?: boolean;
}

export interface TemplateHeaderFooterOverride {
  headerText?: string;
  headerRule?: boolean;
  footerText?: string;
  pageNumber?: DocTemplate["headerFooter"]["pageNumber"];
  pageNumberFormat?: DocTemplate["headerFooter"]["pageNumberFormat"];
}

export interface TemplateTocOverride {
  enabled?: boolean;
  depth?: DocTemplate["toc"]["depth"];
  title?: string;
}

export interface TemplateTableOverride {
  headerFill?: string;
  borderColor?: string;
  fontSizePt?: number;
}

export interface TemplateNumberingOverride {
  style?: NumberingSpec["style"];
}

export interface TemplateBrandOverride {
  logoUploadUuid?: string;
  primaryColor?: string;
}

/** One template's override (every field optional: only what is present is merged). */
export interface TemplateOverride {
  label?: string;
  description?: string;
  aliases?: string[];
  keywords?: string[];
  page?: TemplatePageOverride;
  typography?: TemplateTypographyOverride;
  cover?: TemplateCoverOverride;
  headerFooter?: TemplateHeaderFooterOverride;
  toc?: TemplateTocOverride;
  table?: TemplateTableOverride;
  numbering?: TemplateNumberingOverride;
  listGlyph?: DocTemplate["listGlyph"];
  brand?: TemplateBrandOverride;
}

/** Shape of the external override JSON file. */
export interface TemplateOverrideFile {
  version: 1;
  templates: Record<string, TemplateOverride>;
}

export interface TemplateOverrideResult {
  /** Merged view to pass to getDocTemplate/resolveTemplate/the list tool. */
  registry: DocTemplateRegistry;
  /** Chinese validation problems; empty = the file was fully accepted. */
  errors: string[];
  /** Non-fatal problems (unknown template ids / unknown fields / no-op entries). */
  warnings: string[];
  /** Template ids whose override changed at least one field. */
  appliedTemplateIds: DocumentTemplateId[];
}

interface ParsedOverrideFile {
  version: 1;
  templates: Record<string, unknown>;
}

interface Sink {
  errors: string[];
  warnings: string[];
}

interface StringRule {
  min?: number;
  max?: number;
}

interface NumberRule {
  min?: number;
  max?: number;
  integer?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warnUnknownKeys(
  record: Record<string, unknown>,
  known: readonly string[],
  path: string,
  sink: Sink,
): void {
  const knownSet = new Set<string>(known);
  for (const key of Object.keys(record)) {
    if (!knownSet.has(key)) sink.warnings.push(path + "." + key + " 是未知字段，已忽略");
  }
}

function readString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  sink: Sink,
  rule: StringRule = {},
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    sink.errors.push(path + "." + key + " 必须是字符串");
    return undefined;
  }
  const text = value.trim();
  if (rule.min !== undefined && text.length < rule.min) {
    sink.errors.push(path + "." + key + " 长度不能小于 " + rule.min);
    return undefined;
  }
  if (rule.max !== undefined && text.length > rule.max) {
    sink.errors.push(path + "." + key + " 长度不能超过 " + rule.max);
    return undefined;
  }
  return text;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  sink: Sink,
  rule: NumberRule = {},
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    sink.errors.push(path + "." + key + " 必须是数字");
    return undefined;
  }
  if (rule.integer && !Number.isInteger(value)) {
    sink.errors.push(path + "." + key + " 必须是整数");
    return undefined;
  }
  if (rule.min !== undefined && value < rule.min) {
    sink.errors.push(path + "." + key + " 不能小于 " + rule.min);
    return undefined;
  }
  if (rule.max !== undefined && value > rule.max) {
    sink.errors.push(path + "." + key + " 不能大于 " + rule.max);
    return undefined;
  }
  return value;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  sink: Sink,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    sink.errors.push(path + "." + key + " 必须是布尔值");
    return undefined;
  }
  return value;
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  sink: Sink,
  allowed: readonly T[],
): T | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    sink.errors.push(path + "." + key + " 必须是 " + allowed.join(" / ") + " 之一");
    return undefined;
  }
  return value as T;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  sink: Sink,
  rule: { maxItems: number; maxItemLength: number },
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    sink.errors.push(path + "." + key + " 必须是字符串数组");
    return undefined;
  }
  if (value.length > rule.maxItems) {
    sink.errors.push(path + "." + key + " 最多 " + rule.maxItems + " 项");
    return undefined;
  }
  const out: string[] = [];
  let valid = true;
  value.forEach((item: unknown, index: number) => {
    if (typeof item !== "string" || item.trim() === "") {
      sink.errors.push(path + "." + key + "[" + index + "] 必须是非空字符串");
      valid = false;
      return;
    }
    const text = item.trim();
    if (text.length > rule.maxItemLength) {
      sink.errors.push(path + "." + key + "[" + index + "] 长度不能超过 " + rule.maxItemLength);
      valid = false;
      return;
    }
    out.push(text);
  });
  return valid ? out : undefined;
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
  path: string,
  sink: Sink,
): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    sink.errors.push(path + "." + key + " 必须是对象");
    return undefined;
  }
  return value;
}

const HEX_COLOR = /^#?[0-9a-fA-F]{6}$/;

function readColor(
  record: Record<string, unknown>,
  key: string,
  path: string,
  sink: Sink,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !HEX_COLOR.test(value.trim())) {
    sink.errors.push(path + "." + key + " 必须是 6 位十六进制颜色（如 1F4E79 或 #1F4E79）");
    return undefined;
  }
  return value.trim().replace(/^#/, "").toUpperCase();
}

function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function validatePage(raw: Record<string, unknown>, path: string, sink: Sink): TemplatePageOverride | undefined {
  const before = sink.errors.length;
  const out: TemplatePageOverride = {};
  assign(out, "size", readEnum(raw, "size", path, sink, PAGE_SIZES));
  assign(out, "orientation", readEnum(raw, "orientation", path, sink, PAGE_ORIENTATIONS));
  const margins = readRecord(raw, "marginsCm", path, sink);
  if (margins) {
    const marginsPath = path + ".marginsCm";
    const parsed: TemplateOverrideMarginsCm = {};
    assign(parsed, "top", readNumber(margins, "top", marginsPath, sink, { min: 0, max: 20 }));
    assign(parsed, "right", readNumber(margins, "right", marginsPath, sink, { min: 0, max: 20 }));
    assign(parsed, "bottom", readNumber(margins, "bottom", marginsPath, sink, { min: 0, max: 20 }));
    assign(parsed, "left", readNumber(margins, "left", marginsPath, sink, { min: 0, max: 20 }));
    warnUnknownKeys(margins, ["top", "right", "bottom", "left"], marginsPath, sink);
    out.marginsCm = parsed;
  }
  warnUnknownKeys(raw, ["size", "orientation", "marginsCm"], path, sink);
  return sink.errors.length === before ? out : undefined;
}

function validateTypography(
  raw: Record<string, unknown>,
  path: string,
  sink: Sink,
): TemplateTypographyOverride | undefined {
  const before = sink.errors.length;
  const out: TemplateTypographyOverride = {};
  assign(out, "bodyFontEastAsia", readString(raw, "bodyFontEastAsia", path, sink, { min: 1, max: 60 }));
  assign(out, "bodyFontAscii", readString(raw, "bodyFontAscii", path, sink, { min: 1, max: 60 }));
  assign(out, "bodySizePt", readNumber(raw, "bodySizePt", path, sink, { min: 6, max: 72 }));
  assign(out, "lineRule", readEnum(raw, "lineRule", path, sink, LINE_RULES));
  assign(out, "lineTwips", readNumber(raw, "lineTwips", path, sink, { min: 1, max: 2000, integer: true }));
  assign(out, "indentChars", readNumber(raw, "indentChars", path, sink, { min: 0, max: 2000, integer: true }));
  assign(out, "justify", readBoolean(raw, "justify", path, sink));
  assign(out, "headingRule", readBoolean(raw, "headingRule", path, sink));
  assign(out, "titleSizePt", readNumber(raw, "titleSizePt", path, sink, { min: 6, max: 72 }));
  assign(out, "accentColor", readColor(raw, "accentColor", path, sink));

  const sizes = readRecord(raw, "headingSizesPt", path, sink);
  if (sizes) {
    const sizesPath = path + ".headingSizesPt";
    const parsed: Partial<TypographySpec["headingSizesPt"]> = {};
    assign(parsed, "h1", readNumber(sizes, "h1", sizesPath, sink, { min: 6, max: 72 }));
    assign(parsed, "h2", readNumber(sizes, "h2", sizesPath, sink, { min: 6, max: 72 }));
    assign(parsed, "h3", readNumber(sizes, "h3", sizesPath, sink, { min: 6, max: 72 }));
    warnUnknownKeys(sizes, ["h1", "h2", "h3"], sizesPath, sink);
    out.headingSizesPt = parsed;
  }
  const colors = readRecord(raw, "headingColors", path, sink);
  if (colors) {
    const colorsPath = path + ".headingColors";
    const parsed: Partial<TypographySpec["headingColors"]> = {};
    assign(parsed, "h1", readColor(colors, "h1", colorsPath, sink));
    assign(parsed, "h2", readColor(colors, "h2", colorsPath, sink));
    assign(parsed, "h3", readColor(colors, "h3", colorsPath, sink));
    warnUnknownKeys(colors, ["h1", "h2", "h3"], colorsPath, sink);
    out.headingColors = parsed;
  }
  warnUnknownKeys(
    raw,
    [
      "bodyFontEastAsia",
      "bodyFontAscii",
      "bodySizePt",
      "lineRule",
      "lineTwips",
      "indentChars",
      "justify",
      "headingSizesPt",
      "headingColors",
      "headingRule",
      "titleSizePt",
      "accentColor",
    ],
    path,
    sink,
  );
  return sink.errors.length === before ? out : undefined;
}

function validateCover(raw: Record<string, unknown>, path: string, sink: Sink): TemplateCoverOverride | undefined {
  const before = sink.errors.length;
  const out: TemplateCoverOverride = {};
  assign(out, "enabled", readBoolean(raw, "enabled", path, sink));
  assign(out, "variant", readEnum(raw, "variant", path, sink, COVER_VARIANTS));
  assign(out, "spaceBeforeTwips", readNumber(raw, "spaceBeforeTwips", path, sink, { min: 0, max: 20000, integer: true }));
  assign(out, "rule", readBoolean(raw, "rule", path, sink));
  warnUnknownKeys(raw, ["enabled", "variant", "spaceBeforeTwips", "rule"], path, sink);
  return sink.errors.length === before ? out : undefined;
}

function validateHeaderFooter(
  raw: Record<string, unknown>,
  path: string,
  sink: Sink,
): TemplateHeaderFooterOverride | undefined {
  const before = sink.errors.length;
  const out: TemplateHeaderFooterOverride = {};
  assign(out, "headerText", readString(raw, "headerText", path, sink, { max: 200 }));
  assign(out, "headerRule", readBoolean(raw, "headerRule", path, sink));
  assign(out, "footerText", readString(raw, "footerText", path, sink, { max: 200 }));
  assign(out, "pageNumber", readEnum(raw, "pageNumber", path, sink, PAGE_NUMBERS));
  assign(out, "pageNumberFormat", readEnum(raw, "pageNumberFormat", path, sink, PAGE_NUMBER_FORMATS));
  warnUnknownKeys(
    raw,
    ["headerText", "headerRule", "footerText", "pageNumber", "pageNumberFormat"],
    path,
    sink,
  );
  return sink.errors.length === before ? out : undefined;
}

function validateToc(raw: Record<string, unknown>, path: string, sink: Sink): TemplateTocOverride | undefined {
  const before = sink.errors.length;
  const out: TemplateTocOverride = {};
  assign(out, "enabled", readBoolean(raw, "enabled", path, sink));
  const depth = readNumber(raw, "depth", path, sink, { min: 1, max: 3, integer: true });
  if (depth !== undefined) {
    if (!(TOC_DEPTHS as readonly number[]).includes(depth)) {
      sink.errors.push(path + ".depth 必须是 1 / 2 / 3 之一");
    } else {
      out.depth = depth as DocTemplate["toc"]["depth"];
    }
  }
  assign(out, "title", readString(raw, "title", path, sink, { max: 40 }));
  warnUnknownKeys(raw, ["enabled", "depth", "title"], path, sink);
  return sink.errors.length === before ? out : undefined;
}

function validateTable(raw: Record<string, unknown>, path: string, sink: Sink): TemplateTableOverride | undefined {
  const before = sink.errors.length;
  const out: TemplateTableOverride = {};
  assign(out, "headerFill", readColor(raw, "headerFill", path, sink));
  assign(out, "borderColor", readColor(raw, "borderColor", path, sink));
  assign(out, "fontSizePt", readNumber(raw, "fontSizePt", path, sink, { min: 6, max: 72 }));
  warnUnknownKeys(raw, ["headerFill", "borderColor", "fontSizePt"], path, sink);
  return sink.errors.length === before ? out : undefined;
}

function validateNumbering(
  raw: Record<string, unknown>,
  path: string,
  sink: Sink,
): TemplateNumberingOverride | undefined {
  const before = sink.errors.length;
  const out: TemplateNumberingOverride = {};
  assign(out, "style", readEnum(raw, "style", path, sink, NUMBERING_STYLES));
  warnUnknownKeys(raw, ["style"], path, sink);
  return sink.errors.length === before ? out : undefined;
}

function validateBrand(raw: Record<string, unknown>, path: string, sink: Sink): TemplateBrandOverride | undefined {
  const before = sink.errors.length;
  const out: TemplateBrandOverride = {};
  assign(out, "logoUploadUuid", readString(raw, "logoUploadUuid", path, sink, { min: 8, max: 128 }));
  assign(out, "primaryColor", readColor(raw, "primaryColor", path, sink));
  warnUnknownKeys(raw, ["logoUploadUuid", "primaryColor"], path, sink);
  return sink.errors.length === before ? out : undefined;
}

function validateTemplateOverride(
  raw: unknown,
  id: DocumentTemplateId,
  sink: Sink,
): TemplateOverride | undefined {
  const path = "templates." + id;
  if (!isRecord(raw)) {
    sink.errors.push(path + " 必须是对象");
    return undefined;
  }
  const before = sink.errors.length;
  const out: TemplateOverride = {};
  assign(out, "label", readString(raw, "label", path, sink, { min: 1, max: 60 }));
  assign(out, "description", readString(raw, "description", path, sink, { max: 500 }));
  assign(out, "aliases", readStringArray(raw, "aliases", path, sink, { maxItems: 30, maxItemLength: 40 }));
  assign(out, "keywords", readStringArray(raw, "keywords", path, sink, { maxItems: 60, maxItemLength: 40 }));
  assign(out, "listGlyph", readEnum(raw, "listGlyph", path, sink, LIST_GLYPHS));
  const page = readRecord(raw, "page", path, sink);
  if (page) assign(out, "page", validatePage(page, path + ".page", sink));
  const typography = readRecord(raw, "typography", path, sink);
  if (typography) assign(out, "typography", validateTypography(typography, path + ".typography", sink));
  const cover = readRecord(raw, "cover", path, sink);
  if (cover) assign(out, "cover", validateCover(cover, path + ".cover", sink));
  const headerFooter = readRecord(raw, "headerFooter", path, sink);
  if (headerFooter) assign(out, "headerFooter", validateHeaderFooter(headerFooter, path + ".headerFooter", sink));
  const toc = readRecord(raw, "toc", path, sink);
  if (toc) assign(out, "toc", validateToc(toc, path + ".toc", sink));
  const table = readRecord(raw, "table", path, sink);
  if (table) assign(out, "table", validateTable(table, path + ".table", sink));
  const numbering = readRecord(raw, "numbering", path, sink);
  if (numbering) assign(out, "numbering", validateNumbering(numbering, path + ".numbering", sink));
  const brand = readRecord(raw, "brand", path, sink);
  if (brand) assign(out, "brand", validateBrand(brand, path + ".brand", sink));
  warnUnknownKeys(raw, TOP_LEVEL_KEYS, path, sink);
  return sink.errors.length === before ? out : undefined;
}

function parseOverrideFile(input: unknown, sink: Sink): ParsedOverrideFile | undefined {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (err) {
      sink.errors.push("模板配置不是合法 JSON：" + (err instanceof Error ? err.message : String(err)));
      return undefined;
    }
  }
  if (!isRecord(value)) {
    sink.errors.push("模板配置必须是 JSON 对象：{ version: 1, templates: { 模板 id: 覆盖项 } }");
    return undefined;
  }
  const version = value.version;
  if (version !== SUPPORTED_VERSION) {
    sink.errors.push("version 必须为 " + SUPPORTED_VERSION + "（当前值：" + String(version) + "）");
    return undefined;
  }
  const templates = value.templates;
  if (!isRecord(templates)) {
    sink.errors.push("templates 必须是对象：{ 模板 id: 覆盖项 }");
    return undefined;
  }
  warnUnknownKeys(value, ["version", "templates"], "配置", sink);
  return { version: SUPPORTED_VERSION, templates };
}

function mergeStringList(base: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set<string>(base.map((item) => item.toLowerCase()));
  const merged = [...base];
  for (const item of extra) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function cmToTwips(cm: number): number {
  return Math.round(cm * 567);
}

/**
 * Applies one validated override to a template, returning a new template object
 * (the base — and therefore DOC_TEMPLATES — is never mutated).
 */
export function applyTemplateOverride(base: DocTemplate, override: TemplateOverride): DocTemplate {
  const merged: DocTemplate = { ...base };
  if (override.label !== undefined) merged.label = override.label;
  if (override.description !== undefined) merged.description = override.description;
  if (override.aliases !== undefined) merged.aliases = mergeStringList(base.aliases, override.aliases);
  if (override.keywords !== undefined) merged.keywords = mergeStringList(base.keywords, override.keywords);
  if (override.listGlyph !== undefined) merged.listGlyph = override.listGlyph;

  if (override.page) {
    const pageOverride = override.page;
    const next: PageSpec = { ...base.page, margins: { ...base.page.margins } };
    if (pageOverride.size !== undefined) next.size = pageOverride.size;
    if (pageOverride.orientation !== undefined) next.orientation = pageOverride.orientation;
    if (pageOverride.marginsCm) {
      for (const side of ["top", "right", "bottom", "left"] as const) {
        const cm = pageOverride.marginsCm[side];
        if (cm !== undefined) next.margins[side] = cmToTwips(cm);
      }
    }
    merged.page = next;
  }

  if (override.typography) {
    const { headingSizesPt: sizeOverride, headingColors: colorOverride, ...rest } = override.typography;
    merged.typography = {
      ...base.typography,
      ...rest,
      headingSizesPt: { ...base.typography.headingSizesPt, ...sizeOverride },
      headingColors: { ...base.typography.headingColors, ...colorOverride },
    };
  }
  if (override.cover) merged.cover = { ...base.cover, ...override.cover };
  if (override.headerFooter) merged.headerFooter = { ...base.headerFooter, ...override.headerFooter };
  if (override.toc) merged.toc = { ...base.toc, ...override.toc };
  if (override.table) merged.table = { ...base.table, ...override.table };
  if (override.numbering) merged.numbering = { ...base.numbering, ...override.numbering };

  if (override.brand) {
    const brand = { ...base.brand, ...override.brand };
    merged.brand = brand;
    // Brand identity outranks a per-template accent: the deployment's primary
    // colour is the visual signature, template accent is only the default.
    if (brand.primaryColor !== undefined) {
      merged.typography = { ...merged.typography, accentColor: brand.primaryColor };
    }
  }
  return merged;
}

function resultOf(registry: DocTemplateRegistry, applied: DocumentTemplateId[], sink: Sink): TemplateOverrideResult {
  for (const warning of sink.warnings) log.warn("[OFFICE-TEMPLATE] %s", warning);
  for (const error of sink.errors) log.warn("[OFFICE-TEMPLATE] 模板覆盖配置错误：%s", error);
  if (applied.length > 0) {
    log.info("[OFFICE-TEMPLATE] applied template overrides: %s", applied.join(","));
  }
  return { registry, errors: sink.errors, warnings: sink.warnings, appliedTemplateIds: applied };
}

/**
 * Validates and merges an external override file onto the built-in templates.
 *
 * Accepts the parsed JSON value or the raw JSON text. Never throws: invalid input
 * returns the base registry plus Chinese errors, so startup can log and continue
 * with product defaults.
 */
export function loadTemplateOverrides(
  input: unknown,
  base: DocTemplateRegistry = DEFAULT_TEMPLATE_REGISTRY,
): TemplateOverrideResult {
  const sink: Sink = { errors: [], warnings: [] };
  const parsed = parseOverrideFile(input, sink);
  if (!parsed) return resultOf(base, [], sink);

  const templates: Record<DocumentTemplateId, DocTemplate> = { ...base.templates };
  const applied: DocumentTemplateId[] = [];
  for (const [key, raw] of Object.entries(parsed.templates)) {
    const id = DOCUMENT_TEMPLATE_IDS.find((candidate) => candidate === key);
    if (!id) {
      sink.warnings.push(
        "未知模板 " + key + "，已忽略（可用模板：" + DOCUMENT_TEMPLATE_IDS.join(" / ") + "）",
      );
      continue;
    }
    const override = validateTemplateOverride(raw, id, sink);
    if (!override) continue;
    if (Object.keys(override).length === 0) {
      sink.warnings.push("templates." + id + " 没有可合并的字段，已忽略");
      continue;
    }
    templates[id] = applyTemplateOverride(base.templates[id], override);
    applied.push(id);
  }
  return resultOf(createTemplateRegistry(templates), applied, sink);
}
