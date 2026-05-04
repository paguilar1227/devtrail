import type {
  DocumentItem,
  Note,
  Project,
  SearchHit,
  Todo,
  TodoComment,
} from '../types';

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

export const PROJECTS: Project[] = [
  { id: 'claudepit', name: 'ClaudePit', desc: 'Self-hosted control surface for Claude Code — agent cockpit wrapping the official `claude` CLI in headless mode.', status: 'active', pinned: true, accent: 'magenta', created_at: ago(86400e3 * 14), updated_at: ago(720e3), counts: { docs: 9, notes: 11, todos: 22, done: 9 } },
  { id: 'copilot-cli', name: 'Copilot CLI App', desc: 'Personal app (web first, eventually mobile) that leverages the GitHub Copilot SDK for an agentic surface across devices.', status: 'active', pinned: true, accent: 'violet', created_at: ago(86400e3 * 30), updated_at: ago(7200e3), counts: { docs: 12, notes: 8, todos: 14, done: 6 } },
  { id: 'open-brain-25', name: 'Open Brain 2.5', desc: "Testing OB 2.5's entity model while capturing field notes on the migration path.", status: 'active', pinned: false, accent: 'indigo', created_at: ago(86400e3 * 45), updated_at: ago(86400e3), counts: { docs: 7, notes: 14, todos: 5, done: 3 } },
  { id: 'research-rag', name: 'RAG Research', desc: 'Hybrid retrieval comparisons — vector vs graph vs reranker.', status: 'active', pinned: false, accent: 'cyan', created_at: ago(86400e3 * 60), updated_at: ago(86400e3 * 3), counts: { docs: 18, notes: 6, todos: 4, done: 4 } },
  { id: 'homelab', name: 'Homelab', desc: 'Tailscale + NAS + on-prem inference notes.', status: 'active', pinned: false, accent: 'neutral', created_at: ago(86400e3 * 90), updated_at: ago(86400e3 * 5), counts: { docs: 4, notes: 7, todos: 3, done: 1 } },
  { id: 'mcp-e2e-v2', name: 'MCP E2E Test v2', desc: 'delete me when done — run 2', status: 'archived', pinned: false, accent: 'neutral', created_at: ago(86400e3 * 7), updated_at: ago(86400e3 * 3), counts: { docs: 1, notes: 0, todos: 2, done: 1 } },
];

export const DOCUMENTS: Record<string, DocumentItem[]> = {
  claudepit: [
    { id: 'd-cp-1', title: 'ClaudePit — High-Level Concept', type: 'note-as-doc', mime: 'text/markdown', blob_url: null, source_url: null, size: '12 KB', tags: ['architecture', 'claude-code'], processing_status: 'ready', project_ids: ['claudepit'], pinned: true, published_at: null, created_at: ago(86400e3 * 12), file_hash: '8a1c…f4d2' },
    { id: 'd-cp-2', title: 'Headless Mode Reference', type: 'binary', mime: 'application/pdf', blob_url: 'https://blob/x.pdf', source_url: null, size: '1.2 MB', tags: ['claude-code', 'research'], processing_status: 'ready', project_ids: ['claudepit'], pinned: false, published_at: null, created_at: ago(86400e3 * 8), file_hash: '3f9e…aa01' },
    { id: 'd-cp-3', title: 'Tailscale Mesh Networking — Anthology', type: 'url', mime: 'text/html', blob_url: null, source_url: 'https://tailscale.com/kb', size: '—', tags: ['tailscale', 'mobile'], processing_status: 'ready', project_ids: ['claudepit', 'homelab'], pinned: false, published_at: ago(86400e3 * 30), created_at: ago(86400e3 * 6), file_hash: null },
    { id: 'd-cp-4', title: 'Session Replay Architecture', type: 'note-as-doc', mime: 'text/markdown', blob_url: null, source_url: null, size: '6 KB', tags: ['session-model', 'architecture'], processing_status: 'ready', project_ids: ['claudepit'], pinned: false, published_at: null, created_at: ago(86400e3 * 4), file_hash: null },
    { id: 'd-cp-5', title: 'anthropic-cookbook-tools.pdf', type: 'binary', mime: 'application/pdf', blob_url: 'https://blob/y.pdf', source_url: null, size: '3.1 MB', tags: ['research'], processing_status: 'pending', project_ids: ['claudepit'], pinned: false, published_at: null, created_at: ago(60e3), file_hash: null },
    { id: 'd-cp-6', title: 'old-cli-spec-v1.pdf', type: 'binary', mime: 'application/pdf', blob_url: 'https://blob/z.pdf', source_url: null, size: '0.4 MB', tags: ['claude-code'], processing_status: 'failed', processing_error: 'Embedding service timed out after 30s', project_ids: ['claudepit'], pinned: false, published_at: null, created_at: ago(3600e3), file_hash: null },
  ],
};

