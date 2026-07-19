#!/usr/bin/env python3
"""Keep the prose fields of a Tool/Skill/Agent CR in sync across its two
on-disk representations:

  - a plain CR under tools/*/tool.yaml, apps/*/config/samples/*.yaml, or
    apps/opencode-swe-agent/agent.yaml -- for manual `kubectl apply` (no
    Helm) and validated in CI (see .github/workflows/validate-crds.yml)
  - the equivalent charts/community-components/templates/*.yaml Helm
    template, which is what actually gets installed in a real deployment

Everything else about the two files (header comments, image/serviceAccountName/
secretRef -- hardcoded vs Helm-templated, the `{{- if }}` enable guard, the
`labels:` block) is expected to differ and is left untouched. Only the named
prose keys (description/input/output/markdown/orchestratorPrompt/agentPrompt)
are compared or copied -- these are meant to be character-for-character
identical, since they describe the exact same CR to two different install
paths, and drifting means one path silently gives the orchestrator/a human
stale instructions.

Usage:
  scripts/sync-manifest-docs.py --check   # exit 1 and print a diff if any pair has drifted
  scripts/sync-manifest-docs.py --fix     # overwrite the sample/plain-CR side from the chart template
"""
import argparse
import difflib
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# (plain CR path, chart template path, keys to keep in sync)
PAIRS = [
    ("tools/recipe-scraper/tool.yaml",
     "charts/community-components/templates/tool-recipe-scraper.yaml",
     ["description", "input", "output"]),
    ("tools/recipe-publisher/tool.yaml",
     "charts/community-components/templates/tool-recipe-publisher.yaml",
     ["description", "input", "output"]),
    ("apps/agent-orchestrator/config/samples/opencode-swe-agent-tool.yaml",
     "charts/community-components/templates/tool-opencode-swe-agent-tool.yaml",
     ["description", "input", "output"]),
    ("apps/agent-orchestrator/config/samples/recipe-refining-skill.yaml",
     "charts/community-components/templates/skill-recipe-refining.yaml",
     ["description", "input", "output", "markdown"]),
    ("apps/agent-orchestrator/config/samples/self-improvement-skill.yaml",
     "charts/community-components/templates/skill-self-improvement.yaml",
     ["description", "input", "output", "markdown"]),
    ("apps/agent-orchestrator/config/samples/software-engineering-skill.yaml",
     "charts/community-components/templates/skill-software-engineering.yaml",
     ["description", "input", "output", "markdown"]),
    ("apps/opencode-swe-agent/agent.yaml",
     "charts/community-components/templates/agent-opencode-swe.yaml",
     ["description", "input", "output", "orchestratorPrompt", "agentPrompt"]),
]


def extract_block(lines, key):
    """Return (start, end, block_lines) for a `  <key>:` entry at 2-space
    indent. Handles both block scalars (`>-`/`|`, spanning the key line
    through the last 4-space-or-deeper-indented continuation line) and
    plain single-line scalars (`key: inline content`). end is exclusive."""
    needle_dash = f"  {key}: >-"
    needle_bar = f"  {key}: |"
    needle_inline = f"  {key}: "
    for i, line in enumerate(lines):
        stripped = line.rstrip("\n")
        if stripped in (needle_dash, needle_bar):
            j = i + 1
            while j < len(lines):
                inner = lines[j].strip()
                indent = len(lines[j]) - len(lines[j].lstrip(" "))
                if inner == "" or indent >= 4:
                    j += 1
                    continue
                break
            return i, j, lines[i:j]
        if stripped.startswith(needle_inline):
            return i, i + 1, lines[i:i + 1]
    raise ValueError(f"key {key!r} not found")


def check_pair(plain_path, chart_path, keys):
    plain_lines = plain_path.read_text().splitlines(keepends=True)
    chart_lines = chart_path.read_text().splitlines(keepends=True)
    diffs = []
    for key in keys:
        _, _, plain_block = extract_block(plain_lines, key)
        _, _, chart_block = extract_block(chart_lines, key)
        if plain_block != chart_block:
            diffs.append((key, plain_block, chart_block))
    return diffs


def fix_pair(plain_path, chart_path, keys):
    plain_lines = plain_path.read_text().splitlines(keepends=True)
    chart_lines = chart_path.read_text().splitlines(keepends=True)
    # Apply from the end of the file backwards so earlier splice indices stay valid.
    edits = []
    for key in keys:
        p_start, p_end, _ = extract_block(plain_lines, key)
        _, _, chart_block = extract_block(chart_lines, key)
        edits.append((p_start, p_end, chart_block))
    for start, end, block in sorted(edits, key=lambda e: -e[0]):
        plain_lines[start:end] = block
    plain_path.write_text("".join(plain_lines))


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true",
                       help="exit 1 and print a diff for any drifted pair")
    mode.add_argument("--fix", action="store_true",
                       help="overwrite the plain-CR side from the chart template")
    args = parser.parse_args()

    any_drift = False
    for plain_rel, chart_rel, keys in PAIRS:
        plain_path = REPO_ROOT / plain_rel
        chart_path = REPO_ROOT / chart_rel
        if args.fix:
            fix_pair(plain_path, chart_path, keys)
            continue
        diffs = check_pair(plain_path, chart_path, keys)
        if diffs:
            any_drift = True
            for key, plain_block, chart_block in diffs:
                print(f"--- drift: {plain_rel} vs {chart_rel} (key: {key}) ---")
                sys.stdout.writelines(difflib.unified_diff(
                    plain_block, chart_block,
                    fromfile=plain_rel, tofile=chart_rel))
                print()

    if args.check and any_drift:
        print("Manifest prose has drifted -- run `python3 scripts/sync-manifest-docs.py --fix` "
              "and review the result (the chart template is treated as the source of truth).",
              file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
