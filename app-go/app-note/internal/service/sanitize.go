// SanitizeMarkdown — strip raw HTML / dangerous schemes before persistence.
// Port of app/services/notes/markdown.py: BlockNote already sanitises on the
// editor side, but defence-in-depth — the backend re-cleans before writing
// to MongoDB so a hand-crafted API request cannot inject <script> or
// javascript: URLs into shared notes.
//
// RE2 (Go regexp) has no backreferences, so the forbidden-block pass scans
// per tag name (open tag → first matching close tag) instead of using \1.
package service

import "regexp"

// forbiddenTags — raw HTML is not allowed in MD source; these tags are
// removed together with their entire inner block.
var forbiddenTags = []string{
	"script", "iframe", "object", "embed", "style",
	"link", "meta", "base", "form", "input", "button",
}

var (
	rawTagRe  = regexp.MustCompile(`<[^>]+>`)
	dangerURL = regexp.MustCompile(`(?i)(javascript|vbscript|file):`)
	openRe    = map[string]*regexp.Regexp{}
	closeRe   = map[string]*regexp.Regexp{}
)

func openTagRe(tag string) *regexp.Regexp {
	if re, ok := openRe[tag]; ok {
		return re
	}
	re := regexp.MustCompile(`(?is)<\s*` + tag + `[^>]*>`)
	openRe[tag] = re
	return re
}

func closeTagRe(tag string) *regexp.Regexp {
	if re, ok := closeRe[tag]; ok {
		return re
	}
	re := regexp.MustCompile(`(?is)<\s*/\s*` + tag + `\s*>`)
	closeRe[tag] = re
	return re
}

// SanitizeMarkdown strips dangerous HTML / URL schemes from a markdown
// source string:
//   - removes <script>/<iframe>/... blocks entirely
//   - strips any remaining raw HTML tags (keeps inner text)
//   - replaces javascript:/vbscript:/file: URLs with "#"
//
// Markdown syntax ([text](url), ``` fences, # headings) is preserved — only
// raw HTML and URL schemes are touched. data: URLs (incl. data:image) are
// NOT forbidden (legacy behaviour pinned by the safety tests).
func SanitizeMarkdown(text string) string {
	if text == "" {
		return ""
	}
	cleaned := text
	for _, tag := range forbiddenTags {
		cleaned = stripTagBlocks(cleaned, tag)
	}
	cleaned = rawTagRe.ReplaceAllString(cleaned, "")
	cleaned = dangerURL.ReplaceAllString(cleaned, "#")
	return cleaned
}

// stripTagBlocks removes every <tag ...>...</tag> span for one tag name.
// An unterminated opening tag is left untouched — the Python regex also
// fails to match without a closing tag.
func stripTagBlocks(text, tag string) string {
	open, close := openTagRe(tag), closeTagRe(tag)
	for {
		o := open.FindStringIndex(text)
		if o == nil {
			return text
		}
		rest := text[o[1]:]
		c := close.FindStringIndex(rest)
		if c == nil {
			return text
		}
		text = text[:o[0]] + rest[c[1]:]
	}
}
