// scripts/seed-local.ts
//
// Populate a fresh local DB with realistic projects/notes/todos/comments.
// Calls the running backend over HTTP — same path the UI takes — so anything
// you add here exercises the real ingest pipeline (LLM stub or real, your choice).
//
// Prereq: backend already running on localhost:3000 with LLM_PROVIDER=stub
// (or real if you want true embeddings). Run with:
//
//   npm run dev:full        # one terminal, brings up compose + backend + frontend
//   npm run seed:local      # another terminal
//
// Idempotent: bails if any project already exists.

const BASE = process.env.OPEN_BRAIN_BASE_URL ?? 'http://localhost:3000';
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
    return;
  }

  // ----- Projects -----
  const projects = [
    { name: 'ClaudePit', description: 'Self-hosted control surface for Claude Code — agent cockpit wrapping the official `claude` CLI in headless mode.', status: 'active' },
    { name: 'Copilot CLI App', description: 'Personal app (web first, eventually mobile) leveraging the GitHub Copilot SDK for an agentic surface across devices.', status: 'active' },
    { name: 'Open Brain 2.5', description: "Testing Open Brain 2.5's entity model while capturing field notes on the migration path.", status: 'active' },
    { name: 'RAG Research', description: 'Hybrid retrieval comparisons — vector vs graph vs reranker.', status: 'active' },
    { name: 'Homelab', description: 'Tailscale + NAS + on-prem inference notes.', status: 'active' },
  ];

  const projectIds: Record<string, string> = {};
  for (const p of projects) {
    const created = await api<{ project: { id: string; name: string } }>('POST', '/api/v1/projects', p);
    projectIds[p.name] = created.project.id;
    console.log(`  + project ${p.name} → ${created.project.id}`);
  }
  const claudepit = projectIds['ClaudePit'];
  const copilot = projectIds['Copilot CLI App'];
  const ob25 = projectIds['Open Brain 2.5'];
  const rag = projectIds['RAG Research'];
  const homelab = projectIds['Homelab'];

  // ----- Notes -----
  const notes = [
    {
      project: claudepit,
      title: 'ClaudePit — High-Level Concept',
      content: '# ClaudePit — High-Level Concept\n\nThe goal is to stop flying blind on what Claude Code is doing in long-running sessions. We wrap `claude` in headless mode and expose every feature through a web UI, then layer a session supervisor that lets us run multiple sessions in parallel without juggling terminal panes.\n\n## Auth\n\nSubscription cookies, never API keys. Tokens minted bound to the cookie and stored in the OS keychain.\n\n## Multi-session\n\nEach session is a process tree under a supervisor. Stdout multiplexed via line-prefixed framing.',
      tags: ['architecture', 'claude-code'],
    },
    {
      project: claudepit,
      title: 'Auth strategy — subscription cookies',
      content: "We mint a session token bound to the subscription cookie and store it in the keychain. No API keys ever touch the wire because (1) the official Claude Code subscription is what users already pay for, and (2) embedding API keys in a self-hosted tool creates a billing surface you don't want to own.",
      tags: ['auth', 'security'],
    },
    {
      project: claudepit,
      title: 'Multi-session parallelism notes',
      content: 'Each session is a process tree under a supervisor. Stdout multiplexed via line-prefixed framing so we can interleave outputs without losing structure. Mobile companion can subscribe to the same stream over Tailscale.',
      tags: ['session-model', 'architecture'],
    },
    {
      project: copilot,
      title: 'Copilot SDK — first impressions',
      content: 'The SDK gives a clean tool-use loop but the streaming surface is still rough. Need to wrap it.',
      tags: ['architecture'],
    },
    {
      project: ob25,
      title: 'Open Brain 2.5 — entity model decisions',
      content: 'Entities live in their own table with chunk_entities edges. RRF fusion over vector + graph. Sequential scan at 3072 dims is fine on B1ms — HNSW init OOMs.',
      tags: ['rag', 'architecture'],
    },
    {
      project: rag,
      title: 'Reranker shootout — early notes',
      content: 'Comparing Cohere rerank, BGE, and a small Anthropic-served prompt-as-reranker. Cohere wins latency, BGE wins cost, prompt-as-reranker wins precision.',
      tags: ['rag', 'research'],
    },
    {
      project: homelab,
      title: 'Tailscale exit nodes — caveats',
      content: 'MagicDNS is great until you have overlapping subnets. Document the conflict-resolution path.',
      tags: ['tailscale', 'mobile'],
    },
  ];

  for (const n of notes) {
    const created = await api<{ id: string; status: string }>('POST', '/api/v1/content', {
      type: 'note',
      title: n.title,
      content: n.content,
      project_ids: [n.project],
      tags: n.tags,
    });
    console.log(`  + note "${n.title}" → ${created.id} (${created.status})`);
  }

  // ----- Todos. API uses `content` for the body field and uppercase P1/P2/P3 -----
  type Pri = 'P1' | 'P2' | 'P3';
  const todos: Array<{ project_id: string; content: string; priority?: Pri; tags?: string[]; parent?: number }> = [
    { project_id: claudepit, content: 'Wire up streaming responses with SSE', priority: 'P1', tags: ['architecture'] },          // 0
    { project_id: claudepit, content: 'Spec the SSE message envelope', priority: 'P2', parent: 0 },                              // 1
    { project_id: claudepit, content: 'Heartbeat + reconnect logic', priority: 'P2', parent: 0 },                                // 2
    { project_id: claudepit, content: 'Client-side replay buffer', priority: 'P3', parent: 0 },                                  // 3
    { project_id: claudepit, content: 'Design session graveyard view', priority: 'P2', tags: ['session-model'] },                // 4
    { project_id: claudepit, content: 'Spike: Tailscale auth handshake', priority: 'P1', tags: ['auth', 'tailscale'] },          // 5
    { project_id: copilot, content: 'Wrap Copilot SDK streaming surface', priority: 'P2', tags: ['architecture'] },              // 6
    { project_id: ob25, content: 'Document the entity-resolution algorithm', priority: 'P2', tags: ['rag'] },                    // 7
    { project_id: rag, content: 'Run reranker latency benchmark on 1k corpus', priority: 'P1', tags: ['rag', 'research'] },      // 8
    { project_id: homelab, content: 'Migrate NAS to ZFS with snapshots', priority: 'P3' },                                       // 9
  ];

  const todoIds: string[] = [];
  for (const t of todos) {
    const body: Json = {
      content: t.content,
      project_id: t.project_id,
      priority: t.priority ?? 'P3',
      tags: t.tags,
    };
    if (t.parent !== undefined) body.parent_id = todoIds[t.parent];
    const created = await api<{ todo: { id: string } }>('POST', '/api/v1/todos', body);
    todoIds.push(created.todo.id);
    console.log(`  + todo "${t.content}"`);
  }

  // ----- A few comments on the SSE todo -----
  const commentsTarget = todoIds[0];
  const comments = [
    'SSE feels right but watch for proxy buffering — nginx defaults will eat events.',
    'Confirmed: had to disable proxy_buffering and set proxy_cache off. Documenting in headless-quirks.',
    'Heartbeat every 15s, reconnect with last-event-id. Patch in the heartbeat subtask.',
  ];
  for (const c of comments) {
    await api('POST', `/api/v1/todos/${commentsTarget}/comments`, { content: c });
  }
  console.log(`  + ${comments.length} comments on SSE todo`);

  // ----- A few personal Inbox todos (no project) -----
  const inbox: Array<{ content: string; priority: Pri; tags?: string[] }> = [
    { content: 'Reply to Sebastian about the dataset request', priority: 'P2' },
    { content: 'Renew domain (openbrain.local) — expires in 12 days', priority: 'P1', tags: ['chore'] },
    { content: "Read 'On the Measure of Intelligence' (Chollet)", priority: 'P3', tags: ['reading'] },
  ];
  for (const t of inbox) {
    await api('POST', '/api/v1/todos', t);
    console.log(`  + inbox todo "${t.content}"`);
  }

  console.log('✓ seed complete');
}

main().catch((err) => {
  console.error('seed failed:', err.message ?? err);
  process.exit(1);
});
