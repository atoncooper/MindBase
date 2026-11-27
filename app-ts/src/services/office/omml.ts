/**
 * LaTeX (practical math subset) -> OMML (Office Math Markup Language).
 *
 * Why a standalone module: a DOCX renderer that only understands frac/sqrt/scripts
 * forces authors to accept math-looking text. Word treats a formula as real,
 * editable math only when the XML is a genuine m:oMath tree, so this module maps a
 * wider LaTeX subset onto real OMML constructs: fractions, radicals with degree,
 * sub/superscripts, n-ary operators with limits (sum/product/integral), matrices
 * and multi-line layouts (matrix/pmatrix/bmatrix/vmatrix/aligned/cases), scalable
 * delimiters (\left...\right), text annotations (\text) and overlines.
 *
 * Contract: latexToOmml() returns "<m:oMath>...</m:oMath>" or undefined. It is a
 * total function: unknown commands, unbalanced input, over-long input and
 * pathological nesting all degrade to undefined instead of throwing broken OMML at
 * the caller (the renderer falls back to the formula's plain-text form).
 *
 * No external parser or dependency is used: the grammar is small enough for a hand
 * written recursive-descent parser and the app must not grow a math dependency.
 *
 * Scope: one math expression only. No document preamble, macros, \newcommand or
 * alignment of numbered equations.
 */

/** Hard input cap: bigger strings are treated as unsupported (return undefined). */
export const MAX_LATEX_LENGTH = 2000;

/** Nesting guard; MAX_LATEX_LENGTH alone would still allow ~1000 nested groups. */
const MAX_NESTING = 120;

const MATH_RUN_FONTS = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>';

function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** One math run. w:rPr is exactly what Word writes for Cambria Math. */
function mathRun(text: string): string {
  return "<m:r>" + MATH_RUN_FONTS + '<m:t xml:space="preserve">' + escapeXml(text) + "</m:t></m:r>";
}

/** Normal (non-math) run, used by \text{...} so Chinese/prose keeps its own font. */
function normalTextRun(text: string): string {
  return "<m:r><m:rPr><m:nor/></m:rPr>" + MATH_RUN_FONTS + '<m:t xml:space="preserve">' + escapeXml(text) + "</m:t></m:r>";
}

/** Upright run for function names (\sin, \lim, ...). */
function uprightRun(text: string): string {
  return '<m:r><m:rPr><m:sty m:val="p"/></m:rPr>' + MATH_RUN_FONTS + '<m:t xml:space="preserve">' + escapeXml(text) + "</m:t></m:r>";
}

/** Greek letters, relations, operators, arrows, dots and standalone delimiters. */
const SYMBOLS: Readonly<Record<string, string>> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  omicron: "ο",
  pi: "π",
  varpi: "ϖ",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  neq: "≠",
  approx: "≈",
  sim: "∼",
  simeq: "≃",
  cong: "≅",
  equiv: "≡",
  propto: "∝",
  ll: "≪",
  gg: "≫",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  perp: "⊥",
  parallel: "∥",
  mid: "|",
  nmid: "∤",
  times: "×",
  cdot: "·",
  div: "÷",
  pm: "±",
  mp: "∓",
  ast: "∗",
  star: "⋆",
  circ: "∘",
  bullet: "∙",
  oplus: "⊕",
  otimes: "⊗",
  cup: "∪",
  cap: "∩",
  setminus: "∖",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  forall: "∀",
  exists: "∃",
  nexists: "∄",
  emptyset: "∅",
  varnothing: "∅",
  therefore: "∴",
  because: "∵",
  angle: "∠",
  degree: "°",
  prime: "′",
  ell: "ℓ",
  hbar: "ℏ",
  Re: "ℜ",
  Im: "ℑ",
  aleph: "ℵ",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  gets: "←",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  implies: "⇒",
  iff: "⇔",
  mapsto: "↦",
  uparrow: "↑",
  downarrow: "↓",
  longrightarrow: "⟶",
  longleftarrow: "⟵",
  cdots: "⋯",
  ldots: "…",
  dots: "…",
  vdots: "⋮",
  ddots: "⋱",
  langle: "⟨",
  rangle: "⟩",
  lfloor: "⌊",
  rfloor: "⌋",
  lceil: "⌈",
  rceil: "⌉",
  lbrace: "{",
  rbrace: "}",
  lvert: "|",
  rvert: "|",
  vert: "|",
  lVert: "‖",
  rVert: "‖",
  Vert: "‖",
};

