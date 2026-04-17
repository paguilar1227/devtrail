#!/usr/bin/env bash
# Setup Open Brain auto-capture Stop hook for Claude Code
#
# Usage:
#   ./scripts/setup-open-brain-hook.sh              # setup in current project
#   ./scripts/setup-open-brain-hook.sh /path/to/project  # setup in another project
#
# Prerequisites:
#   - Claude Code installed
#   - Open Brain MCP server configured (capture_thought tool available)
#   - jq installed (brew install jq)

set -euo pipefail

TARGET_DIR="${1:-.}"
SETTINGS_DIR="$TARGET_DIR/.claude"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"

if ! command -v jq &> /dev/null; then
  echo "Error: jq is required. Install with: brew install jq"
  exit 1
fi

# The Stop hook prompt
HOOK_PROMPT='You are evaluating whether Claude'\''s last response contains something worth capturing to Open Brain (a personal knowledge system). The user'\''s name is Alex.

Input: $ARGUMENTS

CRITICAL: If stop_hook_active is true in the input, respond IMMEDIATELY with {"ok": true}. Do not evaluate further. This prevents infinite loops.

Evaluate the last_assistant_message for meaningful signal worth preserving:
- A decision made with rationale
- A problem solved (bug fix, workaround, gotcha)
- A preference expressed or confirmed
- A skill demonstrated or learned
- A pattern observed
- A goal set or achieved
- A milestone reached

If YES — respond with:
{"ok": false, "reason": "Before finishing, capture this observation to Open Brain via capture_thought (third person, with appropriate tags). Use '\''Alex'\'' as the subject: [write the specific observation here]"}

If NO (routine operations, simple file reads, clarifying questions, no meaningful signal) — respond with:
{"ok": true}

Be selective. Most responses are NOT capture-worthy. Only flag genuinely useful signals about the user — decisions, learnings, preferences, patterns. Skip routine code edits, file reads, and operational back-and-forth.'

HOOK_JSON=$(jq -n --arg prompt "$HOOK_PROMPT" '{
  hooks: {
    Stop: [
      {
        hooks: [
          {
            type: "prompt",
            prompt: $prompt
          }
        ]
      }
    ]
  }
}')

mkdir -p "$SETTINGS_DIR"

if [ -f "$SETTINGS_FILE" ]; then
  # Merge hook into existing settings
  MERGED=$(jq -s '.[0] * .[1]' "$SETTINGS_FILE" <(echo "$HOOK_JSON"))
  echo "$MERGED" > "$SETTINGS_FILE"
  echo "Updated: $SETTINGS_FILE (merged Stop hook)"
else
  echo "$HOOK_JSON" > "$SETTINGS_FILE"
  echo "Created: $SETTINGS_FILE (with Stop hook)"
fi

echo "Open Brain auto-capture hook installed."
