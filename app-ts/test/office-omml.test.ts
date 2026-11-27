import { describe, expect, it } from "vitest";

import { MAX_LATEX_LENGTH, isLatexSupported, latexToOmml } from "../src/services/office/omml.js";

/** Parses a supported formula and returns its XML (fails the test when unsupported). */
function toXml(latex: string): string {
  const xml = latexToOmml(latex);
  expect(xml).toBeDefined();
  return xml as string;
}

function countOf(xml: string, needle: string): number {
  return xml.split(needle).length - 1;
}

describe("omml: contract and plain text", () => {
  it("wraps supported formulas in a single m:oMath root", () => {
    const xml = toXml("x + 1");
    expect(xml.startsWith("<m:oMath>")).toBe(true);
    expect(xml.endsWith("</m:oMath>")).toBe(true);
    expect(countOf(xml, "<m:oMath>")).toBe(1);
  });

  it("returns undefined for empty and whitespace-only input", () => {
    expect(latexToOmml("")).toBeUndefined();
    expect(latexToOmml("   ")).toBeUndefined();
    expect(latexToOmml("\n\t")).toBeUndefined();
  });

  it("rejects input longer than the 2000 character cap", () => {
    expect(latexToOmml("x".repeat(MAX_LATEX_LENGTH + 1))).toBeUndefined();
  });

  it("accepts input exactly at the length cap", () => {
    const xml = toXml("x".repeat(MAX_LATEX_LENGTH));
    expect(countOf(xml, "<m:r>")).toBe(1);
  });

  it("returns undefined instead of throwing for non-string input", () => {
    expect(latexToOmml(undefined as unknown as string)).toBeUndefined();
    expect(latexToOmml(null as unknown as string)).toBeUndefined();
    expect(isLatexSupported(undefined as unknown as string)).toBe(false);
  });

  it("isLatexSupported mirrors latexToOmml", () => {
    expect(isLatexSupported("\\frac{a}{b}")).toBe(true);
    expect(isLatexSupported("x^2")).toBe(true);
    expect(isLatexSupported("\\unknowncommand")).toBe(false);
    expect(isLatexSupported("")).toBe(false);
  });

  it("renders plain text as m:r runs", () => {
    const xml = toXml("abc");
    expect(xml).toContain('<m:r><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr><m:t xml:space="preserve">abc</m:t></m:r>');
  });

  it("preserves single spaces inside plain math text", () => {
    expect(toXml("a + b")).toContain(">a + b</m:t>");
  });

  it("escapes XML special characters inside runs", () => {
    expect(toXml("a < b")).toContain("&lt;");
    expect(toXml("a \\& b")).toContain("&amp;");
  });

  it("ignores outer whitespace around the expression", () => {
    expect(toXml("   x   ")).toContain(">x");
  });
});

