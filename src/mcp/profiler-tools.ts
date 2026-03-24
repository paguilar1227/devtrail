// src/mcp/profiler-tools.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../app.js';
import type { ServiceDeps } from '../services/index.js';
import { ALLOWED_TAGS } from '../capture/tags.js';
import * as capturesSvc from '../services/captures.js';
import * as profileSvc from '../services/profile.js';
import * as factsSvc from '../services/facts.js';
import * as insightsSvc from '../services/insights.js';
import * as consolidationSvc from '../services/consolidation.js';
import * as tagsSvc from '../services/tags.js';

const USER_SYSTEM_PROMPT = `You have access to Open Brain — a personal knowledge system that maintains a living profile about me.

## What to Do

1. **At session start**, call get_user_profile to understand who I am.
2. **During our conversation**, proactively capture observations about me when you notice:
   - Decisions I make and why
   - Preferences I express (tools, languages, approaches, food, hobbies)
   - Skills I demonstrate
   - Goals I mention or imply
   - Work patterns and habits
   - Emotional reactions (what excites, frustrates, or bores me)
   - How I communicate — humor style, directness level, how I structure my thinking
   - What makes me more productive — what kind of responses, explanations, or interactions work best for me
3. **When I mention commitments or deadlines**, suggest creating a reminder (but never add without my consent).
4. **When I ask you to remember something**, capture it immediately.

## Tag System

Every capture is classified with semantic tags. Provide tags when calling capture_thought if you know the type — otherwise the pipeline auto-classifies.

| Tag | What it means |
|-----|---------------|
| preference | How I like things done |
| decision | A choice made with rationale |
| problem-solution | A problem encountered and how it was resolved |
| pattern | A recurring behavior or habit observed over time |
| goal | An aspiration, target, or planned direction |
| opinion | A stance or belief with reasoning |
| skill | A capability or expertise level |
| relationship | Knowledge about a specific person |
| resource | A tool, link, article, or reference worth recalling |
| idea | An uncommitted exploration or possibility |
| interest | A hobby, passion, or thing enjoyed |
| health | Medical, fitness, dietary, or wellness information |
| dislike | Something to avoid or never suggest |
| milestone | A significant achievement or turning point |

## How to Capture

Use the capture_thought tool. Write in third person as an observer. Provide tags when confident:
- capture_thought({ content: "Alex prefers TypeScript over JavaScript for all new projects", tags: ["preference"] })
- capture_thought({ content: "Alex has deep Azure infrastructure experience — sets up Container Apps, Functions, and Bicep IaC fluently", tags: ["skill"] })
- capture_thought({ content: "Alex is building Open Brain to help AI tools understand who he is", tags: ["goal"] })
- capture_thought({ content: "Fixed Telegram retry loop by responding 200 immediately after webhook POST", tags: ["problem-solution"] })

Multiple tags are fine: tags: ["decision", "health"]
If unsure of the type, omit tags — auto-classification handles it.

One signal per capture. Be specific. Include the WHY when possible.

## Searching with Tag Filters

Combine a semantic query with a tag filter for precise retrieval:
- search_thoughts("coding preferences", { tags: ["preference"] })
- search_thoughts("health history", { tags: ["health"] })
- search_thoughts("tools and references", { tags: ["resource"] })

Tags use AND semantics — all provided tags must match.

## Reminders

I use Open Brain as my task manager too. Available tools:
- create_reminder — with project, priority (P1/P2/P3), due date, subtasks
- list_reminders — filter by project, status, priority
- complete_reminder — cascades to subtasks
- update_reminder — change status, priority, content, move between projects

## Project & Technical Knowledge

Don't just capture things about me — capture what we learn about the projects and technologies we work on:
- Bugs encountered and how they were resolved
- Architectural decisions and why they were made
- Gotchas, workarounds, and non-obvious behavior
- Configuration patterns that work (or don't)

These help future sessions avoid rediscovering the same problems.

## What NOT to Capture

- Operational exchanges ("run this command", "read this file")
- Information I'm asking YOU about (that's your knowledge, not mine)
- Verbatim conversation transcripts

## Key Principle

Don't wait for me to say "remember this." If you notice something worth remembering — about me or about the work — capture it. I've opted into this — Open Brain exists specifically for this purpose.`;

