// Search surface for Open Brain. Lives inside the shared <Drawer/>
// primitive — that gives us mobile fullscreen + the desktop expand
// toggle + role="dialog" + the slide-in animation, all without
// re-implementing them. The drawer holds query state local to the
// open instance so it doesn't pollute global state when dismissed.
//
// Project scope semantics:
//   'all'      → no project filter (global)
//   'personal' → project_id='null' on the wire — backend interprets
//                that as the no-project predicate
//   <uuid>     → single project filter (also set by `project:<name>`
//                DSL predicate; predicate overrides the chip toggle)
//
// Universal search DSL (parsed via searchSyntax.ts):
//   #<tag>          → tags[] filter
//   in:<type>       → entity_types[] filter
//   @<name>         → content_item_ids[] filter (resolved client-side)
//   project:<name>  → project_id (first match resolved client-side)
//   -<sigil>...     → routed to the matching exclusion bucket
//   anything else   → free-text semantic query
//
// All predicates render as removable chips above the results, with
// positive vs excluded styling. Backend filtering of all these fields
// is implemented in services/search.ts.

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Drawer, FilterChip } from '../primitives';
import { Icons } from '../Icons';
import { SearchResultsList } from '../SearchResultsList';
import { listContent, listProjects, listTags, search } from '../../lib/api';
import { toUiSearchHit } from '../../lib/view';
import { SearchInput, type MentionTarget, type ProjectSuggestion, type TagSuggestion } from '../SearchInput';
import {
  parseSearchSyntax,
  removeTagFromQuery,
  removeTypeFromQuery,
  removeMentionFromQuery,
  removeProjectFromQuery,
  removeExcludedFromQuery,
} from '../../lib/searchSyntax';

type Scope = 'all' | 'personal' | string;

interface Props {
  initialQuery?: string;
  initialScope?: Scope;
  onClose: () => void;
}

