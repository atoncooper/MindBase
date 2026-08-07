package service

import (
	"regexp"
	"sort"
	"strings"
)

// latexSymbol maps common LaTeX commands (no brace argument) to plain-text /
// Unicode equivalents for email rendering. Email clients cannot load KaTeX
// CSS/fonts, so math is down-converted to readable text.
var latexSymbol = map[string]string{
	`\to`:             `->`,
	`\rightarrow`:     `->`,
	`\Rightarrow`:     `=>`,
	`\Leftarrow`:      `<=`,
	`\leftrightarrow`: `<->`,
	`\mapsto`:         `|->`,
	`\infty`:          `∞`,
	`\pi`:             `π`,
	`\alpha`:          `α`,
	`\beta`:           `β`,
	`\gamma`:          `γ`,
	`\Gamma`:          `Γ`,
	`\delta`:          `δ`,
	`\Delta`:          `Δ`,
	`\theta`:          `θ`,
	`\lambda`:         `λ`,
	`\mu`:             `μ`,
	`\nu`:             `ν`,
	`\rho`:            `ρ`,
	`\sigma`:          `σ`,
	`\Sigma`:          `Σ`,
	`\tau`:            `τ`,
	`\phi`:            `φ`,
	`\varphi`:         `φ`,
	`\omega`:          `ω`,
	`\Omega`:          `Ω`,
	`\epsilon`:        `ε`,
	`\varepsilon`:     `ε`,
	`\partial`:        `∂`,
	`\nabla`:          `∇`,
	`\leq`:            `≤`,
	`\le`:             `≤`,
	`\geq`:            `≥`,
	`\ge`:             `≥`,
	`\neq`:            `≠`,
	`\ne`:             `≠`,
	`\approx`:         `≈`,
	`\equiv`:          `≡`,
	`\sim`:            `~`,
	`\pm`:             `±`,
	`\mp`:             `∓`,
	`\times`:          `×`,
	`\cdot`:           `·`,
	`\div`:            `÷`,
	`\sum`:            `Σ`,
	`\int`:            `∫`,
	`\oint`:           `∮`,
	`\prod`:           `Π`,
	`\sin`:            `sin`,
	`\cos`:            `cos`,
	`\tan`:            `tan`,
	`\cot`:            `cot`,
	`\sec`:            `sec`,
	`\csc`:            `csc`,
	`\arcsin`:         `arcsin`,
	`\arccos`:         `arccos`,
	`\arctan`:         `arctan`,
	`\sinh`:           `sinh`,
	`\cosh`:           `cosh`,
	`\tanh`:           `tanh`,
	`\ln`:             `ln`,
	`\log`:            `log`,
	`\exp`:            `exp`,
	`\max`:            `max`,
	`\min`:            `min`,
	`\inf`:            `inf`,
	`\sup`:            `sup`,
	`\lim`:            `lim`,
	`\in`:             `∈`,
	`\notin`:          `∉`,
	`\subset`:         `⊂`,
	`\subseteq`:       `⊆`,
	`\supset`:         `⊃`,
	`\supseteq`:       `⊇`,
	`\cup`:            `∪`,
	`\cap`:            `∩`,
	`\emptyset`:       `∅`,
	`\varnothing`:     `∅`,
	`\forall`:         `∀`,
	`\exists`:         `∃`,
	`\nexists`:        `∄`,
	`\neg`:            `¬`,
	`\circ`:           `∘`,
	`\bullet`:         `•`,
	`\ldots`:          `…`,
	`\cdots`:          `⋯`,
	`\vdots`:          `⋮`,
	`\ddots`:          `⋱`,
	`\prime`:          `′`,
	`\ell`:            `ℓ`,
	`\hbar`:           `ℏ`,
	`\left`:           ``,
	`\right`:          ``,
	`\big`:            ``,
	`\Big`:            ``,
	`\bigg`:           ``,
	`\Bigg`:           ``,
	`\,`:              ``,
	`\;`:              ``,
	`\!`:              ``,
	`\:`:              ``,
	`\quad`:           ` `,
	`\qquad`:          `  `,
	`\displaystyle`:   ``,
	`\textstyle`:      ``,
	`\limits`:         ``,
	`\nolimits`:       ``,
}

var (
	// \text{A} / \mathrm{A} / \mathbf{A} / ... -> A (drop styling command)
	braceCmdRe = regexp.MustCompile(`\\(?:text|mathrm|mathbf|mathit|mathsf|mathnormal|mathcal|mathfrak|mathbb|operatorname|textit|textbf|textrm)\{([^{}]*)\}`)
	// \frac{A}{B} (also \dfrac/\tfrac), A/B contain no braces
	fracRe = regexp.MustCompile(`\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}`)
	// \sqrt{A}
	sqrtRe = regexp.MustCompile(`\\sqrt\{([^{}]*)\}`)
	// \lim_{A}
	limRe = regexp.MustCompile(`\\lim_\{([^{}]*)\}`)
	// ^{A} / _{A} -> ^A / _A
	supBraceRe = regexp.MustCompile(`\^\{([^{}]*)\}`)
	subBraceRe = regexp.MustCompile(`_\{([^{}]*)\}`)
	// remaining \command -> command
	cmdRe = regexp.MustCompile(`\\([a-zA-Z]+)`)
	// "( a" -> "(a" and "b )" -> "b)" (half- and full-width parens)
	parenOpenRe  = regexp.MustCompile(`[\(（]\s+`)
	parenCloseRe = regexp.MustCompile(`\s+[\)）]`)
	// "x ，" -> "x，" (drop space before CJK punctuation)
	cjkPunctSpaceRe = regexp.MustCompile(` +([，。；：！？、）】」』])`)
)