const BRAIN_HELP_TEXT = `# Open Brain — AI Usage Guide

## What This Is

Open Brain is a personal knowledge system that builds a living profile of the user. It captures raw thoughts, synthesizes them into facts, and identifies cross-cutting patterns (insights). Every AI client connected to Open Brain should actively contribute to this profile.

## When to Capture

Capture a thought whenever you observe something worth remembering — about the user OR about the projects and technologies you work on together. This includes:

**About the user:**
- **Decisions made** — what they chose and why (or what they rejected)
- **Preferences expressed** — likes, dislikes, opinions, aesthetic taste
- **Skills demonstrated** — what they're good at, tools they use fluently
- **Goals stated or implied** — what they're working toward, ambitions
- **Work patterns** — how they approach problems, collaboration style
- **Emotional reactions** — what excites them, frustrates them, bores them
- **Relationships mentioned** — people, teams, companies they reference
- **Task completions** — what they accomplished and what it reveals
- **Communication style** — humor, directness, how they structure their thinking, what kind of explanations resonate
- **What helps them** — what kinds of responses, formats, or interactions make them more productive

**About the work:**
- **Bugs and fixes** — problems encountered and how they were resolved
- **Architectural decisions** — why a particular approach was chosen over alternatives
- **Gotchas and workarounds** — non-obvious behavior, configuration quirks, things that break
- **Patterns that work** — solutions, configurations, and approaches worth reusing

These project learnings help future sessions avoid rediscovering the same problems.

Do NOT capture:
- Purely operational exchanges ("run this command", "read this file")
- Information the user is asking YOU about (that's your knowledge, not theirs)
- Verbatim conversation (capture the signal, not the transcript)

## How to Format Captures

Write in **third person** as an observer describing the user. The audience is a consolidation AI that will synthesize captures into profile facts, so optimize for clarity and signal density.

Provide tags when you're confident about the type. If unsure, omit them — the pipeline auto-classifies using Gemini Flash.

### Tag System — 14 Allowed Tags

| Tag | What it means | Example |
|-----|---------------|---------|
| preference | How the user likes things done | "Alex prefers Hono over Express for TypeScript APIs" |
| decision | A choice made with rationale | "Chose JWT sessions over server-side, prioritizing simplicity" |
| problem-solution | A problem encountered and how it was resolved | "Fixed Telegram retry loop by responding 200 immediately" |
| pattern | A recurring behavior or habit | "Tends to defer tests until after first bugs appear" |
| goal | An aspiration, target, or planned direction | "Training for a half marathon in October" |
| opinion | A stance or belief with reasoning | "Believes monorepos are right for tightly coupled services" |
| skill | A capability or expertise level | "Deep TypeScript expertise, new to React" |
| relationship | Knowledge about a specific person | "Sarah prefers async communication, birthday June 12" |
| resource | A tool, link, article, or reference worth recalling | "pgvector HNSW needs 2x working memory — see PostgreSQL wiki" |
| idea | An uncommitted exploration or possibility | "Might convert the garage into a workshop" |
| interest | A hobby, passion, or thing enjoyed | "Really enjoying bouldering lately" |
| health | Medical, fitness, dietary, or wellness information | "Allergic to penicillin, left knee flares when running downhill" |
| dislike | Something to avoid or never suggest | "Hates writing YAML configuration files" |
| milestone | A significant achievement or turning point | "Launched Open Brain v2 on March 21, 2026" |

### When to Provide Tags vs Let Auto-Classify

**Provide tags when confident:**
- You directly observed the type (user said "I hate X" → dislike, user made a choice with reasoning → decision)
- The type is unambiguous from context
- Multiple tags clearly apply: ["decision", "health"]

**Let the pipeline auto-classify when:**
- The type is ambiguous
- You're unsure which tag applies
- The content spans categories and you'd be guessing

Simply omit the tags parameter when in doubt — auto-classification handles it correctly.

### Examples

Good:
\`\`\`
capture_thought({
  content: "Alex prefers TypeScript over JavaScript for all new projects. Expressed strong conviction when choosing the tech stack.",
  tags: ["preference"]
})

capture_thought({
  content: "Alex has deep experience with Azure infrastructure — set up Container Apps, Functions, Key Vault, and Bicep IaC fluently without guidance.",
  tags: ["skill"]
})

capture_thought({
  content: "Fixed Telegram webhook retry loop by responding 200 immediately and processing updates in background.",
  tags: ["problem-solution"]
})

capture_thought({
  content: "Alex is building a personal AI knowledge system (Open Brain) to help AI tools understand who he is. This is a passion project, not work-related.",
  tags: ["goal", "interest"]
})

capture_thought({
  content: "Alex values efficiency and directness — pushed back on over-engineering and wanted minimal, focused solutions.",
  tags: ["pattern", "preference"]
})
\`\`\`

Bad:
- "User asked me to fix a bug" (operational, no profile signal)
- "I love TypeScript" (first person — use third person)
- "Alex used Claude Code today" (too vague — what did it reveal about him?)

### Key Principles

1. **Third person always** — "Alex prefers..." not "I prefer..."
2. **One signal per capture** — don't bundle unrelated observations
3. **Include context** — "chose X over Y because Z" is better than "likes X"
4. **Be specific** — "uses Hono for HTTP APIs" beats "likes web frameworks"
5. **Capture the why** — motivations and reasoning are the richest profile signal
6. **Confidence through language** — "strongly believes" vs "seems to prefer" vs "mentioned once"

## Tag-Filtered Search

Use tags with search_thoughts to narrow results to a specific knowledge type:

\`\`\`
search_thoughts("coding style", { tags: ["preference"] })     // preferences about coding
search_thoughts("career goals", { tags: ["goal"] })           // goals and aspirations
search_thoughts("past problems", { tags: ["problem-solution"] }) // things already solved
search_thoughts("people I work with", { tags: ["relationship"] }) // people knowledge
\`\`\`

Tags use AND semantics — tags: ["preference", "health"] means results must have BOTH tags.
Omit tags to search across all knowledge types.

## Available Tools

- **capture_thought** — save a new observation. Optional tags parameter (omit to auto-classify). Optional file_urls for multimodal captures.
- **search_thoughts** — tiered semantic search (insights → facts → captures). Optional tags filter for knowledge type.
- **update_tags** — replace tags on any tier item (capture, fact, insight) by UUID.
- **get_user_profile** — get the synthesized profile summary (call at session start)
- **brain_stats** — system dashboard (counts by tier, tags, source)
- **create_reminder** / **list_reminders** / **complete_reminder** / **update_reminder** — task management
- **run_consolidation** — manually process pending captures into facts/insights
- **review_pending** / **approve_reject** — review AI-generated facts and insights

## Proactive Capture

Don't wait for the user to say "remember this." If you notice a pattern, preference, or significant decision during normal interaction, capture it. The user has opted into this — Open Brain exists specifically for this purpose. Just don't interrupt the conversation flow to announce it.`;

