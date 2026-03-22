// src/mcp/profiler-tools.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../app.js';
import { getCaptureById, setCaptureArchived } from '../db/captures.js';
import { getFactById, setFactArchived, setFactReviewStatus, userEditFact, findPendingReviewFacts } from '../db/facts.js';
import { getInsightById, setInsightArchived, setInsightReviewStatus, findPendingReviewInsights } from '../db/insights.js';
import { runCapturePipeline } from '../capture/pipeline.js';
import { runConsolidation } from '../consolidation/runner.js';

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
3. **When I mention commitments or deadlines**, suggest creating a reminder (but never add without my consent).
4. **When I ask you to remember something**, capture it immediately.

## How to Capture

Use the capture_thought tool. Write in third person as an observer:
- "[preference] Pedro prefers TypeScript over JavaScript for all new projects."
- "[skill] Pedro has deep Azure infrastructure experience — sets up Container Apps, Functions, and Bicep IaC fluently."
- "[goal] Pedro is building Open Brain to help AI tools understand who he is."

One signal per capture. Be specific. Include the WHY when possible.

## Reminders

I use Open Brain as my task manager too. Available tools:
- create_reminder — with project, priority (P1/P2/P3), due date, subtasks
- list_reminders — filter by project, status, priority
- complete_reminder — cascades to subtasks
- update_reminder — change status, priority, content, move between projects

## What NOT to Capture

- Operational exchanges ("run this command", "read this file")
- Information I'm asking YOU about (that's your knowledge, not mine)
- Verbatim conversation transcripts

## Key Principle

Don't wait for me to say "remember this." If you notice something profile-relevant, capture it. I've opted into this — Open Brain exists specifically for this purpose.`;

const BRAIN_HELP_TEXT = `# Open Brain — AI Usage Guide

## What This Is

Open Brain is a personal knowledge system that builds a living profile of the user. It captures raw thoughts, synthesizes them into facts, and identifies cross-cutting patterns (insights). Every AI client connected to Open Brain should actively contribute to this profile.

## When to Capture

Capture a thought whenever you observe something profile-relevant about the user during your interaction. This includes:

- **Decisions made** — what they chose and why (or what they rejected)
- **Preferences expressed** — likes, dislikes, opinions, aesthetic taste
- **Skills demonstrated** — what they're good at, tools they use fluently
- **Goals stated or implied** — what they're working toward, ambitions
- **Work patterns** — how they approach problems, collaboration style
- **Emotional reactions** — what excites them, frustrates them, bores them
- **Relationships mentioned** — people, teams, companies they reference
- **Task completions** — what they accomplished and what it reveals

