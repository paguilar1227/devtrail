import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { listTags } from './api';
import { useTagSuggestions } from './useTagSuggestions';

vi.mock('./api', () => ({ listTags: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('refreshes shared tags when a browse surface opens after an external save', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const tag = (name: string) => ({ name, total: 1, by_type: { note: 1, document: 0, todo: 0 } });
  vi.mocked(listTags).mockResolvedValueOnce([tag('existing')]).mockResolvedValue([tag('existing'), tag('new-agent-tag')]);
  const home = renderHook(() => useTagSuggestions({ scope: 'personal', type: 'note' }), { wrapper });
  await waitFor(() => expect(home.result.current.map(row => row.name)).toEqual(['existing']));

  const notes = renderHook(() => useTagSuggestions({ scope: 'personal', type: 'note' }), { wrapper });
  await waitFor(() => expect(notes.result.current.map(row => row.name)).toContain('new-agent-tag'));
  expect(home.result.current.map(row => row.name)).toContain('new-agent-tag');
});