export function registerProfilerTools(server: McpServer, deps: AppDeps): void {
  // AppDeps and ServiceDeps have the same shape — cast once and use throughout
  const svcDeps: ServiceDeps = deps;

  // 0a. brain_help — usage guide for AI clients
  server.tool(
    'brain_help',
    'Returns instructions on what Open Brain is, when and how to capture thoughts, and the optimal format for captures. Call this when you first connect or need guidance.',
    {},
    async () => {
      return { content: [{ type: 'text' as const, text: BRAIN_HELP_TEXT }] };
    },
  );

  // 0b. get_user_prompt — portable system prompt for any AI client
  server.tool(
    'get_user_prompt',
    'Returns a system prompt that can be pasted into any AI client (Claude, ChatGPT, etc.) to teach it how to use Open Brain. Use this to set up a new AI client.',
    {},
    async () => {
      return { content: [{ type: 'text' as const, text: USER_SYSTEM_PROMPT }] };
    },
  );

  // 1. get_user_profile — session bootstrap
  server.tool(
    'get_user_profile',
    'Session bootstrap — returns a synthesized profile summary of who this person is right now',
    {},
    async () => {
      const profile = await profileSvc.getUserProfile(svcDeps);
      return { content: [{ type: 'text' as const, text: profile }] };
    },
  );

  // 2. search_thoughts — tiered semantic search
  server.tool(
    'search_thoughts',
    'Tiered semantic search: insights → facts → captures. Use tags to filter by knowledge type.',
    {
      query: z.string().describe('Search query'),
      threshold: z.number().min(0).max(1).default(0.5).describe('Similarity threshold (0-1)'),
      limit: z.number().int().positive().default(10).describe('Max results'),
      tags: z.array(z.string()).optional().describe('Filter by tags (AND — must have all). Available: ' + ALLOWED_TAGS.join(', ')),
    },
    async ({ query, threshold, limit, tags }) => {
      const results = await capturesSvc.searchThoughts(svcDeps, query, threshold, limit, tags);
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    },
  );

  // 3. capture_thought — capture from any MCP client
  server.tool(
    'capture_thought',
    'Capture a thought, observation, or piece of knowledge about the user',
    {
      content: z.string().describe('Text of the thought (third person, one signal per capture)'),
      file_urls: z.array(z.string()).optional().describe('URLs to download files from'),
      tags: z.array(z.string()).optional().describe('Semantic tags from allowlist: ' + ALLOWED_TAGS.join(', ') + '. If omitted, auto-classified.'),
    },
    async ({ content, file_urls, tags }) => {
      // File download stays in the MCP adapter (channel-specific logic)
      const files: Array<{ data: Buffer; contentType: string; filename: string }> = [];
      if (file_urls) {
        for (const url of file_urls) {
          const response = await fetch(url);
          const buffer = Buffer.from(await response.arrayBuffer());
          const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
          files.push({ data: buffer, contentType, filename: url.split('/').pop() ?? 'file' });
        }
      }

      const result = await capturesSvc.captureThought(svcDeps, content, files, tags, ['mcp']);

      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: `Skipped: ${result.reason}` }], isError: true };
      }
      const warningText = result.warnings?.length ? `\nWarnings:\n${result.warnings.map((w) => `- ${w}`).join('\n')}` : '';
      return { content: [{ type: 'text' as const, text: `Captured! ID: ${result.captureId}${warningText}` }] };
    },
  );

  // 4. brain_stats — dashboard
  server.tool(
    'brain_stats',
    'Dashboard — counts, types, topics, confidence distribution',
    {},
    async () => {
      const result = await profileSvc.getBrainStats(svcDeps);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // 5. archive_thought — soft isolation
  server.tool(
    'archive_thought',
    'Soft-delete an item (no cascade recalculation)',
    {
      id: z.string().uuid().describe('UUID of the item to archive'),
      type: z.enum(['capture', 'fact', 'insight']).describe('Which table'),
    },
    async ({ id, type }) => {
      if (type === 'capture') await capturesSvc.archiveCapture(svcDeps, id);
      else if (type === 'fact') await factsSvc.archiveFact(svcDeps, id);
      else await insightsSvc.archiveInsight(svcDeps, id);
      return { content: [{ type: 'text' as const, text: `Archived ${type} ${id}` }] };
    },
  );

  // 6. unarchive_thought — restore
  server.tool(
    'unarchive_thought',
    'Restore an archived item',
    {
      id: z.string().uuid().describe('UUID of the item to restore'),
      type: z.enum(['capture', 'fact', 'insight']).describe('Which table'),
    },
    async ({ id, type }) => {
      if (type === 'capture') await capturesSvc.unarchiveCapture(svcDeps, id);
      else if (type === 'fact') await factsSvc.unarchiveFact(svcDeps, id);
      else await insightsSvc.unarchiveInsight(svcDeps, id);
      return { content: [{ type: 'text' as const, text: `Unarchived ${type} ${id}` }] };
    },
  );

  // 7. update_fact — direct user edit
  server.tool(
    'update_fact',
    'Edit a fact directly. Sets origin to user_edited, confidence to 1.0, preserves source links.',
    {
      id: z.string().uuid().describe('Fact UUID'),
      content: z.string().describe('New content for the fact'),
    },
    async ({ id, content }) => {
      try {
        await factsSvc.updateFact(svcDeps, id, content);
        return { content: [{ type: 'text' as const, text: `Fact ${id} updated. Origin set to user_edited, confidence set to 1.0.` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
      }
    },
  );

  // 8. review_pending — list pending review items
  server.tool(
    'review_pending',
    'List items with pending_review status',
    {
      limit: z.number().int().positive().default(20).describe('Max items to return'),
      type: z.enum(['fact', 'insight']).optional().describe('Filter by type, defaults to both'),
    },
    async ({ limit, type }) => {
      const items: Array<{ id: string; type: string; content: string; tags: string[]; confidence: number }> = [];

      if (!type || type === 'fact') {
        const facts = await factsSvc.reviewPendingFacts(svcDeps, limit);
        for (const f of facts) {
          items.push({ id: f.id, type: 'fact', content: f.content, tags: f.tags, confidence: f.confidence });
        }
      }

      if (!type || type === 'insight') {
        const insights = await insightsSvc.reviewPendingInsights(svcDeps, limit);
        for (const i of insights) {
          items.push({ id: i.id, type: 'insight', content: i.content, tags: i.tags, confidence: i.confidence });
        }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] };
    },
  );

  // 9. approve_reject — act on pending_review items
  server.tool(
    'approve_reject',
    'Approve, reject, or edit a pending_review item. Looks up by UUID across facts and insights.',
    {
      id: z.string().uuid().describe('UUID of the item'),
      action: z.enum(['approve', 'reject', 'edit']).describe('Action to take'),
      content: z.string().optional().describe('New content (required if action is edit)'),
    },
    async ({ id, action, content }) => {
      if (action === 'edit' && !content) {
        return { content: [{ type: 'text' as const, text: 'content is required when action is edit' }], isError: true };
      }

      // Routing logic: look up whether the ID belongs to a fact or insight, then dispatch
      const fact = await factsSvc.getFact(svcDeps, id);
      if (fact) {
        if (fact.review_status !== 'pending_review' && action !== 'approve') {
          return { content: [{ type: 'text' as const, text: `Fact ${id} is not in pending_review status. Use update_fact to edit approved facts.` }], isError: true };
        }
        try {
          await factsSvc.approveRejectFact(svcDeps, id, action, content);
        } catch (err) {
          return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: `Fact ${id}: ${action}d` }] };
      }

      const insight = await insightsSvc.getInsight(svcDeps, id);
      if (insight) {
        if (insight.review_status !== 'pending_review' && action !== 'approve') {
          return { content: [{ type: 'text' as const, text: `Insight ${id} is not in pending_review status.` }], isError: true };
        }
        try {
          await insightsSvc.approveRejectInsight(svcDeps, id, action, content);
        } catch (err) {
          return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: `Insight ${id}: ${action}d` }] };
      }

      return { content: [{ type: 'text' as const, text: `No fact or insight found with id ${id}` }], isError: true };
    },
  );

  // 10. run_consolidation — manually trigger consolidation
  server.tool(
    'run_consolidation',
    'Manually trigger the consolidation pipeline to process pending captures into facts and insights',
    {},
    async () => {
      try {
        await consolidationSvc.runConsolidation(svcDeps);
        const logs = await consolidationSvc.getConsolidationLogs(svcDeps, 1);
        const log = logs[0];
        if (!log) {
          return { content: [{ type: 'text' as const, text: 'Consolidation completed but no log entry found.' }] };
        }
        const summary = [
          `Consolidation ${log.status} in ${log.duration_ms}ms`,
          `Captures processed: ${log.captures_processed}`,
          `Facts created: ${log.facts_created} | Updated: ${log.facts_updated}`,
          `Insights created: ${log.insights_created}`,
          `Items flagged for review: ${log.items_flagged}`,
          `Tokens used: ${log.tokens_used}`,
          log.error_message ? `Error: ${log.error_message}` : null,
        ].filter(Boolean).join('\n');
        return { content: [{ type: 'text' as const, text: summary }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Consolidation failed: ${String(err)}` }], isError: true };
      }
    },
  );

  // 11. update_tags — replace tags on any tier item
  server.tool(
    'update_tags',
    'Update semantic tags on a capture, fact, or insight',
    {
      id: z.string().uuid().describe('UUID of the item'),
      tier: z.enum(['capture', 'fact', 'insight']).describe('Which tier'),
      tags: z.array(z.string()).describe('New tags (replaces existing). Allowed: ' + ALLOWED_TAGS.join(', ')),
    },
    async ({ id, tier, tags: rawTags }) => {
      try {
        const result = await tagsSvc.updateTags(svcDeps, id, tier, rawTags);
        return { content: [{ type: 'text' as const, text: `Tags updated: [${result.old.join(', ')}] → [${result.new.join(', ')}]` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
      }
    },
  );
}
