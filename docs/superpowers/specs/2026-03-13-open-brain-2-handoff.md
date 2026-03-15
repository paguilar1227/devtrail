# Open Brain 2.0 — Session Handoff

This document supplements the design spec (`2026-03-13-open-brain-2-design.md`). It captures context, reasoning, and decisions from the brainstorming session that a new session needs to understand before starting implementation.

## Who Is Pedro

- Software engineer at Microsoft (day job). QA automation engineer on the side (leverages his QA background for low-effort extra income).
- Claude Max subscriber. Uses Claude for coding, Gemini for research.
- Spends ~$500/mo on AI subscriptions. Has $150/mo Azure credits and $100/mo Google Cloud credits.
- Not cost-sensitive for this project — wants the best models, not the cheapest.
- Already has Azure infrastructure: ACR (shared across projects), static apps, another MCP server running there.
- Prefers concise, direct communication. Professional friends tone.

## What Open Brain Is (and Isn't)

Pedro originally got this project from an AI blogger's tutorial. He's rearchitecting it to match his own vision. Key mental model shifts from the original:

- **NOT a work context tool.** Pedro has a separate MCP server for structured work context. Open Brain is personal — it's about *him*, not his projects.
- **A living profile, not a journal.** Facts and insights reflect current state. "Dislikes pineapple on pizza" — not "Previously liked but changed his mind." Raw captures preserve history implicitly.
- **A bonding layer between human and AI.** Not just a profiler — reminders, todos, and future features (calendar, emotions, reflections) are core to the identity. The daily interaction makes the profiler better.
- **A personal search engine.** The end state is: any AI tool can call Open Brain and instantly understand who Pedro is and what he cares about right now.

## Key Decisions and Why

### Why Azure over Google Cloud
Pedro has more Azure credits ($150 vs $100), considers them more durable (job vs subscription), and already has infrastructure there (ACR, static apps, existing MCP server). The shared PostgreSQL instance can serve multiple projects. Google only handles Gemini API calls (~$0.40/mo).

### Why Telegram over Discord/Slack
Higher file upload caps (2GB), native voice messages, better bot API, no slash command registration friction. Pedro did the research himself.

### Why Claude Opus for consolidation
Both Perplexity (council of 3) and Gemini Deep Research independently ranked Opus 4.6 as the best model for multi-document synthesis with nuance preservation and calibrated confidence. Pedro ran these evaluations himself with a crafted prompt.

### Why Gemini Flash for retrieval synthesis
Same research process — both tools recommended Gemini Flash for the speed+quality balance needed in the request path.

### Why the three-tier model
Pedro's core complaint: storing raw thoughts is "aimless." The consolidation layer is what transforms noise into signal. The three tiers emerged from Pedro wanting the AI to read synthesized knowledge, not raw fragments. The insight tier specifically maps to his "Wikipedia about me" metaphor.

### Why `previous_versions` on facts
Pedro didn't want to lose history entirely — he recognizes the data is inherently valuable even though the primary objective is current state. This was his push — he said "I'm almost sure you and I will think of really cool features that use this data down the line." It's a low-cost addition (JSONB column) with future optionality.

### Why reminders are a core feature
Pedro explicitly said he needs this personally. More importantly, he didn't want it to feel bolted on — "I want to make sure we design open brain with this feature as a part of what it will be." Reminders feed back into the profiler (what you remind yourself about reveals who you are).

### Why separate tables (not one unified table)
We briefly explored collapsing everything into a single `entries` table with a `type` column. Pedro's gut said no — concerned about performance over time. He clarified he wanted extensibility conventions (consistent patterns across tables), not a single-table design. The extensibility conventions section in the spec documents the patterns.

## Things the Spec Doesn't Capture

### Pedro's usage pattern matters for design
His Claude usage is infrequent and topic-diverse. Consecutive sessions are often completely unrelated (YouTube video creation in one, QA work in another). This is why `browse_thoughts` (recent entries) was deprecated in favor of `get_user_profile` — chronological recency is meaningless when sessions have no continuity.

### The "noise" criteria conversation
Pedro specifically pushed back on the consolidation prompt's "Is it noise?" determination. He wanted precision in how that decision is made to prevent useful information from being discarded. The explicit criteria in the spec (7 conditions that ALL must be true) and the "when in doubt, create a low-confidence fact" principle came from this conversation.

### Dedup is more nuanced than it looks
We went through several iterations on dedup:
- File hash check is a **storage optimization**, not a dedup gate — same image with different text context is a different thought
- Embedding similarity check is the actual dedup decision because it accounts for full context (text + files together)
- Dedup checks against ALL captures, not just recent ones (HNSW is fast enough at single-user scale)
- Pipeline was reordered so files are only uploaded to Blob Storage AFTER passing both dedup checks

### Archive doesn't cascade
Pedro asked what happens to consolidated facts/insights when a source capture is archived. Decision: nothing. Soft isolation only — the archived item is excluded from future processing, but existing derived data stays. Rationale: recalculating on every archive creates chain reactions and is expensive for minimal benefit.

### Rejection is soft
Rejected facts/insights are excluded from retrieval and consolidation but not deleted. They can be un-rejected. This preserves the audit trail.

### Phase 1 partial commits
Consolidation Phase 1 commits per-cluster (not one big transaction). If cluster 7 fails, clusters 1-6 are already saved. Phase 2 is atomic (all-or-nothing) because it needs the full fact set for coherent insight generation.

## What to Do Next

1. **Read the spec** — `docs/superpowers/specs/2026-03-13-open-brain-2-design.md`
2. **Write an implementation plan** — use the `superpowers:writing-plans` skill
3. **Pick the API framework** — spec says TBD (Express, Fastify, or Hono). Decide before writing code.
4. **Start with the data layer** — PostgreSQL schema, pgvector setup, provider abstraction interfaces
5. **Then the capture pipeline** — REST API + dedup + embedding + metadata extraction
6. **Then Telegram bot** — webhook handler, message type routing
7. **Then MCP server** — 13 tools
8. **Then consolidation** — Azure Function, the three phases
9. **Then retrieval synthesis** — `get_user_profile` and tiered `search_thoughts`
10. **Then notifications** — review system, daily digest, Telegram integration

## Files That Matter

- `docs/superpowers/specs/2026-03-13-open-brain-2-design.md` — the full spec
- `supabase/functions/ingest-thought/index.ts` — v1 capture logic (reference only, will be rewritten)
- `supabase/functions/open-brain-mcp/index.ts` — v1 MCP server (reference only, will be rewritten)
- `guiding-prompt.md` — v1 AI system prompt (needs rewriting for v2)

## Memory Files

Check `~/.claude/projects/-home-you-src-open-brain/memory/` for persistent context:
- `user_profile.md` — Pedro's role, credits, preferences
- `project_open_brain_vision.md` — the vision for Open Brain 2.0
- `project_open_brain_design_principle.md` — core principle: living profile, not journal
