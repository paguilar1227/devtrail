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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.OPEN_BRAIN_BASE_URL ?? 'http://localhost:3001';
const KEY = process.env.OPEN_BRAIN_API_KEY ?? 'local-dev-key-not-secret';

// Fixtures shared with the e2e test plan — checked-in bytes are deterministic
// given the sources in backend/tests/fixtures/e2e/. Same files cover seed +
// Playwright workflows, so we don't drift between the two.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'backend', 'tests', 'fixtures', 'e2e');

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

// Multipart upload helper for binary documents. Same auth path, but FormData
// instead of JSON body — Node 20+ has FormData/Blob globally.
async function uploadFile<T = Json>(
  fields: Record<string, string>,
  file: { name: string; mime: string },
): Promise<T> {
  const bytes = readFileSync(join(FIXTURES, file.name));
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([bytes], { type: file.mime }), file.name);
  const res = await fetch(`${BASE}/api/v1/content`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
    body: fd,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/v1/content (multipart ${file.name}) → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// Wait for an ingest to leave 'pending'. Ingest is async; for a believable
// seed we want each doc fully chunked + indexed before we move on so the
// Activity feed shows ingest events with real titles, not placeholders.
async function waitForReady(id: string, timeoutMs = 30_000): Promise<{ status: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await api<{ processing_status: string; processing_error?: string }>('GET', `/api/v1/content/${id}/status`);
    if (s.processing_status !== 'pending') return { status: s.processing_status, error: s.processing_error };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { status: 'timeout' };
}

async function ensureBlobContainer(): Promise<void> {
  // The backend doesn't createIfNotExists on startup — in production the
  // container is provisioned by infra. After `docker compose down -v` the
  // Azurite container is gone, so the first multipart upload would 500.
  // Bootstrap it here so seeding from a wiped local DB just works.
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING ??
    'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10010/devstoreaccount1;';
  const name = process.env.AZURE_STORAGE_CONTAINER ?? 'open-brain-content';
  const { BlobServiceClient } = await import('@azure/storage-blob');
  const svc = BlobServiceClient.fromConnectionString(conn);
  const result = await svc.getContainerClient(name).createIfNotExists();
  if (result.succeeded) console.log(`  + created blob container "${name}"`);
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

  await ensureBlobContainer();

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

    // ---- Open Brain 2.5 — one archived to exercise the Archived view ----
    {
      project: ob25,
      title: 'Old chunking strategy (superseded)',
      content: 'Earlier sketch where we chunked at 1000/200 with no sentence-boundary alignment. Killed in favor of 500/100 + sentence-edge align — recall on the OB 2.5 corpus dropped 6 points with the bigger windows. Kept around because future-me will forget why we made the change.',
      tags: ['rag', 'archive'],
      archive: true,
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
  // PERSONAL NOTES (Inbox) — projectless notes to populate the
  // Home Notes widget + Personal Notes drawer. We seed ~30 here so
  // the drawer's infinite-scroll (PAGE_SIZE=20) actually paginates
  // out of the box; without this the personal Inbox feels empty and
  // the scroll behavior can't be exercised. Topics are deliberately
  // varied so the list reads like a real corpus instead of "Note 1,
  // Note 2…".
  // ============================================================
  const personalNoteSpecs: Array<{ title: string; content: string; tags?: string[] }> = [
    { title: 'Reading list — tech', content: '- "Designing Data-Intensive Applications" (Kleppmann)\n- "Database Internals" (Petrov)\n- "The Pragmatic Programmer" (re-read)\n\nQueue: papers on consensus + log-structured storage.', tags: ['reading'] },
    { title: 'Reading list — non-fiction', content: 'Books to pick up next quarter:\n- "Thinking, Fast and Slow"\n- "Why We Sleep"\n- "Range: How Generalists Triumph"', tags: ['reading'] },
    { title: 'Café shortlist for deep-work mornings', content: '1. Verve on Pacific — quiet until 10am, no music, good outlets.\n2. Ritual SOMA — too crowded after 9.\n3. Sightglass — ambient noise tolerable, slow wifi.' },
    { title: 'Standing desk research', content: 'Uplift v2 vs Fully Jarvis vs Flexispot E7:\n- Uplift: best warranty (15y), modular accessories.\n- Jarvis: cheapest, fewer top options.\n- Flexispot: solid but assembly fiddly.\n\nLeaning Uplift in 80x30 bamboo.', tags: ['home'] },
    { title: 'Bookshelf wishlist', content: 'Living room: walnut, 6ft, mid-century legs.\nOffice: white, modular, expandable.\n\nMeasure wall before ordering.', tags: ['home'] },
    { title: 'Plant care notes', content: 'Monstera: water weekly, indirect light.\nSnake plant: every 2-3 weeks, tolerates neglect.\nFiddle leaf fig: SOUTH facing window only, do not move.', tags: ['home'] },
    { title: 'Espresso recipe — Onyx Monarch', content: '18g in, 36g out, 32s.\nWater 94°C. Grind 4.5 on the Niche.\nPaper filter both sides for clarity.' },
    { title: 'Pour-over recipe — Hario V60', content: 'Ratio 1:16. 22g coffee → 350g water.\nBloom 50g, 30s. Then 4 pulses of 75g, 30s apart. Total ~3:00.' },
    { title: 'Weekly review template', content: '1. What moved forward?\n2. What stalled and why?\n3. Top three for next week.\n4. One thing to deprecate.' },
    { title: 'Annual review prompts', content: 'Last year:\n- What surprised me?\n- What did I underrate?\n- What did I overrate?\n\nNext year:\n- One belief I want to test.\n- One habit I want to install.\n- One I want to drop.' },
    { title: 'Hiking — Marin shortlist', content: 'Tennessee Valley → Pirates Cove: 5mi, moderate, ocean.\nMt. Tam East Peak: 6.5mi, steep, big payoff.\nMuir Woods → Cardiac: skip on weekends.' },
    { title: 'Hiking — Sierra trip prep', content: 'Permits: Inyo NF lottery opens Feb.\nGear gaps: bear can (BV500), new map (Mt. Whitney zone).\nTrain: ramp to 12mi with pack by July.' },
    { title: 'Recipe — weeknight ramen', content: 'Stock: chicken + kombu + dried shiitake, 45m.\nTare: shoyu + mirin + sake reduce.\nNoodles: Sun Noodle thin.\nToppings: ajitama, scallion, menma.' },
    { title: 'Recipe — Sunday sourdough', content: 'Levain night before, 100% hydration.\n\n75% hydration dough, 4-fold bulk over 4h.\n\nCold retard overnight. Bake at 500°F covered 20m, 450°F uncovered 25m.' },
    { title: 'Gift ideas — partner', content: 'Birthday in March:\n- Weekend trip up the coast.\n- Cookbook (Roy Choi or Gjelina).\n- Ceramic mug from Heath.' },
    { title: 'Gift ideas — family', content: 'Mom: Kindle case.\nDad: leather wallet (Bellroy).\nSis: photo book of last year.\nNiece: science kit (snap circuits).' },
    { title: 'Birthday tradition planning', content: 'Make a no-phone weekend rule the day after.\nWrite a letter to next-year-self.\nOne new restaurant, one old favorite.' },
    { title: 'Movies queued', content: '- "Past Lives"\n- "The Holdovers"\n- "Anatomy of a Fall"\n- "Perfect Days"\n\nSkip if 90+ Rotten Tomatoes feels stale — pick by mood.' },
    { title: 'Podcasts to try', content: '- "Acquired" (Microsoft series)\n- "Cautionary Tales" (Tim Harford)\n- "Search Engine" (PJ Vogt)' },
    { title: 'Music — recent finds', content: 'On repeat:\n- Faye Webster — "Underdressed at the Symphony"\n- Mk.gee — "Two Star…"\n- Wednesday — "Rat Saw God"' },
    { title: 'Workout block — Q2', content: 'Mon: heavy push.\nTue: trail run easy.\nWed: heavy pull.\nThu: mobility + zone 2 bike.\nFri: legs.\nSat: long run or hike.\nSun: rest.' },
    { title: 'Stretches I keep forgetting', content: '- 90/90 hip rotation\n- Couch stretch (90s/side)\n- Thoracic foam roller pass\n- Shoulder dislocates with band' },
    { title: 'Tax docs checklist', content: '- W-2 (employer)\n- 1099-INT (savings)\n- 1099-DIV (brokerage)\n- 1098 (mortgage)\n- Charitable receipts\n\nDeadline mid-April; do by end of March.', tags: ['chore'] },
    { title: 'Home maintenance schedule', content: 'Quarterly: HVAC filter, smoke detector test.\nBi-annual: gutter clean, water heater flush.\nAnnual: chimney sweep, termite inspect.', tags: ['home', 'chore'] },
    { title: 'Travel — Lisbon trip ideas', content: 'Time Out Market (lunch).\nAlfama walking tour at sunset.\nLX Factory (Sat).\nDay trip Sintra (Pena + Quinta da Regaleira).\nGelato at Nannarella twice.' },
    { title: 'Travel — Tokyo bucket list', content: 'Tsukiji outer market early.\nTeamLab Borderless.\nGolden Gai (one drink, then leave).\nKomeda morning set in Shimokitazawa.\nShinjuku Gyoen for cherry blossoms.' },
    { title: 'Networking follow-ups', content: 'People to ping:\n- Reach back to Maya re: design sync.\n- Intro request to Sam for the LLM eval consultant.\n- Thank-you note to Priya for the referral.' },
    { title: 'Conference talk ideas', content: 'Working titles:\n- "Embedding-first product search: lessons from 1B queries"\n- "Why our agent eval harness keeps catching things humans miss"\n- "Single-user systems are an architectural advantage"' },
    { title: 'Decision journal — May', content: '2026-05-03 — moved investment allocation toward index-heavy. Reasoning: lower stress, can\'t outperform on margins anyway.\n\n2026-05-08 — chose Uplift desk over Jarvis. Reasoning: warranty + modular accessories outweigh price gap.' },
    { title: 'Email cleanup principles', content: 'If older than 6 months and not starred → archive.\nUnsubscribe immediately if I haven\'t opened 3 in a row.\nNo "to-read" pile; either read now or delete.' },
    { title: 'Quotes to remember', content: '"Strong opinions, weakly held." — Saffo\n"The first draft of anything is shit." — Hemingway\n"Compare yourself to who you were yesterday, not to who someone else is today." — Peterson' },
  ];

  for (const n of personalNoteSpecs) {
    const created = await api<{ id: string; status: string }>('POST', '/api/v1/content', {
      type: 'note',
      title: n.title,
      content: n.content,
      project_ids: [],
      tags: n.tags ?? [],
    });
    console.log(`  + personal note "${n.title}"`);
    // No-op the returned id — we don't reference these by handle.
    void created;
  }

  // ============================================================
  // DOCUMENTS — bytes come from backend/tests/fixtures/e2e/ so the seed
  // and the e2e suite share the same artifacts. Each file exercises a
  // distinct ingest path:
  //   sample.pdf  → pdf-parse → multi-chunk
  //   sample.png  → image-only doc (Gemini multimodal in real mode)
  //   sample.wav  → audio-only doc (Gemini multimodal in real mode)
  //   sample.md   → text-only document (the note-as-doc render path)
  // We also include one personal-scope (projectless) text-doc so the
  // Home + Activity views show a doc that isn't tied to a project.
  // ============================================================
  type DocBinarySpec = {
    kind: 'binary';
    projectId: string | null;
    tags: string[];
    pin?: boolean;
    file: { name: string; mime: string };
  };
  type DocTextSpec = {
    kind: 'text';
    projectId: string | null;
    title: string;
    content: string;
    tags: string[];
    pin?: boolean;
  };
  type DocSpec = DocBinarySpec | DocTextSpec;

  const sampleMd = readFileSync(join(FIXTURES, 'sample.md'), 'utf8');

  const docSpecs: DocSpec[] = [
    // PDF → RAG Research: multi-page, multi-chunk, exercises chunker
    {
      kind: 'binary',
      projectId: rag,
      tags: ['reference', 'rag'],
      file: { name: 'sample.pdf', mime: 'application/pdf' },
    },
    // PNG → Open Brain 2.5: image-only, no extractable text in stub mode,
    // exercises the future image-preview path in the doc reader
    {
      kind: 'binary',
      projectId: ob25,
      tags: ['reference', 'pgvector'],
      file: { name: 'sample.png', mime: 'image/png' },
    },
    // WAV → ClaudePit: audio-only, exercises the future audio-preview path.
    // Pinned so it shows up in the Pinned card on the project page.
    {
      kind: 'binary',
      projectId: claudepit,
      tags: ['meeting-notes'],
      pin: true,
      file: { name: 'sample.wav', mime: 'audio/wav' },
    },
    // Markdown body → Open Brain 2.5: text-only document, exercises the
    // MarkdownPreview render path in the drawer. Cross-kind tag `reference`
    // on this + the PDF means the Tags page shows both note and doc counts.
    {
      kind: 'text',
      projectId: ob25,
      title: 'OB 2.5 — sample reference notes',
      content: sampleMd,
      tags: ['reference', 'rag'],
    },
    // Personal-scope text docs: no project membership. Enough rows here to
    // (a) overflow the 6-row cap on the Home Documents column so the
    // "View N more" footer shows, (b) populate the personal-docs drawer
    // with a meaningful list, and (c) mix tags so the Tags page reflects
    // realistic distribution.
    {
      kind: 'text',
      projectId: null,
      title: 'Personal — quick PDF dump notes',
      content:
        '# Random saved snippet\n\nCopy from a PDF I wanted to keep but did not want to file under any project yet. Lives in personal scope. Tagged reading + reference so it shows up in both filter views.',
      tags: ['reading', 'reference'],
    },
    {
      kind: 'text',
      projectId: null,
      title: 'Cold brew ratio + steep times',
      content:
        '# Cold brew\n\n- Ratio: 1:8 coffee to water by weight\n- Steep: 16h at room temp, or 20h in the fridge\n- Filter twice — once paper, once cheesecloth\n- Cut 1:1 with milk when serving',
      tags: ['recipes'],
    },
    {
      kind: 'text',
      projectId: null,
      title: 'macOS keyboard shortcuts I keep forgetting',
      content:
        '# macOS shortcuts\n\n- `⌃⌘Q` — lock screen\n- `⌘⇧.` — show hidden files in Finder\n- `⌃⌘F` — full screen toggle\n- `⌥⌘D` — show/hide Dock\n- `⌘⇧5` — screenshot toolbar (record region)',
      tags: ['reference'],
    },
    {
      kind: 'text',
      projectId: null,
      title: 'Books to read next quarter',
      content:
        '# Reading queue\n\n1. "Designing Data-Intensive Applications" — Kleppmann (re-read ch. 5-7)\n2. "The Tangled Bank" — Carl Zimmer\n3. "How Infrastructure Works" — Deb Chachra\n4. "The Coming Wave" — Mustafa Suleyman',
      tags: ['reading'],
    },
    {
      kind: 'text',
      projectId: null,
      title: 'SF coffee shortlist',
      content:
        '# Deep-work cafés\n\n- Verve on Pacific — quiet until 10am, good outlets\n- Sightglass SOMA — ambient noise tolerable, slow wifi\n- Saint Frank Russian Hill — best espresso, no laptops after 11am\n- Ritual SOMA — too crowded after 9, skip',
      tags: ['reference'],
    },
    {
      kind: 'text',
      projectId: null,
      title: 'Standing desk research',
      content:
        '# Standing desks compared\n\nLeaning Uplift v2 in 80x30 bamboo:\n- Uplift: best warranty (15y), modular accessories\n- Fully Jarvis: cheapest, fewer top options\n- Flexispot E7: solid but assembly fiddly\n\nNext: check Uplift sale around Black Friday.',
      tags: ['reference'],
    },
    {
      kind: 'text',
      projectId: null,
      title: 'ZFS snapshot retention policy (homelab)',
      content:
        '# ZFS snapshots\n\n- Hourly: keep 24\n- Daily: keep 30\n- Weekly: keep 8\n- Monthly: keep 12\n- Send/receive to offsite mirror nightly via tailscale\n\nUse `sanoid` for management, `syncoid` for replication.',
      tags: ['reference'],
    },
    {
      kind: 'text',
      projectId: null,
      title: 'Recipe — weeknight Thai basil chicken',
      content:
        '# Pad krapao\n\n- 1 lb ground chicken (thigh, not breast)\n- 5 cloves garlic, crushed\n- 3-5 Thai chilies, smashed\n- Handful of holy basil (Italian works if needed)\n- 2 tbsp fish sauce, 1 tbsp oyster sauce, 1 tsp sugar\n- High heat, 8 minutes total. Serve over jasmine rice with a fried egg.',
      tags: ['recipes'],
    },
    {
      kind: 'text',
      projectId: null,
      title: 'Gift ideas — dad birthday',
      content:
        '# Dad gift ideas\n\n- That book he mentioned about WWII naval history\n- New leather wallet (his is falling apart)\n- Coffee from Ritual subscription (3 months)\n- Tickets to the SF Symphony Mahler night',
      tags: [],
    },
  ];

  for (const d of docSpecs) {
    const fields: Record<string, string> = { type: 'document' };
    if (d.projectId) fields.project_ids = d.projectId;
    if (d.tags.length > 0) fields.tags = d.tags.join(',');

    let id: string;
    if (d.kind === 'binary') {
      const created = await uploadFile<{ id: string; status: string }>(fields, d.file);
      id = created.id;
      console.log(`  + document ${d.file.name} (${d.file.mime})${d.pin ? ' (pinned)' : ''}`);
    } else {
      const created = await api<{ id: string; status: string }>('POST', '/api/v1/content', {
        type: 'document',
        title: d.title,
        content: d.content,
        project_ids: d.projectId ? [d.projectId] : [],
        tags: d.tags,
      });
      id = created.id;
      console.log(`  + document "${d.title}" (text-only)${d.pin ? ' (pinned)' : ''}`);
    }

    // Wait for processing so subsequent activity events have real titles
    // and chunks are searchable from the moment the UI loads.
    const ready = await waitForReady(id);
    if (ready.status === 'failed') {
      console.warn(`    ! ingest failed: ${ready.error ?? '(no error)'}`);
    } else if (ready.status === 'timeout') {
      console.warn(`    ! ingest timed out after 30s — leaving as pending`);
    }

    if (d.pin) {
      await api('POST', `/api/v1/content/${id}/pin`);
    }
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
    // 1: subtask with its own comments AND a grandchild — exercises
    // depth=2 + comments-on-subtask paths.
    { content: 'Pick a standing desk', priority: 'P3', status: 'in_progress', parent: 0, tags: ['home'],
      comments: ['Compared Uplift v2 vs Fully Jarvis — leaning Uplift for the 80x30 top'] },                       // 1
    { content: 'Measure wall outlet height', priority: 'P3', status: 'not_started', parent: 1, tags: ['home'] },   // 2 grandchild
    { content: 'Order monitor arm', priority: 'P3', status: 'done', parent: 0, tags: ['home'] },                   // 3
    { content: 'Cable management', priority: 'P3', status: 'not_started', parent: 0, tags: ['home'] },             // 4

    // standalones — variety on status, due, tags
    { content: 'Reply to Sebastian about the dataset request', priority: 'P2', status: 'not_started',
      due_date: daysFromNow(-1) },                                                                                 // 5 overdue
    { content: 'Renew domain (openbrain.local) — expires in 12 days', priority: 'P1',
      status: 'not_started', due_date: daysFromNow(12), tags: ['chore'] },                                         // 6 upcoming
    { content: "Read 'On the Measure of Intelligence' (Chollet)", priority: 'P3', status: 'paused',
      tags: ['reading'] },                                                                                          // 7 paused
    { content: 'Buy new mechanical keyboard', priority: 'P3', status: 'done', tags: ['chore'] },                   // 8 done
    { content: 'Schedule annual physical', priority: 'P2', status: 'not_started', due_date: daysFromNow(21),
      tags: ['health'] },                                                                                           // 9 future due
    { content: 'Cancel unused streaming subscription', priority: 'P3', status: 'done',
      comments: ['Done — saved $14/mo'] },                                                                         // 10 done w/ comment
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

  // ============================================================
  // MANUAL ORDER — pin a non-default order on one sibling group so
  // drag-to-reorder (migration 008) has a realistic starting state.
  // Reordering the children of "Plan home office overhaul" to:
  //   Cable management → Order monitor arm → Pick a standing desk
  // (i.e., flipped relative to creation order)
  // ============================================================
  const inboxParent = inboxIds[0];
  const reorderedChildren = [inboxIds[4], inboxIds[3], inboxIds[1]];
  await api('POST', '/api/v1/todos/reorder', {
    parent_id: inboxParent,
    ids: reorderedChildren,
  });
  console.log(`  + manual order set on 3 subtasks of "Plan home office overhaul"`);

  console.log('\n✓ seed complete');
}

main().catch((err) => {
  console.error('seed failed:', err.message ?? err);
  process.exit(1);
});