/** Spacing commands; empty value means "consume but emit nothing". */
const SPACES: Readonly<Record<string, string>> = {
  ",": "\u2009",
  thinspace: "\u2009",
  ":": "\u2005",
  ">": "\u2005",
  ";": "\u2004",
  "!": "",
  " ": "\u00a0",
  quad: "\u2003",
  qquad: "\u2003\u2003",
  enspace: "\u2002",
};

/** Escaped literal characters (\{ \} \% \_ \& \# \$ \|). */
const ESCAPED: Readonly<Record<string, string>> = {
  "{": "{",
  "}": "}",
  "%": "%",
  _: "_",
  "&": "&",
  "#": "#",
  $: "$",
  "|": "‖",
};

const FUNCTIONS = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "arcsin",
  "arccos",
  "arctan",
  "sinh",
  "cosh",
  "tanh",
  "log",
  "ln",
  "lg",
  "exp",
  "det",
  "dim",
  "gcd",
  "ker",
  "hom",
  "lim",
  "limsup",
  "liminf",
  "max",
  "min",
  "sup",
  "inf",
  "arg",
  "deg",
  "mod",
  "bmod",
]);

interface NarySpec {
  chr: string;
  limLoc: "undOvr" | "subSup";
}

/** n-ary operators become m:nary (limits above/below for big operators, sub/sup for integrals). */
const NARY: Readonly<Record<string, NarySpec>> = {
  sum: { chr: "∑", limLoc: "undOvr" },
  prod: { chr: "∏", limLoc: "undOvr" },
  coprod: { chr: "∐", limLoc: "undOvr" },
  bigcup: { chr: "⋃", limLoc: "undOvr" },
  bigcap: { chr: "⋂", limLoc: "undOvr" },
  int: { chr: "∫", limLoc: "subSup" },
  iint: { chr: "∬", limLoc: "subSup" },
  iiint: { chr: "∭", limLoc: "subSup" },
  oint: { chr: "∮", limLoc: "subSup" },
};

/** Matrix environments and their OMML delimiters (null = no m:d wrapper). */
const MATRIX_DELIMITERS: Readonly<Record<string, [string, string] | null>> = {
  matrix: null,
  pmatrix: ["(", ")"],
  bmatrix: ["[", "]"],
  vmatrix: ["|", "|"],
};

/** \left / \right delimiters (command names and single characters). */
const DELIMITERS: Readonly<Record<string, string>> = {
  "(": "(",
  ")": ")",
  "[": "[",
  "]": "]",
  "|": "|",
  ".": "",
  "<": "⟨",
  ">": "⟩",
  "/": "/",
  "{": "{",
  "}": "}",
  "\\": "‖",
  lbrace: "{",
  rbrace: "}",
  lbrack: "[",
  rbrack: "]",
  langle: "⟨",
  rangle: "⟩",
  lfloor: "⌊",
  rfloor: "⌋",
  lceil: "⌈",
  rceil: "⌉",
  vert: "|",
  lvert: "|",
  rvert: "|",
  Vert: "‖",
  lVert: "‖",
  rVert: "‖",
};

/** Splits environment content on top-level row (\) or column (&) separators. */
function splitTopLevel(raw: string, separator: "row" | "col"): string[] {
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;
  let environmentDepth = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index] as string;
    if (ch === "\\") {
      const next = raw[index + 1] ?? "";
      if (next === "\\") {
        if (separator === "row" && braceDepth === 0 && environmentDepth === 0) {
          parts.push(current);
          current = "";
        } else {
          current += "\\\\";
        }
        index += 1;
        continue;
      }
      if (raw.startsWith("\\begin{", index)) environmentDepth += 1;
      else if (raw.startsWith("\\end{", index)) environmentDepth = Math.max(0, environmentDepth - 1);
      current += "\\" + next;
      index += 1;
      continue;
    }
    if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "&" && separator === "col" && braceDepth === 0 && environmentDepth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Matrix/aligned rows may carry an optional spacing spec: "\\[2pt]". */
function stripRowOption(row: string): string {
  return row.replace(/^\s*\[[^\]]*\]/, "");
}

