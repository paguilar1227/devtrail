import { useState } from 'react';
import { search, type SearchHit } from '../lib/api';

interface Props {
  projectId?: string;
}

export function SearchBar({ projectId }: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);

  const runSearch = async () => {
    if (!q.trim()) { setResults(null); return; }
    setLoading(true);
    try {
      const res = await search({ query: q, project_id: projectId, limit: 8 });
      setResults(res.hits);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="relative">
        <input
          className="input pl-9"
          placeholder={projectId ? "Search within this project..." : "Search everything..."}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
        />
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">⌕</span>
        {q && (
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 btn-ghost !py-0.5 text-xs"
            onClick={() => { setQ(''); setResults(null); }}
          >
            clear
          </button>
        )}
      </div>

      {loading && <div className="mt-2 text-muted text-sm">Searching...</div>}

      {results && results.length === 0 && !loading && (
        <div className="mt-2 text-muted text-sm">No results.</div>
      )}

      {results && results.length > 0 && (
        <div className="mt-2 space-y-2">
          {results.map((hit, i) => (
            <div key={i} className="card">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted mb-1">
                    {hit.type === 'chunk' ? `${hit.chunk?.parent_type}: ${hit.chunk?.parent_title}` : `todo`}
                    {' • '}
                    {(hit.similarity * 100).toFixed(0)}% match
                  </div>
                  <div className="text-sm line-clamp-3">
                    {hit.type === 'chunk' ? (hit.chunk?.content ?? '[media]') : hit.todo?.content}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
