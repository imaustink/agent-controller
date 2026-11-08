package corpus

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Source is one citable result: the number the model cites it by, and the
// title and URL code substitutes for that number.
//
// The model only ever writes the number. Title and URL come from the source's
// own answer to the caller (the probe, or a live search/read run as them), so
// an inline citation can never name something this caller may not open — the
// ADR 0040 guarantee the appended Sources list used to carry alone.
type Source struct {
	N     int    `json:"n"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

const (
	sourcesHeader = "Sources:"
	caveatsHeader = "What this answer could not see:"
)

// SourcesBlock lists sources once each, keyed by URL: several passages from
// one page are one source to the reader, not several identical lines.
func SourcesBlock(sources []Source) string {
	var b strings.Builder
	seen := map[string]bool{}
	for _, s := range sources {
		key := sourceKey(s)
		if seen[key] {
			continue
		}
		seen[key] = true
		if b.Len() == 0 {
			b.WriteString(sourcesHeader + "\n")
		}
		fmt.Fprintf(&b, "- %s\n", sourceLink(s))
	}
	return b.String()
}

// CaveatsBlock states what the answer could not see, each reason once.
func CaveatsBlock(lines []string) string {
	var b strings.Builder
	seen := map[string]bool{}
	for _, line := range lines {
		if seen[line] {
			continue
		}
		seen[line] = true
		if b.Len() == 0 {
			b.WriteString("\n" + caveatsHeader + "\n")
		}
		fmt.Fprintf(&b, "- %s\n", line)
	}
	return b.String()
}

// citationRun matches one or more adjacent markers — "[3]", "[3][5]",
// "[3], [5]", "[3, 5]" — so a cluster becomes one comma-joined list of links.
var citationRun = regexp.MustCompile(`\[\d+(?:\s*[,;]\s*\d+)*\](?:[ \t]*,?[ \t]*\[\d+(?:\s*[,;]\s*\d+)*\])*`)

var citationNumber = regexp.MustCompile(`\d+`)

// LinkCitations replaces the model's `[n]` markers with the cited source's
// title as a Markdown link, and reports how many distinct sources it linked.
//
// A number that names no source is dropped rather than left dangling: a
// marker the reader cannot follow is noise, and one that LOOKS like a
// citation but points nowhere is worse. Markers that are already part of
// Markdown link syntax — `[3](…)` or `…][3]` — are left alone.
func LinkCitations(text string, sources []Source) (string, int) {
	byN := make(map[int]Source, len(sources))
	for _, s := range sources {
		byN[s.N] = s
	}

	used := map[string]bool{}
	var out strings.Builder
	last := 0
	for _, loc := range citationRun.FindAllStringIndex(text, -1) {
		start, end := loc[0], loc[1]
		if (end < len(text) && text[end] == '(') || (start > 0 && text[start-1] == ']') {
			continue
		}

		var links []string
		inRun := map[string]bool{}
		for _, digits := range citationNumber.FindAllString(text[start:end], -1) {
			n, err := strconv.Atoi(digits)
			if err != nil {
				continue
			}
			s, ok := byN[n]
			if !ok || inRun[sourceKey(s)] {
				continue
			}
			inRun[sourceKey(s)] = true
			used[sourceKey(s)] = true
			links = append(links, sourceLink(s))
		}

		prefix := text[last:start]
		if len(links) == 0 {
			// Nothing valid in this run: remove it, and the space it was
			// attached with, so "OIDC [9]." reads "OIDC." not "OIDC ."
			prefix = strings.TrimRight(prefix, " \t")
		} else if needsSpaceBefore(text, start) {
			// The model often glues a marker to the word it follows
			// ("…with SNC[1]."). A bare marker reads fine that way; a title
			// does not ("…with SNC[End of Project Retro](…)"), so separate it.
			prefix += " "
		}
		out.WriteString(prefix)
		out.WriteString(strings.Join(links, ", "))
		last = end
	}
	out.WriteString(text[last:])
	return out.String(), len(used)
}

// FinalizeCitations turns a synthesized answer into its user-facing form.
//
// Markers become inline links. If the model cited nothing it could be held
// to, the full Sources list is appended instead, so an answer built on
// retrieved material is never shipped uncited. What the answer could not see
// is always appended, whatever the model did: that disclosure is not the
// model's to drop.
func FinalizeCitations(response string, sources []Source, caveats []string) string {
	linked, used := LinkCitations(response, sources)
	if used == 0 && len(sources) > 0 {
		linked = strings.TrimRight(linked, "\n") + "\n\n" + SourcesBlock(sources)
	}
	if block := CaveatsBlock(caveats); block != "" && !strings.Contains(linked, strings.TrimSpace(block)) {
		linked = strings.TrimRight(linked, "\n") + "\n" + block
	}
	return linked
}

// needsSpaceBefore reports whether a link replacing the marker at text[start]
// would be glued to the preceding character: anything but the start of the
// text, whitespace, or an opening bracket/quote the link belongs inside.
func needsSpaceBefore(text string, start int) bool {
	if start == 0 {
		return false
	}
	switch text[start-1] {
	case ' ', '\t', '\n', '\r', '(', '[', '{', '"', '\'':
		return false
	}
	return true
}

func sourceKey(s Source) string {
	if s.URL != "" {
		return s.URL
	}
	return "title:" + s.Title
}

// sourceLink renders a source as a Markdown link, escaped so a title or URL
// cannot break out of the link syntax.
func sourceLink(s Source) string {
	title := strings.NewReplacer(`\`, `\\`, "[", `\[`, "]", `\]`).Replace(s.Title)
	if s.URL == "" {
		return title
	}
	url := strings.NewReplacer(" ", "%20", "(", "%28", ")", "%29").Replace(s.URL)
	return fmt.Sprintf("[%s](%s)", title, url)
}
