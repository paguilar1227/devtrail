// Thin device wrapper — the workflow lives in shared/projects-page.ts so the
// desktop and mobile projects run the identical suite (parity by construction).
import { defineProjectsPageTests } from '../../shared/projects-page';

defineProjectsPageTests();