Do NOT capture:
- Purely operational exchanges ("run this command", "read this file")
- Information the user is asking YOU about (that's your knowledge, not theirs)
- Verbatim conversation (capture the signal, not the transcript)

## How to Format Captures

Write in **third person** as an observer describing the user. The audience is a consolidation AI that will synthesize captures into profile facts, so optimize for clarity and signal density.

### Good Format

\`\`\`
[CATEGORY] Observation. Context if relevant.
\`\`\`

**Categories:** preference, habit, skill, relationship, opinion, goal, personality, history

### Examples

Good:
- "[preference] Pedro prefers TypeScript over JavaScript for all new projects. Expressed strong conviction when choosing the tech stack."
- "[skill] Pedro has deep experience with Azure infrastructure — set up Container Apps, Functions, Key Vault, and Bicep IaC fluently without guidance."
- "[goal] Pedro is building a personal AI knowledge system (Open Brain) to help AI tools understand who he is. This is a passion project, not work-related."
- "[personality] Pedro values efficiency and directness. He pushed back on over-engineering and wanted minimal, focused solutions."
- "[habit] Pedro prefers to work on feature branches and merge to main, with reasonable commit sizes that are easy to review individually."
- "[opinion] Pedro believes the best AI models should be used regardless of provider — he's not locked into any single vendor."

Bad:
- "User asked me to fix a bug" (operational, no profile signal)
- "I love TypeScript" (first person — use third person)
- "Pedro used Claude Code today" (too vague — what did it reveal about him?)

### Key Principles

1. **Third person always** — "Pedro prefers..." not "I prefer..."
2. **One signal per capture** — don't bundle unrelated observations
3. **Include context** — "chose X over Y because Z" is better than "likes X"
4. **Be specific** — "uses Hono for HTTP APIs" beats "likes web frameworks"
5. **Capture the why** — motivations and reasoning are the richest profile signal
6. **Confidence through language** — "strongly believes" vs "seems to prefer" vs "mentioned once"

## Available Tools

- **capture_thought** — save a new observation (use the format above)
- **search_thoughts** — find what's known about a topic
- **get_user_profile** — get the synthesized profile summary (call at session start)
- **brain_stats** — system dashboard
- **create_reminder** / **list_reminders** / **complete_reminder** — task management
- **run_consolidation** — manually process pending captures into facts/insights
- **review_pending** / **approve_reject** — review AI-generated facts and insights

## Proactive Capture

Don't wait for the user to say "remember this." If you notice a pattern, preference, or significant decision during normal interaction, capture it. The user has opted into this — Open Brain exists specifically for this purpose. Just don't interrupt the conversation flow to announce it.`;

export function registerProfilerTools(server: McpServer, deps: AppDeps): void {
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
      // Delegates to retrieval/profile.ts (implemented in Task 27)
      const { getUserProfile } = await import('../retrieval/profile.js');
      const profile = await getUserProfile(deps.db, deps.retrievalLLM);
      return { content: [{ type: 'text' as const, text: profile }] };
    },
  );

  // 2. search_thoughts — tiered semantic search
  server.tool(
    'search_thoughts',
    'Tiered semantic search: insights → facts → captures, with conditional evidence on low confidence',
    {
      query: z.string().describe('Search query'),
      threshold: z.number().min(0).max(1).default(0.5).describe('Similarity threshold (0-1)'),
      limit: z.number().int().positive().default(10).describe('Max results'),
    },
    async ({ query, threshold, limit }) => {
      const { searchThoughts } = await import('../retrieval/search.js');
      const results = await searchThoughts(deps.db, deps.embeddingProvider, query, threshold, limit);
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    },
  );

  // 3. capture_thought — capture from any MCP client
  server.tool(
    'capture_thought',
    'Capture a thought from any MCP client',
    {
      content: z.string().describe('Text content of the thought'),
      file_urls: z.array(z.string()).optional().describe('Array of accessible URLs to download files from'),
    },
    async ({ content, file_urls }) => {
      const files: Array<{ data: Buffer; contentType: string; filename: string }> = [];
      if (file_urls) {
        for (const url of file_urls) {
          const response = await fetch(url);
          const buffer = Buffer.from(await response.arrayBuffer());
          const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
          files.push({ data: buffer, contentType, filename: url.split('/').pop() ?? 'file' });
        }
      }

      const result = await runCapturePipeline({
        db: deps.db,
        embeddingProvider: deps.embeddingProvider,
        metadataLLM: deps.metadataLLM,
        blobStorage: deps.blobStorage,
        content,
        files,
        source: ['mcp'],
      });

      if (!result.success) {
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
      const stats = await deps.db.query(`
        SELECT
          (SELECT count(*) FROM captures WHERE archived = false) AS captures_count,
          (SELECT count(*) FROM facts WHERE archived = false) AS facts_count,
          (SELECT count(*) FROM insights WHERE archived = false) AS insights_count,
          (SELECT count(*) FROM reminders WHERE archived = false) AS reminders_count,
          (SELECT count(*) FROM facts WHERE review_status = 'pending_review') AS facts_pending,
          (SELECT count(*) FROM insights WHERE review_status = 'pending_review') AS insights_pending
      `);

      const categories = await deps.db.query(`
        SELECT category, count(*) as count FROM facts
        WHERE archived = false AND review_status != 'user_rejected'
        GROUP BY category ORDER BY count DESC
      `);

      const row = stats.rows[0];
      const result = {
        captures: parseInt(row.captures_count),
        facts: parseInt(row.facts_count),
        insights: parseInt(row.insights_count),
        reminders: parseInt(row.reminders_count),
        pendingReview: parseInt(row.facts_pending) + parseInt(row.insights_pending),
        factsByCategory: categories.rows,
      };

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
      if (type === 'capture') await setCaptureArchived(deps.db, id, true);
      else if (type === 'fact') await setFactArchived(deps.db, id, true);
      else await setInsightArchived(deps.db, id, true);
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
      if (type === 'capture') await setCaptureArchived(deps.db, id, false);
      else if (type === 'fact') await setFactArchived(deps.db, id, false);
      else await setInsightArchived(deps.db, id, false);
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
      const existing = await getFactById(deps.db, id);
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `No fact found with id ${id}` }], isError: true };
      }
      await userEditFact(deps.db, id, content);
      // Re-embed the updated fact
      const embedding = await deps.embeddingProvider.embed(content);
      await deps.db.query(
        `UPDATE facts SET embedding = $1 WHERE id = $2`,
        [JSON.stringify(embedding), id],
      );
      return { content: [{ type: 'text' as const, text: `Fact ${id} updated. Origin set to user_edited, confidence set to 1.0.` }] };
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
        const facts = await findPendingReviewFacts(deps.db, limit);
        for (const f of facts) {
          items.push({ id: f.id, type: 'fact', content: f.content, tags: f.tags, confidence: f.confidence });
        }
      }

      if (!type || type === 'insight') {
        const insights = await findPendingReviewInsights(deps.db, limit);
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

      // Try facts first, then insights (UUIDs are globally unique)
      const fact = await getFactById(deps.db, id);
      if (fact) {
        if (fact.review_status !== 'pending_review' && action !== 'approve') {
          return { content: [{ type: 'text' as const, text: `Fact ${id} is not in pending_review status. Use update_fact to edit approved facts.` }], isError: true };
        }
        if (action === 'approve') {
          await setFactReviewStatus(deps.db, id, 'user_approved');
        } else if (action === 'reject') {
          await setFactReviewStatus(deps.db, id, 'user_rejected');
        } else {
          await userEditFact(deps.db, id, content!);
          await setFactReviewStatus(deps.db, id, 'user_approved');
          const embedding = await deps.embeddingProvider.embed(content!);
          await deps.db.query(`UPDATE facts SET embedding = $1 WHERE id = $2`, [JSON.stringify(embedding), id]);
        }
        return { content: [{ type: 'text' as const, text: `Fact ${id}: ${action}d` }] };
      }

      const insight = await getInsightById(deps.db, id);
      if (insight) {
        if (insight.review_status !== 'pending_review' && action !== 'approve') {
          return { content: [{ type: 'text' as const, text: `Insight ${id} is not in pending_review status.` }], isError: true };
        }
        if (action === 'approve') {
          await setInsightReviewStatus(deps.db, id, 'user_approved');
        } else if (action === 'reject') {
          await setInsightReviewStatus(deps.db, id, 'user_rejected');
        } else {
          await setInsightReviewStatus(deps.db, id, 'user_approved', content);
          const embedding = await deps.embeddingProvider.embed(content!);
          await deps.db.query(`UPDATE insights SET embedding = $1 WHERE id = $2`, [JSON.stringify(embedding), id]);
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
        await runConsolidation({
          db: deps.db,
          consolidationLLM: deps.consolidationLLM,
          embeddingProvider: deps.embeddingProvider,
          reviewMode: deps.config.reviewMode,
        });
        const logResult = await deps.db.query(
          `SELECT * FROM consolidation_log ORDER BY run_at DESC LIMIT 1`,
        );
        const log = logResult.rows[0];
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
}