export const NOTES: Record<string, Note[]> = {
  claudepit: [
    { id: 'n-cp-1', title: 'ClaudePit — High-Level Concept', body: '# ClaudePit — High-Level Concept\n*Drafted: April 21, 2026*\n\nThe goal is to stop flying blind on what Claude Code is doing in long-running sessions. We wrap `claude` in headless mode and expose every feature through a web UI, then layer a session supervisor that lets us run multiple sessions in parallel without juggling terminal panes.\n\n## Auth\nSubscription cookies, never API keys. Tokens minted bound to the cookie and stored in the OS keychain.\n\n## Multi-session\nEach session is a process tree under a supervisor. Stdout multiplexed via line-prefixed framing.', tags: ['architecture', 'claude-code'], processing_status: 'ready', project_ids: ['claudepit'], pinned: true, created_at: ago(86400e3 * 12), updated_at: ago(2400e3) },
    { id: 'n-cp-2', title: 'Auth strategy — subscription cookies', body: "We mint a session token bound to the subscription cookie and store it in the keychain. No API keys ever touch the wire because (1) the official Claude Code subscription is what users already pay for, and (2) embedding API keys in a self-hosted tool creates a billing surface you don't want to own.", tags: ['auth', 'security'], processing_status: 'ready', project_ids: ['claudepit'], pinned: false, created_at: ago(86400e3 * 11), updated_at: ago(86400e3 * 6) },
    { id: 'n-cp-3', title: 'Multi-session parallelism notes', body: 'Each session is a process tree under a supervisor. Stdout multiplexed via line-prefixed framing so we can interleave outputs without losing structure. Mobile companion can subscribe to the same stream over Tailscale.', tags: ['session-model', 'architecture'], processing_status: 'ready', project_ids: ['claudepit'], pinned: false, created_at: ago(86400e3 * 10), updated_at: ago(86400e3 * 4) },
    { id: 'n-cp-4', title: 'Mobile monitor-only mode', body: 'Read-only stream from desktop relay. Push notifications when sessions complete. No write capability on phone yet — touch is too risky for `rm -rf` style commands.', tags: ['mobile', 'tailscale'], processing_status: 'ready', project_ids: ['claudepit'], pinned: false, created_at: ago(86400e3 * 8), updated_at: ago(86400e3 * 8) },
    { id: 'n-cp-5', title: "Failure modes I've seen", body: 'Headless mode crashes silently when stdin is detached. Need a watchdog. Long sessions OOM after ~6h — investigate whether it’s the LSP servers leaking.', tags: ['architecture', 'ingest'], processing_status: 'pending', project_ids: ['claudepit'], pinned: false, created_at: ago(120e3), updated_at: ago(120e3) },
  ],
};

