// shared/src/index.ts
//
// Re-exports the entire schemas surface so consumers can:
//   import { Project, ProjectSchema } from '@devtrail/shared';
//
// For the (rare) case where someone wants schemas only:
//   import { ProjectSchema } from '@devtrail/shared/schemas';

export * from './schemas.js';
