"""docx_math.py — Office Math (OMML) → LaTeX conversion helpers.

Shared by doc_extract.py (Markdown import) and docx_preview.py (HTML preview).
Only depends on lxml, which ships with python-docx.

Coverage: m:r text, m:f fractions, m:sSup/m:sSub/m:sSubSup, m:rad roots,
m:nary sums/integrals, m:d delimiters, m:func functions, m:acc accents,
m:bar bars, m:limLow/m:limUpp limits, m:eqArr equation arrays, m:m matrices,
m:groupChr groups, plus common Unicode math symbols mapped to LaTeX commands.
Unknown structures degrade to their inner text instead of being dropped.
"""

from lxml import etree

NS_M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def local_name(element):
    """Local tag name without the namespace (e.g. 'oMath')."""
    try:
        return etree.QName(element.tag).localname
    except (TypeError, ValueError):
        return ""


def _m(attr):
    return "{%s}%s" % (NS_M, attr)


def _w(attr):
    return "{%s}%s" % (NS_W, attr)


# Unicode math symbols → LaTeX commands (single character entries).
SYMBOL_MAP = {
    # Greek lowercase
    "α": r"\alpha ", "β": r"\beta ", "γ": r"\gamma ", "δ": r"\delta ",
    "ε": r"\epsilon ", "ϵ": r"\epsilon ", "ζ": r"\zeta ", "η": r"\eta ",
    "θ": r"\theta ", "ϑ": r"\vartheta ", "ι": r"\iota ", "κ": r"\kappa ",
    "λ": r"\lambda ", "μ": r"\mu ", "ν": r"\nu ", "ξ": r"\xi ",
    "ο": "o", "π": r"\pi ", "ϖ": r"\varpi ", "ρ": r"\rho ", "σ": r"\sigma ",
    "ς": r"\varsigma ", "τ": r"\tau ", "υ": r"\upsilon ", "φ": r"\phi ",
    "ϕ": r"\varphi ", "χ": r"\chi ", "ψ": r"\psi ", "ω": r"\omega ",
    # Greek uppercase
    "Γ": r"\Gamma ", "Δ": r"\Delta ", "Θ": r"\Theta ", "Λ": r"\Lambda ",
    "Ξ": r"\Xi ", "Π": r"\Pi ", "Σ": r"\Sigma ", "Φ": r"\Phi ",
    "Ψ": r"\Psi ", "Ω": r"\Omega ",
    # Operators / relations
    "∑": r"\sum ", "∏": r"\prod ", "∫": r"\int ", "∬": r"\iint ",
    "∭": r"\iiint ", "∮": r"\oint ", "⋃": r"\bigcup ", "⋂": r"\bigcap ",
    "≤": r"\leq ", "≥": r"\geq ", "≠": r"\neq ", "≈": r"\approx ",
    "≡": r"\equiv ", "∞": r"\infty ", "→": r"\to ", "←": r"\leftarrow ",
    "↔": r"\leftrightarrow ", "⇒": r"\Rightarrow ", "⇔": r"\Leftrightarrow ",
    "×": r"\times ", "·": r"\cdot ", "±": r"\pm ", "∓": r"\mp ",
    "∂": r"\partial ", "∇": r"\nabla ", "∈": r"\in ", "∉": r"\notin ",
    "⊂": r"\subset ", "⊃": r"\supset ", "⊆": r"\subseteq ", "⊇": r"\supseteq ",
    "∀": r"\forall ", "∃": r"\exists ", "∅": r"\emptyset ", "√": r"\sqrt ",
    "∠": r"\angle ", "∴": r"\therefore ", "∵": r"\because ", "∘": r"\circ ",
    "…": r"\ldots ", "⋯": r"\cdots ", "∗": "*", "′": "'", "″": "''",
}

NARY_COMMANDS = {
    "∑": r"\sum", "∏": r"\prod", "∫": r"\int", "∬": r"\iint",
    "∭": r"\iiint", "∮": r"\oint", "⋃": r"\bigcup", "⋂": r"\bigcap",
    "∐": r"\coprod", "⨁": r"\bigoplus", "⨂": r"\bigotimes",
}

ACCENT_COMMANDS = {
    "\u0302": r"\hat", "\u0304": r"\bar", "\u0303": r"\tilde",
    "\u0307": r"\dot", "\u0308": r"\ddot", "\u0305": r"\overline",
    "\u20d7": r"\vec", "\u030c": r"\check", "\u0301": r"\acute",
    "\u0300": r"\grave", "\u0306": r"\breve",
}


def _map_symbols(text):
    if not text:
        return ""
    out = []
    for character in text:
        mapped = SYMBOL_MAP.get(character)
        out.append(character if mapped is None else mapped)
    return "".join(out)


def _text_of(element):
    """Concatenate all m:t descendants (OMML runs can nest inside m:r)."""
    parts = []
    for node in element.iter():
        if local_name(node) == "t" and node.text:
            parts.append(node.text)
    return "".join(parts)


def _is_property(element):
    return local_name(element).endswith("Pr")


def _child(element, name):
    for child in element:
        if local_name(child) == name:
            return child
    return None


def _children(element, name):
    return [child for child in element if local_name(child) == name]


def _prop_val(properties, name, default=""):
    """Read <m:name m:val="..."/> from a property container (dPr/naryPr/…)."""
    child = _child(properties, name)
    if child is None:
        return default
    value = child.get(_m("val"))
    return value if value is not None else default


def _brace(text):
    return "{" + (text or "") + "}"


def _convert_children(element):
    return "".join(convert(child) for child in element if not _is_property(child))