export const TODOS: Record<string, Todo[]> = {
  claudepit: [
    { id: 't1', title: 'Wire up streaming responses with SSE', status: 'in_progress', priority: 'p1', parent_id: null, project_id: 'claudepit', tags: ['architecture'], pinned: true, due_at: ago(-86400e3 * 2), created_at: ago(86400e3 * 5), comments: 3 },
    { id: 't1a', title: 'Spec the SSE message envelope', status: 'done', priority: 'p2', parent_id: 't1', project_id: 'claudepit', tags: [], pinned: false, due_at: null, created_at: ago(86400e3 * 4), comments: 0 },
    { id: 't1b', title: 'Heartbeat + reconnect logic', status: 'in_progress', priority: 'p2', parent_id: 't1', project_id: 'claudepit', tags: [], pinned: false, due_at: ago(-86400e3 * 1), created_at: ago(86400e3 * 3), comments: 1 },
    { id: 't1c', title: 'Client-side replay buffer', status: 'not_started', priority: 'p3', parent_id: 't1', project_id: 'claudepit', tags: [], pinned: false, due_at: null, created_at: ago(86400e3 * 2), comments: 0 },
    { id: 't1b1', title: 'Last-event-id support', status: 'in_progress', priority: 'p2', parent_id: 't1b', project_id: 'claudepit', tags: [], pinned: false, due_at: null, created_at: ago(86400e3 * 2), comments: 0 },
    { id: 't1b2', title: 'Exponential backoff w/ jitter', status: 'not_started', priority: 'p3', parent_id: 't1b', project_id: 'claudepit', tags: [], pinned: false, due_at: null, created_at: ago(86400e3 * 2), comments: 0 },
    { id: 't1b1a', title: 'Persist cursor in IndexedDB', status: 'not_started', priority: 'p3', parent_id: 't1b1', project_id: 'claudepit', tags: [], pinned: false, due_at: null, created_at: ago(86400e3 * 1), comments: 0 },
    { id: 't1b1b', title: 'Verify replay against server log', status: 'not_started', priority: 'p3', parent_id: 't1b1', project_id: 'claudepit', tags: [], pinned: false, due_at: null, created_at: ago(86400e3 * 1), comments: 0 },
    { id: 't2', title: 'Design session graveyard view', status: 'in_progress', priority: 'p2', parent_id: null, project_id: 'claudepit', tags: ['session-model'], pinned: false, due_at: ago(-86400e3 * 5), created_at: ago(86400e3 * 6), comments: 0 },
    { id: 't3', title: 'Spike: Tailscale auth handshake', status: 'not_started', priority: 'p1', parent_id: null, project_id: 'claudepit', tags: ['auth', 'tailscale'], pinned: false, due_at: ago(-86400e3 * 1), created_at: ago(86400e3 * 4), comments: 1 },
    { id: 't4', title: 'Document headless mode quirks', status: 'not_started', priority: 'p2', parent_id: null, project_id: 'claudepit', tags: ['claude-code'], pinned: false, due_at: null, created_at: ago(86400e3 * 3), comments: 0 },
    { id: 't5', title: 'Migrate to subscription cookies', status: 'done', priority: 'p1', parent_id: null, project_id: 'claudepit', tags: ['auth'], pinned: false, due_at: ago(86400e3 * 6), created_at: ago(86400e3 * 12), comments: 2 },
    { id: 't6', title: 'POC: parallel session multiplexer', status: 'done', priority: 'p2', parent_id: null, project_id: 'claudepit', tags: ['session-model'], pinned: false, due_at: ago(86400e3 * 8), created_at: ago(86400e3 * 14), comments: 0 },
  ],
};

export const COMMENTS: Record<string, TodoComment[]> = {
  t1: [
    { id: 'c1', todo_id: 't1', content: 'SSE feels right but watch for proxy buffering — nginx defaults will eat events.', at: ago(3600e3) },
    { id: 'c2', todo_id: 't1', content: 'Confirmed: had to disable proxy_buffering and set proxy_cache off. Documenting in headless-quirks.', at: ago(2400e3) },
    { id: 'c3', todo_id: 't1', content: 'Heartbeat every 15s, reconnect with last-event-id. Patch in t1b.', at: ago(900e3) },
  ],
};

export const SEARCH_HITS: SearchHit[] = [
  { id: 'h1', entity_kind: 'note', entity_id: 'n-cp-2', title: 'Auth strategy — subscription cookies', project: 'ClaudePit', excerpt: 'We mint a session token bound to the <em>subscription cookie</em> and store it in the keychain. No <em>API keys</em> ever touch the wire because the official Claude Code subscription is what users already pay for…', retrieval_path: ['vector'], score: 0.94 },
  { id: 'h2', entity_kind: 'document', entity_id: 'd-cp-1', title: 'ClaudePit — High-Level Concept', project: 'ClaudePit', excerpt: '## Auth\n<em>Subscription cookies</em>, never API keys. Tokens minted bound to the cookie and stored in the OS keychain.', retrieval_path: ['vector', 'graph'], score: 0.91 },
  { id: 'h3', entity_kind: 'todo', entity_id: 't5', title: 'Migrate to subscription cookies', project: 'ClaudePit', excerpt: 'Status: done · Closed 6 days ago. Linked to <em>auth</em> and <em>security</em>.', retrieval_path: ['graph'], score: 0.84 },
  { id: 'h4', entity_kind: 'document', entity_id: 'd-cp-2', title: 'Headless Mode Reference', project: 'ClaudePit', excerpt: '…the headless flag accepts <em>--auth-mode=cookie</em> or <em>--auth-mode=key</em>. Cookie mode reads from $XDG_CONFIG_HOME/claude…', retrieval_path: ['vector'], score: 0.79 },
  { id: 'h5', entity_kind: 'note', entity_id: 'n-cp-4', title: 'Mobile monitor-only mode', project: 'ClaudePit', excerpt: 'Read-only stream from desktop relay. <em>Auth</em> via Tailscale magic-DNS keeps it simple.', retrieval_path: ['graph'], score: 0.71 },
];