describe("omml: escaped literals and command tables", () => {
  it("renders escaped braces as literal characters", () => {
    const xml = toXml("\\{x\\}");
    expect(xml).toContain(">{</m:t>");
    expect(xml).toContain(">x</m:t>");
    expect(xml).toContain(">}</m:t>");
    expect(xml).not.toContain("<m:sSup>");
  });

  it("renders escaped percent and underscore", () => {
    const xml = toXml("50\\% a\\_b");
    expect(xml).toContain(">%</m:t>");
    expect(xml).toContain(">_</m:t>");
  });

  it("renders greek letters", () => {
    const greek: Array<[string, string]> = [
      ["alpha", "α"],
      ["beta", "β"],
      ["gamma", "γ"],
      ["delta", "δ"],
      ["theta", "θ"],
      ["lambda", "λ"],
      ["mu", "μ"],
      ["pi", "π"],
      ["sigma", "σ"],
      ["phi", "φ"],
      ["omega", "ω"],
      ["Delta", "Δ"],
      ["Sigma", "Σ"],
      ["Omega", "Ω"],
    ];
    for (const [command, symbol] of greek) {
      expect(toXml("\\" + command)).toContain(">" + symbol + "</m:t>");
    }
  });

  it("renders relations and operators", () => {
    const operators: Array<[string, string]> = [
      ["le", "≤"],
      ["ge", "≥"],
      ["ne", "≠"],
      ["times", "×"],
      ["cdot", "·"],
      ["pm", "±"],
      ["infty", "∞"],
      ["partial", "∂"],
      ["nabla", "∇"],
      ["approx", "≈"],
      ["equiv", "≡"],
    ];
    for (const [command, symbol] of operators) {
      expect(toXml("\\" + command)).toContain(">" + symbol + "</m:t>");
    }
  });

  it("renders arrows", () => {
    const arrows: Array<[string, string]> = [
      ["to", "→"],
      ["rightarrow", "→"],
      ["leftarrow", "←"],
      ["leftrightarrow", "↔"],
      ["Rightarrow", "⇒"],
      ["Leftrightarrow", "⇔"],
      ["mapsto", "↦"],
    ];
    for (const [command, symbol] of arrows) {
      expect(toXml("\\" + command)).toContain(">" + symbol + "</m:t>");
    }
  });

  it("renders function names upright", () => {
    const xml = toXml("\\sin x");
    expect(xml).toContain('<m:sty m:val="p"/>');
    expect(xml).toContain(">sin</m:t>");
    expect(xml).toContain(">x</m:t>");
  });

  it("returns undefined for unknown commands", () => {
    expect(latexToOmml("\\unknowncommand")).toBeUndefined();
    expect(latexToOmml("\\foo{x}")).toBeUndefined();
    expect(latexToOmml("a + \\whatever")).toBeUndefined();
  });

  it("returns undefined for a dangling backslash", () => {
    expect(latexToOmml("x\\")).toBeUndefined();
  });
});

describe("omml: fractions and radicals", () => {
  it("renders frac as m:f with numerator and denominator", () => {
    const xml = toXml("\\frac{a}{b}");
    expect(xml).toContain("<m:f>");
    expect(xml).toContain("<m:num>");
    expect(xml).toContain("<m:den>");
    expect(xml).toContain(">a</m:t>");
    expect(xml).toContain(">b</m:t>");
    expect(xml).toContain('<m:type m:val="bar"/>');
  });

  it("renders commands inside fractions", () => {
    const xml = toXml("\\frac{\\alpha}{\\beta}");
    expect(xml).toContain(">α</m:t>");
    expect(xml).toContain(">β</m:t>");
  });

  it("renders nested fractions", () => {
    const xml = toXml("\\frac{1}{\\frac{2}{3}}");
    expect(countOf(xml, "<m:f>")).toBe(2);
  });

  it("renders sqrt without a degree", () => {
    const xml = toXml("\\sqrt{x+1}");
    expect(xml).toContain("<m:rad>");
    expect(xml).toContain('<m:degHide m:val="1"/>');
    expect(xml).toContain(">x+1</m:t>");
  });

  it("renders sqrt with an explicit degree", () => {
    const xml = toXml("\\sqrt[3]{x}");
    expect(xml).toContain('<m:degHide m:val="0"/>');
    expect(xml).toContain("<m:deg>");
    expect(xml).toContain(">3</m:t>");
  });

  it("renders fractions nested in radicals", () => {
    const xml = toXml("\\frac{\\sqrt{x}}{2}");
    expect(xml).toContain("<m:f>");
    expect(xml).toContain("<m:rad>");
  });

  it("returns undefined for an incomplete frac", () => {
    expect(latexToOmml("\\frac{a}")).toBeUndefined();
    expect(latexToOmml("\\frac{}{b}")).toBeUndefined();
  });

  it("returns undefined for an empty sqrt argument", () => {
    expect(latexToOmml("\\sqrt{}")).toBeUndefined();
  });
});

