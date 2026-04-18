import { useState } from 'react';
import { rag, type Citation } from '../lib/api';
import ReactMarkdown from 'react-markdown';

interface Props {
  projectId: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
}

export function ChatTab({ projectId }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const send = async () => {
    if (!input.trim() || loading) return;
    const question = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setLoading(true);
    try {
      const res = await rag({ question, project_id: projectId });
      setMessages((prev) => [...prev, { role: 'assistant', content: res.answer, citations: res.citations }]);
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[60vh]">
      <div className="flex-1 overflow-y-auto space-y-4 pb-4">
        {messages.length === 0 && (
          <div className="card text-muted text-sm">
            Ask a question about this project. The AI will search documents, notes, and todos in this project to answer.
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
            <div className={`max-w-full ${
              m.role === 'user'
                ? 'card bg-accent/20 border-accent/40 max-w-[80%]'
                : 'card'
            }`}>
              <div className="text-xs text-muted mb-1 uppercase tracking-wide">
                {m.role === 'user' ? 'You' : 'Open Brain'}
              </div>
              <div className="prose prose-invert prose-sm max-w-none">
                <ReactMarkdown>{m.content}</ReactMarkdown>
              </div>
              {m.citations && m.citations.length > 0 && (
                <div className="mt-3 pt-3 border-t border-border">
                  <div className="text-xs text-muted mb-2">Sources:</div>
                  <div className="space-y-1">
                    {m.citations.map((c, j) => (
                      <div key={j} className="text-xs text-muted">
                        [{j + 1}] <span className="text-text">{c.title}</span> ({c.type}, {(c.similarity * 100).toFixed(0)}% match)
                        {c.source_url && (
                          <> · <a
                            href={c.source_url}
                            target="_blank"
                            rel="noopener"
                            className="underline hover:text-accent"
                          >{chatDomainOf(c.source_url)}</a></>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && <div className="card text-muted text-sm">Thinking...</div>}
      </div>

      <div className="flex gap-2 pt-3 border-t border-border">
        <input
          className="input"
          placeholder="Ask about this project..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={loading}
        />
        <button className="btn" onClick={send} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

function chatDomainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