function splitRows(content: string): string[] {
  return splitTopLevel(content, "row")
    .map(stripRowOption)
    .filter((row) => row.trim() !== "");
}

function buildEqArr(lines: string[]): string {
  return "<m:eqArr>" + lines.map((line) => "<m:e>" + line + "</m:e>").join("") + "</m:eqArr>";
}

interface ParseContext {
  insideGroup: boolean;
  stopAtRight: boolean;
}

class LatexParser {
  private depth: number;

  constructor(
    private readonly source: string,
    depth = 0,
  ) {
    this.depth = depth;
  }

  /** Top-level entry: every failure becomes undefined (never throws). */
  parse(): string | undefined {
    try {
      const xml = this.atoms(false, false, true);
      if (this.index < this.source.length) return undefined;
      return xml === "" ? undefined : xml;
    } catch {
      return undefined;
    }
  }

  /** Sub-expression entry (matrix cell / alignment line); throws so the outer parse degrades. */
  parseFragment(): string {
    if (this.depth > MAX_NESTING) throw new Error("expression nested too deeply");
    const xml = this.atoms(false, false, true);
    if (this.index < this.source.length) throw new Error("unexpected trailing input");
    return xml;
  }

  private index = 0;

  private atoms(insideGroup: boolean, stopAtRight: boolean, consumeClose: boolean): string {
    const atoms: string[] = [];
    let text = "";
    const flush = (): void => {
      if (text !== "") {
        atoms.push(mathRun(text));
        text = "";
      }
    };
    while (this.index < this.source.length) {
      const ch = this.source[this.index] as string;
      if (ch === "}") {
        if (!insideGroup) throw new Error("unbalanced closing brace");
        flush();
        if (consumeClose) this.index += 1;
        return atoms.join("");
      }
      if (ch === "{") {
        flush();
        this.index += 1;
        this.enterNesting();
        let inner: string;
        try {
          inner = this.atoms(true, false, true);
        } finally {
          this.leaveNesting();
        }
        if (inner === "") throw new Error("empty group");
        atoms.push(inner);
        continue;
      }
      if (ch === "&") throw new Error("alignment tab outside an environment");
      if (ch === "\\") {
        const name = this.peekCommandName();
        if (name === "right") {
          if (!stopAtRight) throw new Error("\\right without \\left");
          flush();
          return atoms.join("");
        }
        flush();
        this.consumeCommand(name);
        if (Object.hasOwn(NARY, name)) {
          atoms.push(this.parseNary(name, insideGroup, stopAtRight));
          continue;
        }
        atoms.push(this.execute(name, { insideGroup, stopAtRight }));
        continue;
      }
      if (ch === "^" || ch === "_") {
        // Scripts bind to the last atom; split a trailing text run so "ab^2" is b^2.
        if (text !== "") {
          text = text.replace(/ +$/, "");
          if (text !== "") {
            if (text.length > 1) atoms.push(mathRun(text.slice(0, -1)));
            atoms.push(mathRun(text.slice(-1)));
          }
          text = "";
        }
        const base = atoms.pop();
        if (base === undefined) throw new Error("script without a base");
        atoms.push(this.parseScript(base, { insideGroup, stopAtRight }));
        continue;
      }
      if (/\s/.test(ch)) {
        if (text !== "" && !text.endsWith(" ")) text += " ";
        this.index += 1;
        continue;
      }
      text += ch;
      this.index += 1;
    }
    if (insideGroup) throw new Error("missing closing brace");
    flush();
    return atoms.join("");
  }

  private parseScript(base: string, ctx: ParseContext): string {
    let sub: string | undefined;
    let sup: string | undefined;
    while (this.index < this.source.length) {
      const ch = this.source[this.index] as string;
      if (ch === "^") {
        if (sup !== undefined) throw new Error("duplicate superscript");
        this.index += 1;
        sup = this.parseArgument(ctx);
        continue;
      }
      if (ch === "_") {
        if (sub !== undefined) throw new Error("duplicate subscript");
        this.index += 1;
        sub = this.parseArgument(ctx);
        continue;
      }
      break;
    }
    if (sub !== undefined && sup !== undefined) {
      return "<m:sSubSup><m:e>" + base + "</m:e><m:sub>" + sub + "</m:sub><m:sup>" + sup + "</m:sup></m:sSubSup>";
    }
    if (sub !== undefined) return "<m:sSub><m:e>" + base + "</m:e><m:sub>" + sub + "</m:sub></m:sSub>";
    if (sup !== undefined) return "<m:sSup><m:e>" + base + "</m:e><m:sup>" + sup + "</m:sup></m:sSup>";
    return base;
  }

