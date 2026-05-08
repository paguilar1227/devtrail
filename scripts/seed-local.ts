// scripts/seed-local.ts
//
// Populate a local DB with internally coherent data so the UI tells a
// believable story end-to-end. Calls the running backend over HTTP — same
// path the UI takes — so anything seeded here exercises the real ingest
// pipeline (LLM stub or real, your choice via LLM_PROVIDER).
//
// What we seed:
//   - 5 active + 1 archived project
//   - Notes per project, with cross-project entity overlap (Tailscale,
//     Claude, RAG appear in multiple projects → graph search has work to do)
//   - Hierarchical todos (parent → 2-3 subtasks → grandchild on one)
//   - Mix of priorities, statuses, due dates (overdue / future / none)
//   - Pinned: 1 project (handled by ClaudePit being pinned post-create),
//     1 note, 2 todos
//   - Archived: 1 project, 1 todo
//   - Personal Inbox: 4 todos
//   - Comments on 2 different todos
//
// Prereq: backend running on localhost:3001. Run with:
//
//   npm run dev:up         # one terminal
//   npm run seed:local     # another terminal
//
// Idempotent: bails if any project already exists.

const BASE = process.env.OPEN_BRAIN_BASE_URL ?? 'http://localhost:3001';
const KEY = process.env.OPEN_BRAIN_API_KEY ?? 'local-dev-key-not-secret';

type Json = Record<string, unknown>;

async function api<T = Json>(method: string, path: string, body?: Json): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