describe("omml: scripts", () => {
  it("renders subscript as m:sSub", () => {
    const xml = toXml("x_1");
    expect(xml).toContain("<m:sSub>");
    expect(xml).toContain("<m:sub>");
    expect(xml).toContain(">1</m:t>");
  });

  it("renders superscript as m:sSup", () => {
    const xml = toXml("x^{2}");
    expect(xml).toContain("<m:sSup>");
    expect(xml).toContain("<m:sup>");
  });

  it("renders combined sub/superscript as m:sSubSup", () => {
    const xml = toXml("x_{i}^{2}");
    expect(xml).toContain("<m:sSubSup>");
    expect(xml).toContain("<m:sub>");
    expect(xml).toContain("<m:sup>");
  });

  it("accepts the reversed script order", () => {
    const xml = toXml("x^2_1");
    expect(xml).toContain("<m:sSubSup>");
    expect(xml).toContain(">1</m:t>");
    expect(xml).toContain(">2</m:t>");
  });

  it("renders a grouped subscript expression", () => {
    const xml = toXml("a_{i+1}");
    expect(xml).toContain("<m:sSub>");
    expect(xml).toContain(">i+1</m:t>");
  });

  it("binds scripts to the preceding character only", () => {
    const xml = toXml("E = mc^2");
    expect(xml).toContain("<m:sSup>");
    expect(xml).toContain(">c</m:t>");
    expect(xml).not.toContain(">mc</m:t>");
  });

  it("allows a command as the script base", () => {
    const xml = toXml("\\pi^2");
    expect(xml).toContain("<m:sSup>");
    expect(xml).toContain(">π</m:t>");
  });

  it("returns undefined for a script without a base", () => {
    expect(latexToOmml("^2")).toBeUndefined();
    expect(latexToOmml("_1")).toBeUndefined();
  });

  it("returns undefined for a missing script argument", () => {
    expect(latexToOmml("x^")).toBeUndefined();
    expect(latexToOmml("x_")).toBeUndefined();
  });
});

describe("omml: n-ary operators", () => {
  it("renders sum with limits as m:nary with undOvr limits", () => {
    const xml = toXml("\\sum_{i=1}^{n} a_i");
    expect(xml).toContain("<m:nary>");
    expect(xml).toContain('<m:chr m:val="∑"/>');
    expect(xml).toContain('<m:limLoc m:val="undOvr"/>');
    expect(xml).toContain("<m:sub>");
    expect(xml).toContain(">i=1</m:t>");
    expect(xml).toContain("<m:sup>");
    expect(xml).toContain("</m:nary>");
  });

  it("renders integral limits with subSup placement", () => {
    const xml = toXml("\\int_0^1 f(x)\\,dx");
    expect(xml).toContain('<m:chr m:val="∫"/>');
    expect(xml).toContain('<m:limLoc m:val="subSup"/>');
    expect(xml).toContain(">f(x)</m:t>");
  });

  it("renders product with limits", () => {
    const xml = toXml("\\prod_{k=1}^{n} k");
    expect(xml).toContain('<m:chr m:val="∏"/>');
    expect(xml).toContain("</m:nary>");
  });

  it("hides missing limits on a bare big operator", () => {
    const xml = toXml("\\sum x");
    expect(xml).toContain('<m:subHide m:val="1"/>');
    expect(xml).toContain('<m:supHide m:val="1"/>');
    expect(xml).toContain(">x</m:t>");
  });

  it("renders a bare integral", () => {
    expect(toXml("\\int")).toContain("<m:nary>");
  });

  it("renders n-ary operators inside fractions", () => {
    const xml = toXml("\\frac{\\sum_{i=1}^{n} a_i}{n}");
    expect(countOf(xml, "<m:f>")).toBe(1);
    expect(countOf(xml, "<m:nary>")).toBe(1);
    expect(xml.endsWith("</m:oMath>")).toBe(true);
  });
});