  private parseArgument(ctx: ParseContext): string {
    this.skipSpaces();
    if (this.index >= this.source.length) throw new Error("missing argument");
    const ch = this.source[this.index] as string;
    if (ch === "{") {
      this.index += 1;
      this.enterNesting();
      let inner: string;
      try {
        inner = this.atoms(true, false, true);
      } finally {
        this.leaveNesting();
      }
      if (inner === "") throw new Error("empty argument");
      return inner;
    }
    if (ch === "\\") {
      const name = this.peekCommandName();
      if (name === "right") throw new Error("misplaced \\right");
      this.consumeCommand(name);
      if (Object.hasOwn(NARY, name)) return this.parseNary(name, ctx.insideGroup, ctx.stopAtRight);
      const xml = this.execute(name, ctx);
      if (xml === "") throw new Error("empty argument");
      return xml;
    }
    if (ch === "}" || ch === "^" || ch === "_" || ch === "&") throw new Error("bad argument");
    this.index += 1;
    return mathRun(ch);
  }

  /** n-ary operator: optional _/^ limits, then the operand (rest of the current expression). */
  private parseNary(name: string, insideGroup: boolean, stopAtRight: boolean): string {
    const spec = NARY[name] as NarySpec;
    const ctx: ParseContext = { insideGroup, stopAtRight };
    let sub: string | undefined;
    let sup: string | undefined;
    while (this.index < this.source.length) {
      const ch = this.source[this.index] as string;
      if (ch === "_" && sub === undefined) {
        this.index += 1;
        sub = this.parseArgument(ctx);
        continue;
      }
      if (ch === "^" && sup === undefined) {
        this.index += 1;
        sup = this.parseArgument(ctx);
        continue;
      }
      break;
    }
    const body = this.atoms(insideGroup, stopAtRight, false);
    const chr = '<m:chr m:val="' + escapeXml(spec.chr) + '"/>';
    const limLoc = '<m:limLoc m:val="' + spec.limLoc + '"/>';
    const hideSub = sub === undefined ? '<m:subHide m:val="1"/>' : "";
    const hideSup = sup === undefined ? '<m:supHide m:val="1"/>' : "";
    return (
      "<m:nary><m:naryPr>" +
      chr +
      limLoc +
      hideSub +
      hideSup +
      "</m:naryPr><m:sub>" +
      (sub ?? "") +
      "</m:sub><m:sup>" +
      (sup ?? "") +
      "</m:sup><m:e>" +
      body +
      "</m:e></m:nary>"
    );
  }

  private execute(name: string, ctx: ParseContext): string {
    switch (name) {
      case "frac":
      case "dfrac":
      case "tfrac": {
        const numerator = this.parseArgument(ctx);
        const denominator = this.parseArgument(ctx);
        return (
          '<m:f><m:fPr><m:type m:val="bar"/></m:fPr><m:num>' +
          numerator +
          "</m:num><m:den>" +
          denominator +
          "</m:den></m:f>"
        );
      }
      case "sqrt": {
        this.skipSpaces();
        let degree: string | undefined;
        if (this.source[this.index] === "[") degree = this.readBracketExpression();
        const body = this.parseArgument(ctx);
        if (degree === undefined) {
          return '<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>' + body + "</m:e></m:rad>";
        }
        return (
          '<m:rad><m:radPr><m:degHide m:val="0"/></m:radPr><m:deg>' +
          degree +
          "</m:deg><m:e>" +
          body +
          "</m:e></m:rad>"
        );
      }
      case "text":
      case "textnormal":
      case "mbox": {
        const raw = this.readRawGroup();
        if (raw === "") throw new Error("empty text");
        return normalTextRun(raw);
      }
      case "overline":
      case "bar": {
        const body = this.parseArgument(ctx);
        return '<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>' + body + "</m:e></m:bar>";
      }
      case "underline": {
        const body = this.parseArgument(ctx);
        return '<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e>' + body + "</m:e></m:bar>";
      }
      case "left":
        return this.parseLeft();
      case "begin":
        return this.parseEnvironment();
      default:
        break;
    }
    if (Object.hasOwn(SPACES, name)) return SPACES[name] === "" ? "" : mathRun(SPACES[name] as string);
    if (Object.hasOwn(ESCAPED, name)) {
      if (name === "\\") throw new Error("line break outside an environment");
      return mathRun(ESCAPED[name] as string);
    }
    const symbol: string | undefined = SYMBOLS[name];
    if (symbol !== undefined) return mathRun(symbol);
    if (FUNCTIONS.has(name)) return uprightRun(name);
    throw new Error("unsupported command: \\" + name);
  }

