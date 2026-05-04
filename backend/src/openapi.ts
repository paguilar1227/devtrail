// src/openapi.ts
//
// OpenAPI 3.1 spec + Swagger UI. Hand-rolled (open-toolkit pattern) — the
// route set is small and stable enough that a literal dict beats a
// runtime-validation refactor for our scale. Update SPEC below when you
// add/change a /api/v1/* route. The Hono handlers in app.ts are the source
// of truth for behavior; this file describes the contract for clients.
//
// Mounted at:
//   GET /api/openapi.json   the spec
//   GET /api/docs           Swagger UI (loads spec via the URL token)
//
// Both are auth-gated by the existing Bearer middleware. Swagger UI passes
// `?key=<token>` from the page URL into all "Try it out" requests so the
// docs page is operable behind auth without re-auth on every reload.

export const SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'Open Brain',
    version: '2.0.0',
    description:
      'Personal knowledge base + productivity tool — projects, documents, ' +
      'notes, todos, hybrid vector+graph search, and RAG synthesis. All ' +
      '/api/v1/* routes require Bearer auth (Authorization header or ' +
      '?key= query param). Soft-delete by default (?hard=true for permanent).',
  },
  servers: [{ url: '/', description: 'Same-origin' }],
  components: {
    securitySchemes: {
      BearerAuth: { type: 'http', scheme: 'bearer' },
      QueryKey: { type: 'apiKey', in: 'query', name: 'key' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
      },
      Project: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['active', 'archived', 'completed'] },
          archived: { type: 'boolean' },
          pinned_at: { type: 'string', format: 'date-time', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'name', 'status', 'archived', 'created_at', 'updated_at'],
      },
      ContentItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['document', 'note'] },
          title: { type: 'string' },
          title_source: { type: 'string', enum: ['user', 'auto'], nullable: true },
          content: { type: 'string', nullable: true },
          blob_url: { type: 'string', nullable: true },
          source_url: { type: 'string', nullable: true },
          mime_type: { type: 'string', nullable: true },
          file_hash: { type: 'string', nullable: true },
          project_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
          tags: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object', nullable: true },
          processing_status: {
            type: 'string',
            enum: ['pending', 'ready', 'failed'],
            description:
              'Async ingest state. POST /content returns 202 + pending; ' +
              'poll /content/:id/status until ready or failed.',
          },
          processing_error: { type: 'string', nullable: true },
          archived: { type: 'boolean' },
          pinned_at: { type: 'string', format: 'date-time', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
          ingest_completed_at: { type: 'string', format: 'date-time', nullable: true },
        },
        required: ['id', 'type', 'title', 'project_ids', 'tags', 'processing_status', 'archived', 'created_at'],
      },
      Todo: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          content: { type: 'string' },
          project_id: { type: 'string', format: 'uuid', nullable: true },
          parent_id: { type: 'string', format: 'uuid', nullable: true },
          section: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['not_started', 'in_progress', 'paused', 'done'] },
          priority: { type: 'string', enum: ['P1', 'P2', 'P3'], nullable: true },
          due_date: { type: 'string', format: 'date', nullable: true },
          tags: { type: 'array', items: { type: 'string' } },
          archived: { type: 'boolean' },
          pinned_at: { type: 'string', format: 'date-time', nullable: true },
          comment_count: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'content', 'status', 'tags', 'archived', 'created_at'],
      },
      TodoComment: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          todo_id: { type: 'string', format: 'uuid' },
          content: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'todo_id', 'content', 'created_at'],
      },
      SearchHit: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['chunk', 'todo'] },
          similarity: { type: 'number' },
          final_score: { type: 'number' },
          vector_score: { type: 'number', nullable: true },
          retrieval_path: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                step: { type: 'string', enum: ['vector', 'graph', 'rrf'] },
                score: { type: 'number' },
                via_entity: { type: 'string', nullable: true },
              },
            },
          },
          chunk: { type: 'object', nullable: true },
          todo: { type: 'object', nullable: true },
        },
        required: ['type', 'similarity', 'retrieval_path'],
      },
      RagResponse: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
          citations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                content_item_id: { type: 'string', format: 'uuid' },
                title: { type: 'string' },
                excerpt: { type: 'string' },
                source_url: { type: 'string', nullable: true },
              },
            },
          },
          used_chunks: { type: 'integer' },
          meta: {
            type: 'object',
            properties: {
              depth_used: { type: 'string', enum: ['fast', 'thorough'] },
              depth_reason: { type: 'string' },
              timings_ms: { type: 'object' },
            },
          },
        },
        required: ['answer', 'citations', 'used_chunks', 'meta'],
      },
      ActivityEvent: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['ingest', 'edit', 'comment'] },
          entity_kind: { type: 'string', enum: ['document', 'note', 'todo'] },
          entity_id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          project_id: { type: 'string', format: 'uuid', nullable: true },
          at: { type: 'string', format: 'date-time' },
        },
        required: ['kind', 'entity_kind', 'entity_id', 'title', 'at'],
      },
      Stats: {
        type: 'object',
        properties: {
          counts: {
            type: 'object',
            properties: {
              projects: { type: 'integer' },
              documents: { type: 'integer' },
              notes: { type: 'integer' },
              todos: { type: 'integer' },
              done: { type: 'integer' },
            },
          },
          processing: {
            type: 'object',
            properties: {
              pending: { type: 'integer' },
              ready: { type: 'integer' },
              failed: { type: 'integer' },
            },
          },
          freshness: {
            type: 'object',
            properties: {
              last_ingest_ms: { type: 'integer', nullable: true },
              last_edit_ms: { type: 'integer', nullable: true },
            },
          },
          top_tags: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  },
  security: [{ BearerAuth: [] }, { QueryKey: [] }],
  paths: {
    // ---- Health -------------------------------------------------------------
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness probe (public)',
        security: [],
        responses: { '200': { description: 'OK' } },
      },
    },

    // ---- Projects -----------------------------------------------------------
    '/api/v1/projects': {
      get: {
        tags: ['Projects'],
        summary: 'List projects',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'archived', 'completed'] } },
          { name: 'pinned', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { projects: { type: 'array', items: { $ref: '#/components/schemas/Project' } } },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Projects'],
        summary: 'Create a project',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  status: { type: 'string', enum: ['active', 'archived', 'completed'] },
                },
                required: ['name'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Created', content: { 'application/json': { schema: { type: 'object', properties: { project: { $ref: '#/components/schemas/Project' } } } } } },
        },
      },
    },
    '/api/v1/projects/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        tags: ['Projects'],
        summary: 'Get a project',
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { project: { $ref: '#/components/schemas/Project' } } } } } },
          '404': { description: 'Not found' },
        },
      },
      put: {
        tags: ['Projects'],
        summary: 'Update a project (partial)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', description: 'Subset of fields: name, description, status' } } },
        },
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
      delete: {
        tags: ['Projects'],
        summary: 'Archive (soft) or delete (hard) a project',
        parameters: [{ name: 'hard', in: 'query', schema: { type: 'boolean', default: false }, description: 'true → permanent delete; false → archived=true' }],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    },
    '/api/v1/projects/{id}/restore': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: ['Projects'], summary: 'Un-archive a project', responses: { '200': { description: 'OK' } } },
    },
    '/api/v1/projects/{id}/pin': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: ['Projects'], summary: 'Pin a project', responses: { '200': { description: 'OK' } } },
    },
    '/api/v1/projects/{id}/unpin': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: ['Projects'], summary: 'Unpin a project', responses: { '200': { description: 'OK' } } },
    },

    // ---- Content (documents + notes) ---------------------------------------
    '/api/v1/content': {
      get: {
        tags: ['Content'],
        summary: 'List content items',
        parameters: [
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['document', 'note'] } },
          { name: 'project_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'tags', in: 'query', schema: { type: 'string', description: 'Comma-separated' } },
          { name: 'processing_status', in: 'query', schema: { type: 'string', enum: ['pending', 'ready', 'failed'] } },
          { name: 'pinned', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/ContentItem' } } } } } },
          },
        },
      },
      post: {
        tags: ['Content'],
        summary: 'Create content (note, or upload document) — async ingest',
        description:
          'Returns 202 + {id, status: "pending"}. Backend kicks off the ingest pipeline ' +
          '(metadata → chunk → embed → entity extraction). Poll /content/:id/status until ' +
          'processing_status reaches "ready" or "failed". Accepts JSON (notes) or ' +
          'multipart/form-data with `file` + JSON-encoded `metadata` field (uploads).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['note', 'document'] },
                  title: { type: 'string' },
                  content: { type: 'string' },
                  project_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
                  tags: { type: 'array', items: { type: 'string' } },
                },
                required: ['type'],
              },
            },
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  file: { type: 'string', format: 'binary' },
                  metadata: { type: 'string', description: 'JSON-encoded {title?, project_ids?, tags?}' },
                },
                required: ['file'],
              },
            },
          },
        },
        responses: {
          '202': {
            description: 'Accepted — processing async',
            content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['pending'] } } } } },
          },
          '400': { description: 'Validation error' },
        },
      },
    },
    '/api/v1/content/from-url': {
      post: {
        tags: ['Content'],
        summary: 'Ingest a URL (YouTube / X / PDF / HTML / direct media)',
        description: 'Same async contract as POST /content. URL is classified server-side; pipeline picks the right fetcher.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  url: { type: 'string', format: 'uri' },
                  project_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
                  tags: { type: 'array', items: { type: 'string' } },
                },
                required: ['url'],
              },
            },
          },
        },
        responses: { '202': { description: 'Accepted' }, '400': { description: 'Validation error' }, '409': { description: 'Already ingested (dedup hit)' } },
      },
    },
    '/api/v1/content/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { tags: ['Content'], summary: 'Get a content item', responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/ContentItem' } } } }, '404': { description: 'Not found' } } },
      put: {
        tags: ['Content'],
        summary: 'Update content item (partial)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'Any of: title, content, project_ids, tags' } } } },
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
      delete: {
        tags: ['Content'],
        summary: 'Archive (soft) or delete (hard)',
        parameters: [{ name: 'hard', in: 'query', schema: { type: 'boolean', default: false } }],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    },
    '/api/v1/content/{id}/status': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        tags: ['Content'],
        summary: 'Poll ingest status',
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, processing_status: { type: 'string', enum: ['pending', 'ready', 'failed'] }, processing_error: { type: 'string', nullable: true }, ingest_completed_at: { type: 'string', nullable: true } } } } },
          },
        },
      },
    },
    '/api/v1/content/{id}/retry': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: ['Content'], summary: 'Re-run a failed ingest (state must be `failed`)', responses: { '202': { description: 'Re-queued' }, '409': { description: 'Not in failed state' } } },
    },
    '/api/v1/content/{id}/reprocess': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: ['Content'], summary: 'Regenerate chunks/embeddings/metadata (state must NOT be pending)', responses: { '202': { description: 'Reprocess started' }, '409': { description: 'Already pending' } } },
    },
    '/api/v1/content/{id}/replace': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: ['Content'], summary: 'Replace the underlying file/content + reprocess', responses: { '202': { description: 'Reprocess started' } } },
    },
    '/api/v1/content/{id}/edit-body': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: ['Content'], summary: 'Edit a note body in place + reprocess (notes only)', responses: { '202': { description: 'Reprocess started' } } },
    },
    '/api/v1/content/{id}/restore': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: ['Content'], summary: 'Un-archive', responses: { '200': { description: 'OK' } } },
    },
    '/api/v1/content/{id}/pin': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: ['Content'], summary: 'Pin', responses: { '200': { description: 'OK' } } },
    },
    '/api/v1/content/{id}/unpin': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: ['Content'], summary: 'Unpin', responses: { '200': { description: 'OK' } } },
    },
    '/api/v1/content/bulk': {
      post: {
        tags: ['Content'],
        summary: 'Bulk operation across many content items',
        description: 'Operations: archive, restore, delete (with `hard`), add_tags, remove_tags, set_project_ids',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string', format: 'uuid' } }, op: { type: 'string', enum: ['archive', 'restore', 'delete', 'add_tags', 'remove_tags', 'set_project_ids'] } }, required: ['ids', 'op'] } } },
        },
        responses: { '200': { description: 'OK with counts' }, '400': { description: 'Validation error' } },
      },
    },

    // ---- Todos --------------------------------------------------------------
    '/api/v1/todos': {
      get: {
        tags: ['Todos'],
        summary: 'List todos',
        parameters: [
          { name: 'project_id', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'Pass empty string for personal Inbox (no project)' },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'priority', in: 'query', schema: { type: 'string', enum: ['P1', 'P2', 'P3'] } },
          { name: 'pinned', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { todos: { type: 'array', items: { $ref: '#/components/schemas/Todo' } } } } } } } },
      },
      post: {
        tags: ['Todos'],
        summary: 'Create a todo',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                  project_id: { type: 'string', format: 'uuid', nullable: true, description: 'null/omit = personal Inbox' },
                  parent_id: { type: 'string', format: 'uuid', nullable: true },
                  section: { type: 'string', nullable: true },
                  priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
                  due_date: { type: 'string', format: 'date' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
                required: ['content'],
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/api/v1/todos/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { tags: ['Todos'], summary: 'Get a todo', responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
      put: { tags: ['Todos'], summary: 'Update a todo (partial)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
      delete: { tags: ['Todos'], summary: 'Archive (soft) or delete (hard)', parameters: [{ name: 'hard', in: 'query', schema: { type: 'boolean', default: false } }], responses: { '200': { description: 'OK' } } },
    },
    '/api/v1/todos/{id}/restore': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: ['Todos'], summary: 'Un-archive', responses: { '200': { description: 'OK' } } },
    },
    '/api/v1/todos/{id}/pin': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: ['Todos'], summary: 'Pin', responses: { '200': { description: 'OK' } } },
    },
    '/api/v1/todos/{id}/unpin': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: ['Todos'], summary: 'Unpin', responses: { '200': { description: 'OK' } } },
    },
    '/api/v1/todos/bulk': {
      post: {
        tags: ['Todos'],
        summary: 'Bulk operation across many todos',
        description: 'Operations: archive, restore, delete, add_tags, remove_tags, set_status, set_priority, set_project_id, set_due_date',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string', format: 'uuid' } }, op: { type: 'string' } }, required: ['ids', 'op'] } } } },
        responses: { '200': { description: 'OK with counts' } },
      },
    },

    // ---- Comments -----------------------------------------------------------
    '/api/v1/todos/{id}/comments': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { tags: ['Comments'], summary: 'List comments on a todo', responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { comments: { type: 'array', items: { $ref: '#/components/schemas/TodoComment' } } } } } } } } },
      post: { tags: ['Comments'], summary: 'Add a comment', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } } }, responses: { '201': { description: 'Created' } } },
    },
    '/api/v1/todos/{id}/comments/{cid}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'cid', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      put: { tags: ['Comments'], summary: 'Edit a comment', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } } }, responses: { '200': { description: 'OK' } } },
      delete: { tags: ['Comments'], summary: 'Delete a comment', responses: { '200': { description: 'OK' } } },
    },

    // ---- Search / RAG / Mentions -------------------------------------------
    '/api/v1/search': {
      post: {
        tags: ['Search'],
        summary: 'Hybrid vector + entity-graph search with RRF fusion',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                  project_id: { type: 'string', format: 'uuid' },
                  entity_types: { type: 'array', items: { type: 'string', enum: ['document', 'note', 'todo'] } },
                  tags: { type: 'array', items: { type: 'string' } },
                  limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
                  threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.65, description: '0.65 default tuned for real Gemini embeddings; lowered to 0.05 in stub mode' },
                  graph: { type: 'boolean', default: true },
                },
                required: ['query'],
              },
            },
          },
        },
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { hits: { type: 'array', items: { $ref: '#/components/schemas/SearchHit' } } } } } } } },
      },
    },
    '/api/v1/find-mentions': {
      post: {
        tags: ['Search'],
        summary: 'Exact entity lookup (canonical name or alias) → chunks',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, project_id: { type: 'string' } }, required: ['name'] } } } },
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/v1/rag': {
      post: {
        tags: ['Search'],
        summary: 'RAG synthesis with auto-depth routing',
        description:
          'Auto-depth: classifier picks fast (gpt-5-4) or thorough (gpt-5-4-pro Responses API). ' +
          'Force with depth=fast|thorough. Per-stage timings_ms in every response.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { question: { type: 'string' }, project_id: { type: 'string', format: 'uuid' }, depth: { type: 'string', enum: ['auto', 'fast', 'thorough'] }, max_chunks: { type: 'integer' } }, required: ['question'] } } },
        },
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/RagResponse' } } } } },
      },
    },

    // ---- Tags ---------------------------------------------------------------
    '/api/v1/tags': {
      get: {
        tags: ['Tags'],
        summary: 'Tag inventory with usage counts',
        parameters: [{ name: 'project_id', in: 'query', schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/v1/tags/{name}': {
      parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
      put: {
        tags: ['Tags'],
        summary: 'Rename a tag (or merge into existing if `to` already used)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] } } } },
        responses: { '200': { description: 'OK' } },
      },
      delete: { tags: ['Tags'], summary: 'Delete a tag corpus-wide', responses: { '200': { description: 'OK' } } },
    },

    // ---- Activity / Stats ---------------------------------------------------
    '/api/v1/activity': {
      get: {
        tags: ['Activity'],
        summary: 'Recent activity events (ingest, edit, comment)',
        parameters: [
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'until', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'kinds', in: 'query', schema: { type: 'string', description: 'Comma-separated: ingest,edit,comment' } },
          { name: 'project_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { events: { type: 'array', items: { $ref: '#/components/schemas/ActivityEvent' } } } } } } } },
      },
    },
    '/api/v1/stats': {
      get: {
        tags: ['Activity'],
        summary: 'Counts, freshness, top tags',
        parameters: [{ name: 'project_id', in: 'query', schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Stats' } } } } },
      },
    },

    // ---- Diagnostics --------------------------------------------------------
    '/api/v1/diagnostics/entities': {
      get: { tags: ['Diagnostics'], summary: 'Entity registry inspection', responses: { '200': { description: 'OK' } } },
    },
    '/api/v1/diagnostics/backfill-entities': {
      post: { tags: ['Diagnostics'], summary: 'Trigger entity-extraction backfill on existing chunks', responses: { '200': { description: 'OK with counts' } } },
    },
    '/api/v1/diagnostics/content/{id}/edges': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { tags: ['Diagnostics'], summary: 'Inspect chunk_entity edges for one content item', responses: { '200': { description: 'OK' } } },
    },

    // ---- MCP ----------------------------------------------------------------
    '/mcp': {
      post: {
        tags: ['MCP'],
        summary: 'MCP JSON-RPC endpoint (Streamable HTTP)',
        description:
          'Stateless: a fresh MCP server + transport per request. Auth via Bearer token. ' +
          'Use Accept: application/json, text/event-stream. Implements the standard MCP ' +
          'tools/list, tools/call, initialize methods plus 20 Open Brain tools.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'JSON-RPC 2.0 message' } } } },
        responses: { '200': { description: 'JSON-RPC response' } },
      },
    },
  },
} as const;

const SWAGGER_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Open Brain API</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css" />
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script>
    // Carry the auth key from the URL (?key=...) into both the openapi.json
    // fetch AND every "Try it out" request the UI fires. Lets the docs page
    // stay operable behind Bearer auth without re-authorizing each reload.
    const params = new URLSearchParams(window.location.search);
    const key = params.get('key') || '';
    const specUrl = '/api/openapi.json' + (key ? '?key=' + encodeURIComponent(key) : '');

    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: specUrl,
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
        requestInterceptor: (req) => {
          if (key) {
            req.headers['Authorization'] = 'Bearer ' + key;
          }
          return req;
        },
      });
    };
  </script>
</body>
</html>`;

export function openapiHandler(): Response {
  return new Response(JSON.stringify(SPEC), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export function swaggerUiHandler(): Response {
  return new Response(SWAGGER_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