describe("omml: matrices", () => {
  it("renders matrix rows/cells as m:m / m:mr / m:e", () => {
    const xml = toXml("\\begin{matrix} a & b \\\\ c & d \\end{matrix}");
    expect(xml).toContain("<m:m>");
    expect(xml).toContain("<m:mcs>");
    expect(xml).toContain('<m:count m:val="2"/>');
    expect(countOf(xml, "<m:mr>")).toBe(2);
    expect(countOf(xml, "<m:e>")).toBe(4);
  });

  it("wraps pmatrix in parentheses", () => {
    const xml = toXml("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}");
    expect(xml).toContain('<m:begChr m:val="("/>');
    expect(xml).toContain('<m:endChr m:val=")"/>');
    expect(countOf(xml, "<m:mr>")).toBe(2);
  });

  it("wraps bmatrix in square brackets", () => {
    const xml = toXml("\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}");
    expect(xml).toContain('<m:begChr m:val="["/>');
    expect(xml).toContain('<m:endChr m:val="]"/>');
  });

  it("wraps vmatrix in vertical bars", () => {
    const xml = toXml("\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}");
    expect(xml).toContain('<m:begChr m:val="|"/>');
    expect(xml).toContain('<m:endChr m:val="|"/>');
  });

  it("renders formulas inside matrix cells", () => {
    const xml = toXml("\\begin{pmatrix}\\frac{1}{2} & x \\\\ y & z\\end{pmatrix}");
    expect(xml).toContain("<m:f>");
    expect(xml).toContain("<m:m>");
  });

  it("pads ragged rows to the widest row", () => {
    const xml = toXml("\\begin{matrix} a \\\\ b & c \\end{matrix}");
    expect(countOf(xml, "<m:mr>")).toBe(2);
    expect(countOf(xml, "<m:e>")).toBe(4);
    expect(xml).toContain("<m:e></m:e>");
  });

  it("renders nested matrices", () => {
    const xml = toXml("\\begin{pmatrix} 1 & \\begin{matrix} a & b \\end{matrix} \\end{pmatrix}");
    expect(countOf(xml, "<m:m>")).toBe(2);
  });

  it("returns undefined for an empty matrix", () => {
    expect(latexToOmml("\\begin{matrix}\\end{matrix}")).toBeUndefined();
  });

  it("returns undefined for an unterminated matrix", () => {
    expect(latexToOmml("\\begin{matrix} a")).toBeUndefined();
  });

  it("returns undefined for unsupported environments", () => {
    expect(latexToOmml("\\begin{array}{cc} a & b \\end{array}")).toBeUndefined();
  });
});

describe("omml: aligned and cases", () => {
  it("renders aligned rows as m:eqArr lines", () => {
    const xml = toXml("\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}");
    expect(xml).toContain("<m:eqArr>");
    expect(countOf(xml, "<m:e>")).toBe(2);
  });

  it("renders three aligned lines", () => {
    const xml = toXml("\\begin{aligned} x &= 1 \\\\ y &= 2 \\\\ z &= 3 \\end{aligned}");
    expect(countOf(xml, "<m:e>")).toBe(3);
  });

  it("renders cases as a left-brace m:d around m:eqArr", () => {
    const xml = toXml("\\begin{cases} x & x > 0 \\\\ -x & x \\le 0 \\end{cases}");
    expect(xml).toContain('<m:begChr m:val="{"/>');
    expect(xml).toContain('<m:endChr m:val=""/>');
    expect(xml).toContain("<m:eqArr>");
    expect(countOf(xml, "<m:e>")).toBe(3);
  });

  it("keeps text annotations inside cases", () => {
    const xml = toXml("\\begin{cases} 1 & \\text{if } x>0 \\\\ 0 & \\text{otherwise} \\end{cases}");
    expect(xml).toContain("<m:nor/>");
    expect(xml).toContain(">if </m:t>");
    expect(xml).toContain(">otherwise</m:t>");
  });
});