  private parseLeft(): string {
    const begin = this.readDelimiter();
    this.enterNesting();
    let inner: string;
    try {
      inner = this.atoms(false, true, true);
    } finally {
      this.leaveNesting();
    }
    if (!this.source.startsWith("\\right", this.index)) throw new Error("\\left without \\right");
    this.index += "\\right".length;
    const end = this.readDelimiter();
    return (
      '<m:d><m:dPr><m:begChr m:val="' +
      escapeXml(begin) +
      '"/><m:endChr m:val="' +
      escapeXml(end) +
      '"/></m:dPr><m:e>' +
      inner +
      "</m:e></m:d>"
    );
  }

  private parseEnvironment(): string {
    const env = this.readRawGroup();
    const contentStart = this.index;
    let cursor = this.index;
    let nesting = 1;
    while (cursor < this.source.length) {
      if (this.source[cursor] !== "\\") {
        cursor += 1;
        continue;
      }
      if (this.source.startsWith("\\begin{", cursor)) {
        const nameEnd = this.source.indexOf("}", cursor + "\\begin{".length);
        if (nameEnd < 0) throw new Error("unterminated \\begin");
        nesting += 1;
        cursor = nameEnd + 1;
        continue;
      }
      if (this.source.startsWith("\\end{", cursor)) {
        const nameEnd = this.source.indexOf("}", cursor + "\\end{".length);
        if (nameEnd < 0) throw new Error("unterminated \\end");
        const closed = this.source.slice(cursor + "\\end{".length, nameEnd);
        nesting -= 1;
        if (nesting === 0) {
          if (closed !== env) throw new Error("environment mismatch");
          const content = this.source.slice(contentStart, cursor);
          this.index = nameEnd + 1;
          return this.buildEnvironment(env, content);
        }
        cursor = nameEnd + 1;
        continue;
      }
      cursor += 2;
    }
    throw new Error("missing \\end{" + env + "}");
  }

  private buildEnvironment(env: string, content: string): string {
    if (Object.hasOwn(MATRIX_DELIMITERS, env)) return this.buildMatrix(env, content);
    if (env === "aligned" || env === "split" || env === "gathered") {
      return buildEqArr(this.buildLines(content));
    }
    if (env === "cases") {
      return (
        '<m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=""/></m:dPr><m:e>' +
        buildEqArr(this.buildLines(content)) +
        "</m:e></m:d>"
      );
    }
    throw new Error("unsupported environment: " + env);
  }

  private buildMatrix(env: string, content: string): string {
    const rows = splitRows(content);
    if (rows.length === 0) throw new Error("empty matrix");
    const cells = rows.map((row) => splitTopLevel(row, "col"));
    const columns = Math.max(1, ...cells.map((row) => row.length));
    const mc =
      "<m:mc><m:mcPr><m:count m:val=\"" +
      columns +
      '"/><m:mcJc m:val="center"/></m:mcPr></m:mc>';
    const body = cells
      .map((row) => {
        const rowXml = Array.from(
          { length: columns },
          (_, column) => "<m:e>" + this.cellXml(row[column] ?? "") + "</m:e>",
        ).join("");
        return "<m:mr>" + rowXml + "</m:mr>";
      })
      .join("");
    const matrix = "<m:m><m:mPr><m:mcs>" + mc + "</m:mcs></m:mPr>" + body + "</m:m>";
    const delimiters = MATRIX_DELIMITERS[env];
    if (!delimiters) return matrix;
    return (
      '<m:d><m:dPr><m:begChr m:val="' +
      escapeXml(delimiters[0]) +
      '"/><m:endChr m:val="' +
      escapeXml(delimiters[1]) +
      '"/></m:dPr><m:e>' +
      matrix +
      "</m:e></m:d>"
    );
  }