// latexToText down-converts a LaTeX string to readable plain text + Unicode for
// email rendering (email clients cannot render KaTeX/MathJax). Strips $
// delimiters, converts \frac{a}{b} to a/b (or (a)/(b) for complex args),
// \lim_{x\to0} to lim(x->0), maps common symbols to Unicode (π ≤ × ∫ …), and
// drops stray braces. Not a full LaTeX interpreter — complex constructs
// (matrices, align) degrade gracefully to readable text.
func latexToText(s string) string {
	if s == "" {
		return s
	}
	// 1. drop $ delimiters
	s = strings.ReplaceAll(s, "$", "")

	// 2. \text{A} / styling commands -> A (iterate for nesting)
	for braceCmdRe.MatchString(s) {
		s = braceCmdRe.ReplaceAllString(s, `${1}`)
	}

	// 3. \frac{A}{B} -> A/B (simple args) or (A)/(B) (args with operators)
	for fracRe.MatchString(s) {
		s = fracRe.ReplaceAllStringFunc(s, func(m string) string {
			sub := fracRe.FindStringSubmatch(m)
			a, b := sub[1], sub[2]
			if isSimpleToken(a) && isSimpleToken(b) {
				return a + "/" + b
			}
			return "(" + a + ")/(" + b + ")"
		})
	}

	// 4. \sqrt{A} -> √(A)
	for sqrtRe.MatchString(s) {
		s = sqrtRe.ReplaceAllString(s, `√($1)`)
	}

	// 5. \lim_{A} -> lim(A)
	for limRe.MatchString(s) {
		s = limRe.ReplaceAllString(s, `lim($1)`)
	}

	// 6. symbol commands -> Unicode/text (longest-first)
	s = replaceSymbols(s)

	// 7. ^{A} -> ^A, _{A} -> _A
	s = supBraceRe.ReplaceAllString(s, `^$1`)
	s = subBraceRe.ReplaceAllString(s, `_$1`)

	// 8. remaining \command -> command
	s = cmdRe.ReplaceAllString(s, `$1`)

	// 9. drop stray braces
	s = strings.ReplaceAll(s, `{`, "")
	s = strings.ReplaceAll(s, `}`, "")

	// 10. tidy spaces around parens (keep the original paren char) and CJK punctuation
	s = parenOpenRe.ReplaceAllStringFunc(s, func(m string) string {
		r := []rune(m)
		return string(r[0]) // opening paren + spaces -> opening paren
	})
	s = parenCloseRe.ReplaceAllStringFunc(s, func(m string) string {
		r := []rune(m)
		return string(r[len(r)-1]) // spaces + closing paren -> closing paren
	})
	s = cjkPunctSpaceRe.ReplaceAllString(s, "$1")

	// 11. collapse runs of spaces
	s = collapseSpaces(s)

	return strings.TrimSpace(s)
}

// isSimpleToken reports whether a frac argument is simple enough to render
// without parentheses: no spaces, operators, or backslash commands.
func isSimpleToken(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch r {
		case ' ', '+', '-', '=', '/', '\\', '<', '>', '(', ')', '^', '_', '*', '|':
			return false
		}
	}
	return true
}

// replaceSymbols substitutes \command -> symbol for every entry in latexSymbol,
// longest-first so \leq is not shadowed by \le.
func replaceSymbols(s string) string {
	type kv struct{ k, v string }
	sym := make([]kv, 0, len(latexSymbol))
	for k, v := range latexSymbol {
		sym = append(sym, kv{k, v})
	}
	sort.Slice(sym, func(i, j int) bool { return len(sym[i].k) > len(sym[j].k) })
	for _, e := range sym {
		s = strings.ReplaceAll(s, e.k, e.v)
	}
	return s
}

func collapseSpaces(s string) string {
	var b strings.Builder
	prevSpace := false
	for _, r := range s {
		if r == ' ' {
			if !prevSpace {
				b.WriteRune(' ')
			}
			prevSpace = true
			continue
		}
		prevSpace = false
		b.WriteRune(r)
	}
	return b.String()
}

// latexToTextSlice applies latexToText to each element.
func latexToTextSlice(ss []string) []string {
	if len(ss) == 0 {
		return ss
	}
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = latexToText(s)
	}
	return out
}