describe("omml: delimiters, text and overlines", () => {
  it("renders left/right parentheses as m:d", () => {
    const xml = toXml("\\left( \\frac{a}{b} \\right)");
    expect(xml).toContain("<m:d>");
    expect(xml).toContain('<m:begChr m:val="("/>');
    expect(xml).toContain('<m:endChr m:val=")"/>');
    expect(xml).toContain("<m:f>");
  });

  it("renders left/right square brackets", () => {
    const xml = toXml("\\left[ x \\right]");
    expect(xml).toContain('<m:begChr m:val="["/>');
    expect(xml).toContain('<m:endChr m:val="]"/>');
  });

  it("renders escaped braces as delimiters", () => {
    const xml = toXml("\\left\\{ x \\right\\}");
    expect(xml).toContain('<m:begChr m:val="{"/>');
    expect(xml).toContain('<m:endChr m:val="}"/>');
  });

  it("renders nested scalable delimiters", () => {
    const xml = toXml("\\left( \\left[ x \\right] \\right)");
    expect(countOf(xml, "<m:d>")).toBe(2);
  });

  it("supports an empty left delimiter", () => {
    const xml = toXml("\\left. \\frac{a}{b} \\right|");
    expect(xml).toContain('<m:begChr m:val=""/>');
    expect(xml).toContain('<m:endChr m:val="|"/>');
  });

  it("returns undefined for unmatched left/right", () => {
    expect(latexToOmml("\\left( x")).toBeUndefined();
    expect(latexToOmml("\\right)")).toBeUndefined();
  });

  it("renders text annotations as normal runs", () => {
    const xml = toXml("\\text{if }");
    expect(xml).toContain("<m:nor/>");
    expect(xml).toContain(">if </m:t>");
  });

  it("keeps CJK text intact in text annotations", () => {
    expect(toXml("\\text{中文 说明}")).toContain(">中文 说明</m:t>");
  });

  it("renders overline as m:bar above the expression", () => {
    const xml = toXml("\\overline{x+y}");
    expect(xml).toContain("<m:bar>");
    expect(xml).toContain('<m:pos m:val="top"/>');
    expect(xml).toContain(">x+y</m:t>");
  });

  it("renders bar as m:bar", () => {
    expect(toXml("\\bar{x}")).toContain("<m:bar>");
  });

  it("combines overline with a fraction", () => {
    const xml = toXml("\\overline{\\frac{a}{b}}");
    expect(xml).toContain("<m:bar>");
    expect(xml).toContain("<m:f>");
  });
});

describe("omml: robustness", () => {
  it("handles 50 nested fractions without stack overflow", () => {
    let latex = "x";
    for (let level = 0; level < 50; level += 1) latex = "\\frac{1}{" + latex + "}";
    const xml = toXml(latex);
    expect(countOf(xml, "<m:f>")).toBe(50);
  });

  it("handles 50 nested delimiters without stack overflow", () => {
    let latex = "x";
    for (let level = 0; level < 50; level += 1) latex = "\\left(" + latex + "\\right)";
    const xml = toXml(latex);
    expect(countOf(xml, "<m:d>")).toBe(50);
  });

  it("handles 50 nested groups without stack overflow", () => {
    const latex = "{".repeat(50) + "x" + "}".repeat(50);
    const xml = toXml(latex);
    expect(countOf(xml, "<m:r>")).toBe(1);
  });

  it("parses a 2000 character expression quickly", () => {
    const latex = "x+".repeat(999) + "xy";
    expect(latex.length).toBe(MAX_LATEX_LENGTH);
    const started = Date.now();
    expect(latexToOmml(latex)).toBeDefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("returns undefined for unbalanced braces", () => {
    expect(latexToOmml("{{x}")).toBeUndefined();
    expect(latexToOmml("\\frac{a}{b")).toBeUndefined();
    expect(latexToOmml("x}")).toBeUndefined();
  });

  it("returns undefined for a stray alignment tab", () => {
    expect(latexToOmml("a & b")).toBeUndefined();
  });
});