def _convert_delimiter(element):
    properties = _child(element, "dPr")
    begin = _prop_val(properties, "begChr", "(") or "."
    end = _prop_val(properties, "endChr", ")") or "."
    separator = _prop_val(properties, "sepChr", "|")
    parts = [convert(item) for item in _children(element, "e")]
    return r"\left" + begin + separator.join(parts) + r"\right" + end


def _convert_nary(element):
    properties = _child(element, "naryPr")
    char = _prop_val(properties, "chr", "∫")
    command = NARY_COMMANDS.get(char, r"\int")
    lower = _child(element, "sub")
    upper = _child(element, "sup")
    body = _child(element, "e")
    lower_hidden = _prop_val(properties, "subHide", "0") in ("1", "on", "true")
    upper_hidden = _prop_val(properties, "supHide", "0") in ("1", "on", "true")
    out = command
    lower_text = convert(lower) if lower is not None else ""
    upper_text = convert(upper) if upper is not None else ""
    if lower_text and not lower_hidden:
        out += "_" + _brace(lower_text)
    if upper_text and not upper_hidden:
        out += "^" + _brace(upper_text)
    if body is not None:
        body_text = convert(body)
        if body_text:
            out += " " + _brace(body_text)
    return out


def _convert_matrix(element):
    rows = []
    for row in _children(element, "mr"):
        cells = [convert(cell) for cell in _children(row, "e")]
        rows.append(" & ".join(cells))
    return r"\begin{matrix}" + r" \\ ".join(rows) + r"\end{matrix}"


def _convert_equation_array(element):
    rows = [convert(row) for row in _children(element, "e")]
    return r"\begin{aligned}" + r" \\ ".join(rows) + r"\end{aligned}"


def _convert_acc(element):
    properties = _child(element, "accPr")
    char = _prop_val(properties, "chr", "\u0302")
    command = ACCENT_COMMANDS.get(char, r"\hat")
    body = _child(element, "e")
    return command + _brace(convert(body) if body is not None else "")


def _convert_bar(element):
    properties = _child(element, "barPr")
    position = _prop_val(properties, "pos", "top")
    command = r"\underline" if position == "bottom" else r"\overline"
    body = _child(element, "e")
    return command + _brace(convert(body) if body is not None else "")


def convert(element):
    """Convert one OMML element to LaTeX (without surrounding math delimiters)."""
    if element is None:
        return ""
    name = local_name(element)
    if name in ("oMath", "oMathPara"):
        return _convert_children(element)
    if name == "r":
        return _map_symbols(_text_of(element))
    if name == "t":
        return _map_symbols(element.text or "")
    if name in ("e", "num", "den", "sup", "sub", "lim", "deg", "fName", "box"):
        return _convert_children(element)
    if name == "f":
        return r"\frac" + _brace(convert(_child(element, "num"))) + _brace(
            convert(_child(element, "den"))
        )
    if name == "sSup":
        return convert(_child(element, "e")) + "^" + _brace(convert(_child(element, "sup")))
    if name == "sSub":
        return convert(_child(element, "e")) + "_" + _brace(convert(_child(element, "sub")))
    if name == "sSubSup":
        return (
            convert(_child(element, "e"))
            + "_" + _brace(convert(_child(element, "sub")))
            + "^" + _brace(convert(_child(element, "sup")))
        )
    if name == "rad":
        degree = convert(_child(element, "deg")).strip()
        body = convert(_child(element, "e"))
        if degree:
            return r"\sqrt[" + degree + "]" + _brace(body)
        return r"\sqrt" + _brace(body)
    if name == "nary":
        return _convert_nary(element)
    if name == "d":
        return _convert_delimiter(element)
    if name == "func":
        function_name = convert(_child(element, "fName")).strip()
        body = convert(_child(element, "e"))
        return (function_name or r"\operatorname{f}") + "(" + body + ")"
    if name == "acc":
        return _convert_acc(element)
    if name == "bar":
        return _convert_bar(element)
    if name == "limLow":
        return convert(_child(element, "e")) + "_" + _brace(convert(_child(element, "lim")))
    if name == "limUpp":
        return convert(_child(element, "e")) + "^" + _brace(convert(_child(element, "lim")))
    if name == "eqArr":
        return _convert_equation_array(element)
    if name == "m":
        return _convert_matrix(element)
    if name == "mr":
        return " & ".join(convert(cell) for cell in _children(element, "e"))
    if name == "groupChr":
        return convert(_child(element, "e"))
    # Unknown wrapper (borderBox, phant, sPre, …): keep inner content.
    return _convert_children(element)


def omml_latex(element):
    """Bare LaTeX for one OMML element (no $ delimiters)."""
    return convert(element).strip()


def omml_to_latex(element, display=False):
    """LaTeX wrapped in $...$ (inline) or $$...$$ (display)."""
    latex = omml_latex(element)
    if not latex:
        return ""
    if display:
        return "$$" + latex + "$$"
    return "$" + latex + "$"


def _word_run_text(run_element):
    parts = []
    for node in run_element.iter():
        name = local_name(node)
        if name == "t" and node.text:
            parts.append(node.text)
        elif name == "tab":
            parts.append("\t")
        elif name in ("br", "cr"):
            parts.append("\n")
    return "".join(parts)


def paragraph_text(paragraph):
    """Paragraph text in document order with OMML replaced by $...$/$$...$$."""
    element = getattr(paragraph, "_p", paragraph)
    parts = []
    for child in element.iterchildren():
        name = local_name(child)
        if name == "r":
            parts.append(_word_run_text(child))
        elif name == "hyperlink":
            for run in child.iterchildren():
                if local_name(run) == "r":
                    parts.append(_word_run_text(run))
        elif name == "oMath":
            parts.append(omml_to_latex(child, display=False))
        elif name == "oMathPara":
            parts.append(omml_to_latex(child, display=True))
    return "".join(parts)