  private buildLines(content: string): string[] {
    const rows = splitRows(content);
    if (rows.length === 0) throw new Error("empty environment");
    return rows.map((row) =>
      splitTopLevel(row, "col")
        .map((cell) => this.cellXml(cell))
        .join(""),
    );
  }

  private cellXml(raw: string): string {
    if (raw.trim() === "") return "";
    return new LatexParser(raw, this.depth + 1).parseFragment();
  }

  private readRawGroup(): string {
    this.skipSpaces();
    if (this.source[this.index] !== "{") throw new Error("expected {");
    this.index += 1;
    let depth = 1;
    let raw = "";
    while (this.index < this.source.length) {
      const ch = this.source[this.index] as string;
      if (ch === "\\") {
        const next = this.source[this.index + 1];
        if (next !== undefined && "{}%_&#$".includes(next)) {
          raw += next;
          this.index += 2;
          continue;
        }
        raw += "\\";
        this.index += 1;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        raw += ch;
        this.index += 1;
        continue;
      }
      if (ch === "}") {
        depth -= 1;
        this.index += 1;
        if (depth === 0) return raw;
        raw += ch;
        continue;
      }
      raw += ch;
      this.index += 1;
    }
    throw new Error("unterminated group");
  }

  private readBracketExpression(): string {
    if (this.source[this.index] !== "[") throw new Error("expected [");
    this.index += 1;
    const start = this.index;
    let braceDepth = 0;
    while (this.index < this.source.length) {
      const ch = this.source[this.index] as string;
      if (ch === "\\") {
        this.index += 2;
        continue;
      }
      if (ch === "{") braceDepth += 1;
      else if (ch === "}") braceDepth -= 1;
      else if (ch === "]" && braceDepth === 0) {
        const raw = this.source.slice(start, this.index);
        this.index += 1;
        if (raw.trim() === "") throw new Error("empty root degree");
        return new LatexParser(raw, this.depth + 1).parseFragment();
      }
      this.index += 1;
    }
    throw new Error("unterminated optional argument");
  }

  private readDelimiter(): string {
    this.skipSpaces();
    if (this.index >= this.source.length) throw new Error("missing delimiter");
    const ch = this.source[this.index] as string;
    let key: string;
    if (ch === "\\") {
      key = this.peekCommandName();
      this.consumeCommand(key);
    } else {
      key = ch;
      this.index += 1;
    }
    const mapped: string | undefined = DELIMITERS[key];
    if (mapped === undefined) throw new Error("unsupported delimiter");
    return mapped;
  }

  private peekCommandName(): string {
    if (this.source[this.index] !== "\\") throw new Error("expected command");
    const next = this.source[this.index + 1];
    if (next === undefined) throw new Error("dangling backslash");
    if (/[a-zA-Z]/.test(next)) {
      let end = this.index + 1;
      while (end < this.source.length && /[a-zA-Z]/.test(this.source[end] as string)) end += 1;
      return this.source.slice(this.index + 1, end);
    }
    return next;
  }

  private consumeCommand(name: string): void {
    this.index += /^[a-zA-Z]+$/.test(name) ? 1 + name.length : 2;
  }

  private skipSpaces(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index] as string)) this.index += 1;
  }

  private enterNesting(): void {
    this.depth += 1;
    if (this.depth > MAX_NESTING) throw new Error("expression nested too deeply");
  }

  private leaveNesting(): void {
    this.depth -= 1;
  }
}

/**
 * Parses a practical LaTeX math subset into a display OMML block.
 * Returns undefined when the expression cannot be represented faithfully.
 */
export function latexToOmml(latex: string): string | undefined {
  if (typeof latex !== "string") return undefined;
  if (latex.length === 0 || latex.length > MAX_LATEX_LENGTH) return undefined;
  const xml = new LatexParser(latex).parse();
  return xml === undefined ? undefined : "<m:oMath>" + xml + "</m:oMath>";
}

/** True when latexToOmml would produce native OMML for the given expression. */
export function isLatexSupported(latex: string): boolean {
  return latexToOmml(latex) !== undefined;
}
