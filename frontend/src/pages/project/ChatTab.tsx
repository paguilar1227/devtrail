import { useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/Icons';
import { cls } from '../../lib/util';
import type { ChatMessageT, Project } from '../../types';

const SEED_MESSAGES: ChatMessageT[] = [
  {
    id: 'm1',
    role: 'user',
    text: "How am I authenticating to Claude in headless mode? I want to make sure I haven't accidentally introduced an API key path.",
  },
  {
    id: 'm2',
    role: 'assistant',
    text:
      "You're using subscription cookies — not API keys. The cookie is read from the OS keychain at session start, then a short-lived session token is minted and bound to it. The headless `--auth-mode=cookie` flag is what enforces this; the alternate `--auth-mode=key` exists in the binary but is never invoked from your codebase.\n\nTwo small risks worth flagging: (1) the cookie's expiry isn't surfaced anywhere in the UI yet, so a silently-expired cookie will look like a generic auth failure; (2) the keychain read happens lazily, so first-request latency includes a one-time keychain prompt on macOS.",
    citations: [
      {
        id: 'h2',
        num: 1,
        title: 'ClaudePit — High-Level Concept',
        path: 'note · n-cp-1',
        chunk: '## Auth\n<em>Subscription cookies, never API keys.</em> Tokens minted bound to the cookie and stored in the OS keychain.',
        score: 0.91,
      },
      {
        id: 'h1',
        num: 2,
        title: 'Auth strategy — subscription cookies',
        path: 'note · n-cp-2',
        chunk:
          'We mint a session token bound to the <em>subscription cookie</em> and store it in the keychain. No <em>API keys</em> ever touch the wire because the official Claude Code subscription is what users already pay for.',
        score: 0.94,
      },
      {
        id: 'h4',
        num: 3,
        title: 'Headless Mode Reference',
        path: 'doc · d-cp-2',
        chunk: '…the headless flag accepts <em>--auth-mode=cookie</em> or <em>--auth-mode=key</em>. Cookie mode reads from $XDG_CONFIG_HOME/claude…',
        score: 0.79,
      },
    ],
    timing: { retrieval_ms: 184, generation_ms: 2410, chunks: 12 },
  },
];

interface Props {
  project: Project;
}

export function ChatTab({ project }: Props) {
  const [messages, setMessages] = useState<ChatMessageT[]>(SEED_MESSAGES);
  const [draft, setDraft] = useState('');
  const [depth, setDepth] = useState<'shallow' | 'balanced' | 'deep'>('balanced');
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const send = () => {
    if (!draft.trim()) return;
    const next: ChatMessageT[] = [...messages, { id: `u${Date.now()}`, role: 'user', text: draft }];
    setMessages(next);
    setDraft('');
    setPending(true);
    setTimeout(() => {
      setMessages([
        ...next,
        {
          id: `a${Date.now()}`,
          role: 'assistant',
          text:
            'Mocked response — in production this would stream chunks of generated text in real time, with citations resolving inline as retrieval completes. The retrieval tier blends vector similarity, graph adjacency through your tags, and FTS, then a small reranker sorts the top 12 chunks before the model sees them.',
          citations: [
            {
              id: 'x',
              num: 1,
              title: 'Tailscale Mesh Networking — Anthology',
              path: 'doc · d-cp-3',
              chunk:
                'Magic DNS resolves <em>node names to MagicDNS hostnames</em> within a tailnet, which is why the desktop relay can be reached as `claudepit.tailnet.ts.net` from the phone.',
              score: 0.81,
            },
          ],
          timing: { retrieval_ms: 156, generation_ms: 1890, chunks: 8 },
        },
      ]);
      setPending(false);
    }, 1200);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, pending]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '60vh' }}>
      <div ref={scrollRef} style={{ flex: 1 }}>
        <div className="chat">
          {messages.length === 0 && (
            <div className="chat-empty">
              <div className="ic-circle">
                <Icons.Sparkle size={20} />
              </div>
              <h3>Ask about {project.name}</h3>
              <p>Chat is grounded only in this project's documents, notes, and todos. Citations expand inline so you can verify every claim.</p>
              <div className="chat-suggest">
                <div className="s">
                  <div className="lb">Auth</div>How am I authenticating to Claude?
                </div>
                <div className="s">
                  <div className="lb">Architecture</div>Walk me through the multi-session model.
                </div>
                <div className="s">
                  <div className="lb">Open todos</div>What's blocking the SSE work?
                </div>
                <div className="s">
                  <div className="lb">Failure modes</div>What gotchas have I logged?
                </div>
              </div>
            </div>
          )}
          {messages.map(m => (
            <ChatMessage key={m.id} m={m} />
          ))}
          {pending && (
            <div className="msg">
              <div className="msg-avatar">
                <Icons.Sparkle size={13} />
              </div>
              <div className="msg-bubble">
                <div className="dots">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={`Ask ${project.name}…`}
            rows={1}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-tools">
            <div className="depth-pill">
              <button className={depth === 'shallow' ? 'active' : ''} onClick={() => setDepth('shallow')}>Shallow</button>
              <button className={depth === 'balanced' ? 'active' : ''} onClick={() => setDepth('balanced')}>Balanced</button>
              <button className={depth === 'deep' ? 'active' : ''} onClick={() => setDepth('deep')}>Deep</button>
            </div>
            <button className="btn btn-primary btn-icon" onClick={send} disabled={!draft.trim()}>
              <Icons.Send />
            </button>
          </div>
        </div>
        <div
          className="row-flex gap-3"
          style={{ marginTop: 6, fontSize: 10.5, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}
        >
          <span>scope: {project.name}</span>
          <span>retrieval: vector + graph</span>
          <span>chunks: top 12</span>
          <span style={{ marginLeft: 'auto' }}>⌘↵ to send · ⇧↵ for newline</span>
        </div>
      </div>
    </div>
  );
}

function ChatMessage({ m }: { m: ChatMessageT }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));
  const togg = (i: number) =>
    setExpanded(s => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  return (
    <div className={cls('msg', m.role)}>
      <div className="msg-avatar">{m.role === 'user' ? 'P' : <Icons.Sparkle size={13} />}</div>
      <div style={{ minWidth: 0, flex: 1, maxWidth: 680 }}>
        <div className="msg-bubble" style={{ whiteSpace: 'pre-wrap' }}>
          {m.text}
        </div>
        {m.citations ? (
          <div className="citations">
            {m.citations.map((c, i) => (
              <div key={c.id} className="cite-row">
                <div className="cite-head" onClick={() => togg(i)}>
                  <span className="cite-num">{c.num}</span>
                  <span className="nm">{c.title}</span>
                  <span className="pth">{c.path}</span>
                  <span className="subtle mono" style={{ fontSize: 10 }}>
                    {c.score.toFixed(2)}
                  </span>
                  <span style={{ color: 'var(--fg-subtle)', marginLeft: 4 }}>
                    {expanded.has(i) ? <Icons.ChevronDown size={12} /> : <Icons.ChevronRight size={12} />}
                  </span>
                </div>
                {expanded.has(i) ? (
                  <div className="cite-chunk" dangerouslySetInnerHTML={{ __html: c.chunk }} />
                ) : null}
                {expanded.has(i) ? (
                  <div className="cite-foot">
                    <span>retrieval: vector</span>
                    <span>· chunk 3 of 7</span>
                    <span style={{ marginLeft: 'auto' }} className="row-flex gap-1">
                      <button className="btn btn-ghost btn-sm">Open source</button>
                      <button className="btn btn-ghost btn-sm">Find more like this</button>
                    </span>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {m.timing ? (
          <div className="timing-foot">
            <span>retrieval {m.timing.retrieval_ms}ms</span>
            <span>· generation {m.timing.generation_ms}ms</span>
            <span>· {m.timing.chunks} chunks</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