export function SearchDrawer({ initialQuery = '', initialScope = 'all', onClose }: Props) {
  const [draft, setDraft] = useState(initialQuery);
  const [submitted, setSubmitted] = useState(initialQuery);
  const [scope, setScope] = useState<Scope>(initialScope);

  useEffect(() => {
    setDraft(initialQuery);
    setSubmitted(initialQuery);
    setScope(initialScope);
  }, [initialQuery, initialScope]);

  // Data sources for typeahead. Drawer is self-contained so it fetches
  // its own — global scope so the typeahead surfaces everything regardless
  // of the current project filter (you might want to MENTION a doc that
  // lives in another project to add it to the scope).
  const { data: projects } = useQuery({ queryKey: ['projects', 'all'], queryFn: () => listProjects() });
  const { data: tagsApi } = useQuery({ queryKey: ['tags', 'all'], queryFn: () => listTags() });
  const { data: docsApi } = useQuery({
    queryKey: ['content', 'documents', 'all'],
    queryFn: () => listContent({ type: 'document' }),
  });
  const { data: notesApi } = useQuery({
    queryKey: ['content', 'notes', 'all'],
    queryFn: () => listContent({ type: 'note' }),
  });

  const projectsById = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p])),
    [projects],
  );
  const projectSuggestions = useMemo<ProjectSuggestion[]>(
    () => (projects ?? [])
      .filter((p) => p.status === 'active')
      .map((p) => ({ id: p.id, name: p.name })),
    [projects],
  );
  const tagSuggestions = useMemo<TagSuggestion[]>(
    () => (tagsApi ?? [])
      .filter((t) => t.total > 0)
      .sort((a, b) => b.total - a.total)
      .map((t) => ({ name: t.name, total: t.total })),
    [tagsApi],
  );
  const mentionTargets = useMemo<MentionTarget[]>(() => {
    const docs: MentionTarget[] = (docsApi ?? []).map((d) => ({ id: d.id, title: d.title, kind: 'document' }));
    const notes: MentionTarget[] = (notesApi ?? []).map((n) => ({ id: n.id, title: n.title, kind: 'note' }));
    return [...docs, ...notes].sort((a, b) => a.title.localeCompare(b.title));
  }, [docsApi, notesApi]);

  const parsed = useMemo(() => parseSearchSyntax(submitted), [submitted]);

  // Resolve @-mentions to content_item_ids via case-insensitive title match.
  // Multiple titles can match the same string — include all matches; backend
  // ANY()'s the list. Unresolved mention names drop silently (user might
  // be mid-typing or the entity was archived).
  const { contentItemIds, excludedContentItemIds } = useMemo(() => {
    const matchByTitle = (name: string): string[] => {
      const lower = name.toLowerCase();
      return mentionTargets.filter((m) => m.title.toLowerCase() === lower).map((m) => m.id);
    };
    return {
      contentItemIds: parsed.mentions.flatMap(matchByTitle),
      excludedContentItemIds: parsed.excludedMentions.flatMap(matchByTitle),
    };
  }, [parsed.mentions, parsed.excludedMentions, mentionTargets]);

  // Resolve `project:<name>` → project_id. First positive match wins
  // (backend takes a single project_id). When the DSL predicate is
  // present, it OVERRIDES the scope chip toggle so the search bar is
  // the source of truth.
  const projectIdFromPredicate = useMemo<string | null | undefined>(() => {
    if (parsed.projects.length === 0) return undefined;
    const first = parsed.projects[0]!.toLowerCase();
    const match = projectSuggestions.find((p) => p.name.toLowerCase() === first);
    return match?.id;
  }, [parsed.projects, projectSuggestions]);

  // Effective project_id sent on the wire: predicate wins, else chip toggle.
  const effectiveProjectId =
    projectIdFromPredicate !== undefined
      ? projectIdFromPredicate
      : scope === 'all'
        ? undefined
        : scope === 'personal'
          ? 'null'
          : scope;

  const { data: hitsApi, isFetching, error } = useQuery({
    queryKey: [
      'search',
      submitted,
      effectiveProjectId ?? 'all',
      parsed.tags.join(','),
      parsed.types.join(','),
      contentItemIds.join(','),
      parsed.excludedTags.join(','),
      parsed.excludedTypes.join(','),
      excludedContentItemIds.join(','),
    ],
    queryFn: () =>
      search({
        query: parsed.text || submitted,
        project_id: effectiveProjectId as 'null' | string | undefined,
        tags: parsed.tags.length > 0 ? parsed.tags : undefined,
        entity_types: parsed.types.length > 0 ? parsed.types : undefined,
        content_item_ids: contentItemIds.length > 0 ? contentItemIds : undefined,
        excluded_tags: parsed.excludedTags.length > 0 ? parsed.excludedTags : undefined,
        excluded_entity_types: parsed.excludedTypes.length > 0 ? parsed.excludedTypes : undefined,
        excluded_content_item_ids: excludedContentItemIds.length > 0 ? excludedContentItemIds : undefined,
        limit: 20,
      }),
    enabled:
      parsed.text.trim().length > 0
      || parsed.tags.length > 0
      || parsed.types.length > 0
      || parsed.mentions.length > 0
      || parsed.projects.length > 0
      || parsed.excludedTags.length > 0
      || parsed.excludedTypes.length > 0
      || parsed.excludedMentions.length > 0,
  });
  const hits = useMemo(
    () => (hitsApi ?? []).map((h) => toUiSearchHit(h, projectsById)),
    [hitsApi, projectsById],
  );

  const submit = () => setSubmitted(draft);
  const updateBoth = (next: string) => {
    setDraft(next);
    setSubmitted(next);
  };

  const hasPredicates =
    parsed.tags.length > 0
    || parsed.types.length > 0
    || parsed.mentions.length > 0
    || parsed.projects.length > 0
    || parsed.excludedTags.length > 0
    || parsed.excludedTypes.length > 0
    || parsed.excludedMentions.length > 0
    || parsed.excludedProjects.length > 0;
  const hasAnySignal = parsed.text.trim().length > 0 || hasPredicates;

  return (
    <Drawer title="Search" onClose={onClose}>
      <div className="search-drawer-body">
        <div className="search-drawer-input">
          <Icons.Search />
          <SearchInput
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            tags={tagSuggestions}
            mentions={mentionTargets}
            projects={projectSuggestions}
            placeholder="Search… try #tag, in:todo, @docname, project:name, -#exclude"
          />
        </div>
        {hasPredicates ? (
          <div className="search-drawer-predicates" aria-label="Active scope">
            {parsed.tags.map((tag) => (
              <button
                key={`tag-${tag}`}
                type="button"
                className="search-predicate-chip"
                onClick={() => updateBoth(removeTagFromQuery(submitted, tag))}
                aria-label={`Remove tag filter ${tag}`}
              >
                #{tag} <Icons.X size={10} aria-hidden />
              </button>
            ))}
            {parsed.types.map((type) => (
              <button
                key={`type-${type}`}
                type="button"
                className="search-predicate-chip"
                onClick={() => updateBoth(removeTypeFromQuery(submitted, type))}
                aria-label={`Remove type filter ${type}`}
              >
                in:{type} <Icons.X size={10} aria-hidden />
              </button>
            ))}
            {parsed.mentions.map((name) => (
              <button
                key={`mention-${name}`}
                type="button"
                className="search-predicate-chip"
                onClick={() => updateBoth(removeMentionFromQuery(submitted, name))}
                aria-label={`Remove mention filter ${name}`}
              >
                @{name} <Icons.X size={10} aria-hidden />
              </button>
            ))}
            {parsed.projects.map((name) => (
              <button
                key={`project-${name}`}
                type="button"
                className="search-predicate-chip"
                onClick={() => updateBoth(removeProjectFromQuery(submitted, name))}
                aria-label={`Remove project filter ${name}`}
              >
                project:{name} <Icons.X size={10} aria-hidden />
              </button>
            ))}
            {parsed.excludedTags.map((tag) => (
              <button
                key={`ex-tag-${tag}`}
                type="button"
                className="search-predicate-chip excluded"
                onClick={() => updateBoth(removeExcludedFromQuery(submitted, 'tag', tag))}
                aria-label={`Remove exclusion ${tag}`}
              >
                -#{tag} <Icons.X size={10} aria-hidden />
              </button>
            ))}
            {parsed.excludedTypes.map((type) => (
              <button
                key={`ex-type-${type}`}
                type="button"
                className="search-predicate-chip excluded"
                onClick={() => updateBoth(removeExcludedFromQuery(submitted, 'type', type))}
                aria-label={`Remove type exclusion ${type}`}
              >
                -in:{type} <Icons.X size={10} aria-hidden />
              </button>
            ))}
            {parsed.excludedMentions.map((name) => (
              <button
                key={`ex-mention-${name}`}
                type="button"
                className="search-predicate-chip excluded"
                onClick={() => updateBoth(removeExcludedFromQuery(submitted, 'mention', name))}
                aria-label={`Remove mention exclusion ${name}`}
              >
                -@{name} <Icons.X size={10} aria-hidden />
              </button>
            ))}
            {parsed.excludedProjects.map((name) => (
              <button
                key={`ex-project-${name}`}
                type="button"
                className="search-predicate-chip excluded"
                onClick={() => updateBoth(removeExcludedFromQuery(submitted, 'project', name))}
                aria-label={`Remove project exclusion ${name}`}
              >
                -project:{name} <Icons.X size={10} aria-hidden />
              </button>
            ))}
          </div>
        ) : null}
        <div className="search-drawer-scope">
          <FilterChip active={scope === 'all'} onClick={() => setScope('all')}>
            All projects
          </FilterChip>
          <FilterChip active={scope === 'personal'} onClick={() => setScope('personal')}>
            Personal
          </FilterChip>
          {(projects ?? []).filter((p) => p.status === 'active').map((p) => (
            <FilterChip key={p.id} active={scope === p.id} onClick={() => setScope(p.id)}>
              {p.name}
            </FilterChip>
          ))}
        </div>
        <div className="search-drawer-results">
          {error ? (
            <div className="page-subtle search-drawer-error">
              Search failed: {error instanceof Error ? error.message : String(error)}
            </div>
          ) : !hasAnySignal ? (
            <div className="page-subtle">Type a query and press Enter. Try `#tag`, `in:todo`, `@docname`, `project:name`, or `-#exclude`.</div>
          ) : isFetching ? (
            <div className="page-subtle">Searching…</div>
          ) : hits.length === 0 ? (
            <div className="page-subtle">No results.</div>
          ) : (
            <>
              <div className="subtle results-count">{hits.length} results</div>
              <SearchResultsList hits={hits} />
            </>
          )}
        </div>
      </div>
    </Drawer>
  );
}