async function main() {
  console.log(`→ seeding ${BASE}`);

  // Bail if anything's already there.
  const existing = await api<{ projects: unknown[] }>('GET', '/api/v1/projects');
  if (existing.projects.length > 0) {
    console.log(`! ${existing.projects.length} projects already exist — skipping seed`);
    console.log(`  (run 'npm run dev:reset' to wipe and reseed)`);
    return;
  }

  // ============================================================
  // PROJECTS — 5 active + 1 archived (restored, then archived)
  // ============================================================
  const projectDefs = [
    { name: 'ClaudePit', description: 'Self-hosted control surface for Claude Code — agent cockpit wrapping the official `claude` CLI in headless mode.', pin: true },
    { name: 'Copilot CLI App', description: 'Personal app (web first, eventually mobile) leveraging the GitHub Copilot SDK for an agentic surface across devices.', pin: true },
    { name: 'Open Brain 2.5', description: "Field notes on Open Brain 2.5's entity model and the migration path from v2.", pin: false },
    { name: 'RAG Research', description: 'Hybrid retrieval comparisons — vector vs graph vs reranker, with a benchmark harness.', pin: false },
    { name: 'Homelab', description: 'Tailscale mesh, NAS storage, on-prem inference notes.', pin: false },
    { name: 'Old MCP Spike (archived)', description: 'Original MCP exploration before the v2 rewrite. Kept for reference — should not appear in the active list.', pin: false, archive: true },
  ];

  const projectIds: Record<string, string> = {};
  for (const p of projectDefs) {
    const created = await api<{ project: { id: string; name: string } }>('POST', '/api/v1/projects', {
      name: p.name,
      description: p.description,
      status: 'active',
    });
    projectIds[p.name] = created.project.id;
    if (p.pin) {
      await api('POST', `/api/v1/projects/${created.project.id}/pin`);
    }
    if (p.archive) {
      await api('DELETE', `/api/v1/projects/${created.project.id}`);
    }
    console.log(`  + project ${p.name}${p.pin ? ' (pinned)' : ''}${p.archive ? ' (archived)' : ''}`);
  }

  const claudepit = projectIds['ClaudePit'];
  const copilot = projectIds['Copilot CLI App'];
  const ob25 = projectIds['Open Brain 2.5'];
  const rag = projectIds['RAG Research'];
  const homelab = projectIds['Homelab'];
  const oldMcp = projectIds['Old MCP Spike (archived)'];

  // ============================================================
  // NOTES — cross-project entities for graph search:
  //   "Tailscale"      → ClaudePit, Homelab
  //   "Claude"         → ClaudePit, Copilot CLI App
  //   "RAG"            → Open Brain 2.5, RAG Research
  //   "pgvector"       → Open Brain 2.5, RAG Research
  // Every project has at least 2 notes, totals are realistic-feeling.
  // ============================================================
  type NoteSpec = { project: string; title: string; content: string; tags: string[]; pin?: boolean; archive?: boolean };
  const noteSpecs: NoteSpec[] = [
    // ---- ClaudePit ----
    {
      project: claudepit,
      title: 'ClaudePit — High-Level Concept',
      content: '# ClaudePit — High-Level Concept\n\nThe goal is to stop flying blind on what Claude is doing in long-running sessions. We wrap the `claude` CLI in headless mode and expose every feature through a web UI, then layer a session supervisor that lets us run multiple sessions in parallel without juggling terminal panes.\n\n## Auth\n\nSubscription cookies, never API keys. Tokens minted bound to the cookie and stored in the OS keychain. Tailscale handles cross-device access — phone monitors desktop sessions over magic-DNS.\n\n## Multi-session\n\nEach session is a process tree under a supervisor. Stdout multiplexed via line-prefixed framing.',
      tags: ['architecture', 'claude-code'],
      pin: true,
    },
    {
      project: claudepit,
      title: 'Auth strategy — subscription cookies',
      content: "We mint a session token bound to the Claude subscription cookie and store it in the keychain. No API keys ever touch the wire because (1) the official Claude subscription is what users already pay for, and (2) embedding API keys in a self-hosted tool creates a billing surface you don't want to own. Tailscale gates the cross-device side.",
      tags: ['auth', 'security'],
    },
    {
      project: claudepit,
      title: 'Multi-session parallelism notes',
      content: 'Each session is a process tree under a supervisor. Stdout multiplexed via line-prefixed framing so we can interleave outputs without losing structure. Mobile companion subscribes to the same stream over Tailscale magic-DNS.',
      tags: ['session-model', 'architecture'],
    },
    {
      project: claudepit,
      title: 'Mobile monitor-only mode',
      content: 'Read-only stream from the desktop relay. Push notifications when sessions complete. No write capability on phone yet — touch is too risky for `rm -rf` style commands. Tailscale handles the transport.',
      tags: ['mobile', 'tailscale'],
    },

    // ---- Copilot CLI App ----
    {
      project: copilot,
      title: 'Copilot SDK — first impressions',
      content: 'The SDK gives a clean tool-use loop but the streaming surface is rough. Need to wrap it in something more ergonomic before Claude integration becomes painful. Plan: a thin transport-agnostic layer that handles SSE reconnect + last-event-id replay.',
      tags: ['architecture', 'copilot'],
    },
    {
      project: copilot,
      title: 'Cross-device sync model',
      content: 'Same idea as ClaudePit — desktop is authoritative, mobile is a window into it. Auth flows through GitHub OAuth, tokens stored locally per device, sync over a small relay service.',
      tags: ['architecture', 'mobile'],
    },
    {
      project: copilot,
      title: 'Tool registry sketch',
      content: 'Tools are registered against a typed schema (Zod). Each tool has: name, description, input schema, output schema, handler. Claude (or any other model) picks tools based on description + schema. Same surface as MCP — could share the registry between this and ClaudePit.',
      tags: ['architecture'],
    },

    // ---- Open Brain 2.5 ----
    {
      project: ob25,
      title: 'OB 2.5 — entity model decisions',
      content: 'Entities live in their own table with chunk_entities edges. RRF fusion over vector + graph. Sequential scan at 3072 dims is fine on B1ms — HNSW init OOMs at that size. pgvector handles cosine distance via the <=> operator.',
      tags: ['rag', 'architecture'],
    },
    {
      project: ob25,
      title: 'Migration path notes',
      content: 'V2 → V2.5 is mostly additive: new entities + chunk_entities tables, plus the published_at column on content_items. No destructive schema changes. Rollback path: drop the new tables, drop the column.',
      tags: ['migration', 'rag'],
    },
    {
      project: ob25,
      title: 'Async ingest contract',
      content: 'POST /content returns 202 + pending. Backend kicks off the metadata → chunk → embed → entity-extract pipeline. Frontend polls /content/:id/status until ready or failed. The same contract holds for /from-url. Status table: pending, ready, failed. Idempotent retry on failed.',
      tags: ['architecture', 'ingest'],
    },

    // ---- RAG Research ----
    {
      project: rag,
      title: 'Reranker shootout — early notes',
      content: 'Comparing Cohere rerank-3, BGE-large, and a small Anthropic-served prompt-as-reranker. Cohere wins latency, BGE wins cost, prompt-as-reranker wins precision on retrieval-grounded tasks. RAG quality on the OB 2.5 corpus correlates strongly with reranker choice.',
      tags: ['rag', 'research'],
    },
    {
      project: rag,
      title: 'Hybrid retrieval — vector vs graph',
      content: 'Pure vector retrieval misses about 18% of relevant chunks at threshold 0.65 on our test set. Adding entity-graph expansion with RRF fusion recovers most of them. pgvector handles the vector side, our entities + chunk_entities tables handle the graph side. No external graph DB.',
      tags: ['rag', 'research'],
    },

    // ---- Homelab ----
    {
      project: homelab,
      title: 'Tailscale exit nodes — caveats',
      content: 'MagicDNS is great until you have overlapping subnets. Document the conflict-resolution path. Exit-node mode + subnet-router on the same machine works but split-DNS gets weird.',
      tags: ['tailscale', 'mobile'],
    },
    {
      project: homelab,
      title: 'NAS migration plan',
      content: 'Moving from ext4 to ZFS for snapshots + send/receive. Two-disk mirror with a third for offsite rotation. Snapshots every hour for the past day, every day for the past month. Tailscale lets the offsite disk pull updates from anywhere.',
      tags: ['storage'],
    },
  ];

  const noteIds: Record<string, string> = {};
  for (const n of noteSpecs) {
    const created = await api<{ id: string; status: string }>('POST', '/api/v1/content', {
      type: 'note',
      title: n.title,
      content: n.content,
      project_ids: [n.project],
      tags: n.tags,
    });
    noteIds[n.title] = created.id;
    if (n.pin) {
      await api('POST', `/api/v1/content/${created.id}/pin`);
    }
    if (n.archive) {
      await api('DELETE', `/api/v1/content/${created.id}`);
    }
    console.log(`  + note "${n.title}"${n.pin ? ' (pinned)' : ''}`);
  }

  // ============================================================
  // TODOS — hierarchy, status mix, priority mix, due-date mix
  // Indices below are positional — children reference parents by index.
  // ============================================================
  type Pri = 'P1' | 'P2' | 'P3';
  type TodoSpec = {
    project: string;
    content: string;
    priority?: Pri;
    status?: 'not_started' | 'in_progress' | 'paused' | 'done';
    due_date?: string; // ISO date
    tags?: string[];
    parent?: number;
    pin?: boolean;
    archive?: boolean;
  };

  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const daysFromNow = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return fmt(d);
  };

  const todoSpecs: TodoSpec[] = [
    // 0: ClaudePit — parent with subtasks (one of them with grandchildren)
    { project: claudepit, content: 'Wire up streaming responses with SSE', priority: 'P1', status: 'in_progress', due_date: daysFromNow(2), tags: ['architecture'], pin: true },
    { project: claudepit, content: 'Spec the SSE message envelope', priority: 'P2', status: 'done', parent: 0 },                                  // 1
    { project: claudepit, content: 'Heartbeat + reconnect logic', priority: 'P2', status: 'in_progress', due_date: daysFromNow(-1), parent: 0 },  // 2 (overdue)
    { project: claudepit, content: 'Last-event-id replay', priority: 'P3', status: 'not_started', parent: 2 },                                    // 3 (grandchild)
    { project: claudepit, content: 'Exponential backoff w/ jitter', priority: 'P3', status: 'not_started', parent: 2 },                           // 4 (grandchild)
    { project: claudepit, content: 'Client-side replay buffer', priority: 'P3', status: 'paused', parent: 0 },                                    // 5

    // ClaudePit standalones
    { project: claudepit, content: 'Spike: Tailscale auth handshake', priority: 'P1', status: 'not_started', due_date: daysFromNow(-3), tags: ['auth', 'tailscale'] },                  // 6 (overdue)
    { project: claudepit, content: 'Migrate to subscription cookies', priority: 'P1', status: 'done', tags: ['auth'] },                                                                  // 7
    { project: claudepit, content: 'Document headless-mode quirks', priority: 'P3', status: 'not_started', tags: ['claude-code'] },                                                      // 8

    // Copilot CLI
    { project: copilot, content: 'Wrap Copilot SDK streaming surface', priority: 'P2', status: 'in_progress', due_date: daysFromNow(7), tags: ['architecture'] },                       // 9
    { project: copilot, content: 'OAuth flow + token storage', priority: 'P2', status: 'not_started', tags: ['auth'] },                                                                  // 10
    { project: copilot, content: 'Tool registry MVP', priority: 'P2', status: 'not_started', pin: true },                                                                                // 11

    // Open Brain 2.5
    { project: ob25, content: 'Document the entity-resolution algorithm', priority: 'P2', status: 'not_started', tags: ['rag'] },                                                        // 12
    { project: ob25, content: 'Profile RAG depth=auto vs forced fast', priority: 'P3', status: 'paused', tags: ['rag'] },                                                                // 13

    // RAG Research
    { project: rag, content: 'Run reranker latency benchmark on 1k corpus', priority: 'P1', status: 'in_progress', due_date: daysFromNow(5), tags: ['rag', 'research'] },                // 14
    { project: rag, content: 'Compare BGE vs Cohere on retrieval recall', priority: 'P2', status: 'not_started', tags: ['rag', 'research'] },                                            // 15
    { project: rag, content: 'Old experiment — Anthropic prompt-as-reranker (archived)', priority: 'P3', status: 'done', tags: ['rag'], archive: true },                                  // 16

    // Homelab
    { project: homelab, content: 'Migrate NAS to ZFS with snapshots', priority: 'P3', status: 'not_started', tags: ['storage'] },                                                        // 17
    { project: homelab, content: 'Document Tailscale exit-node setup', priority: 'P3', status: 'not_started', tags: ['tailscale'] },                                                     // 18
  ];

  const todoIds: string[] = [];
  for (const t of todoSpecs) {
    const body: Json = {
      content: t.content,
      project_id: t.project,
      priority: t.priority ?? 'P3',
      tags: t.tags,
    };
    if (t.parent !== undefined) body.parent_id = todoIds[t.parent];
    if (t.due_date) body.due_date = t.due_date;

    const created = await api<{ todo: { id: string } }>('POST', '/api/v1/todos', body);
    todoIds.push(created.todo.id);

    if (t.status && t.status !== 'not_started') {
      await api('PUT', `/api/v1/todos/${created.todo.id}`, { status: t.status });
    }
    if (t.pin) {
      await api('POST', `/api/v1/todos/${created.todo.id}/pin`);
    }
    if (t.archive) {
      await api('DELETE', `/api/v1/todos/${created.todo.id}`);
    }
    const labels = [t.priority ?? 'P3', t.status ?? 'not_started', t.parent !== undefined ? `↳ child of #${t.parent}` : null]
      .filter(Boolean)
      .join(' · ');
    console.log(`  + todo [${labels}] "${t.content}"`);
  }

  // ============================================================
  // COMMENTS — on two different todos so the activity feed has variety
  // ============================================================
  const sseComments = [
    'SSE feels right but watch for proxy buffering — nginx defaults will eat events.',
    'Confirmed: had to disable proxy_buffering and set proxy_cache off. Documenting in headless-quirks.',
    'Heartbeat every 15s, reconnect with last-event-id. Patch in the heartbeat subtask.',
  ];
  for (const c of sseComments) {
    await api('POST', `/api/v1/todos/${todoIds[0]}/comments`, { content: c });
  }

  const benchComments = [
    'Got the corpus loader working. 1k Wikipedia sections, mixed lengths.',
    'Cohere rerank-3 averaging 240ms p50 / 480ms p95. BGE-large averaging 90ms / 180ms but recall drops 4 points.',
  ];
  for (const c of benchComments) {
    await api('POST', `/api/v1/todos/${todoIds[14]}/comments`, { content: c });
  }
  console.log(`  + ${sseComments.length + benchComments.length} comments across 2 todos`);

  // ============================================================
  // INBOX — personal todos, no project
  // Designed to exercise every todo feature visible on Home and the
  // personal todos drawer:
  //   priorities P1/P2/P3 ✓
  //   statuses not_started, in_progress, done, paused ✓
  //   due dates: overdue, due-soon, far-future, none ✓
  //   tags ✓
  //   parent / subtask hierarchy ✓
  //   pinned ✓
  //   comments ✓
  // Order matters: items are referenced by index for parent links.
  // ============================================================
  type InboxSpec = {
    content: string;
    priority: Pri;
    status?: 'not_started' | 'in_progress' | 'done' | 'paused';
    due_date?: string;
    tags?: string[];
    parent?: number;
    pin?: boolean;
    comments?: string[];
  };
  const inbox: InboxSpec[] = [
    // 0: pinned, in_progress, parent of subtasks — exercises the most
    { content: 'Plan home office overhaul', priority: 'P2', status: 'in_progress', tags: ['home'], pin: true,
      comments: ["Shortlist desks under $500", 'Need to measure the wall before ordering'] },
    { content: 'Pick a standing desk', priority: 'P3', status: 'in_progress', parent: 0, tags: ['home'] },          // 1
    { content: 'Order monitor arm', priority: 'P3', status: 'done', parent: 0, tags: ['home'] },                   // 2
    { content: 'Cable management', priority: 'P3', status: 'not_started', parent: 0, tags: ['home'] },             // 3

    // standalones — variety on status, due, tags
    { content: 'Reply to Sebastian about the dataset request', priority: 'P2', status: 'not_started',
      due_date: daysFromNow(-1) },                                                                                 // 4 overdue
    { content: 'Renew domain (openbrain.local) — expires in 12 days', priority: 'P1',
      status: 'not_started', due_date: daysFromNow(12), tags: ['chore'] },                                         // 5 upcoming
    { content: "Read 'On the Measure of Intelligence' (Chollet)", priority: 'P3', status: 'paused',
      tags: ['reading'] },                                                                                          // 6 paused
    { content: 'Buy new mechanical keyboard', priority: 'P3', status: 'done', tags: ['chore'] },                   // 7 done
    { content: 'Schedule annual physical', priority: 'P2', status: 'not_started', due_date: daysFromNow(21),
      tags: ['health'] },                                                                                           // 8 future due
    { content: 'Cancel unused streaming subscription', priority: 'P3', status: 'done',
      comments: ['Done — saved $14/mo'] },                                                                         // 9 done w/ comment
  ];

  const inboxIds: string[] = [];
  for (const t of inbox) {
    const body: Json = { content: t.content, priority: t.priority, tags: t.tags };
    if (t.parent !== undefined) body.parent_id = inboxIds[t.parent];
    if (t.due_date) body.due_date = t.due_date;
    const created = await api<{ todo: { id: string } }>('POST', '/api/v1/todos', body);
    inboxIds.push(created.todo.id);
    if (t.status && t.status !== 'not_started') {
      await api('PUT', `/api/v1/todos/${created.todo.id}`, { status: t.status });
    }
    if (t.pin) {
      await api('POST', `/api/v1/todos/${created.todo.id}/pin`);
    }
    for (const c of t.comments ?? []) {
      await api('POST', `/api/v1/todos/${created.todo.id}/comments`, { content: c });
    }
    const labels = [t.priority, t.status ?? 'not_started', t.parent !== undefined ? `↳ child of #${t.parent}` : null]
      .filter(Boolean).join(' · ');
    console.log(`  + inbox todo [${labels}] "${t.content}"`);
  }

  console.log('\n✓ seed complete');
}

main().catch((err) => {
  console.error('seed failed:', err.message ?? err);
  process.exit(1);
});
