// Thin device wrapper — the workflow lives in shared/project-tabs.ts so the
// desktop and mobile projects run the identical suite (parity by construction).
import { defineProjectTabsTests } from '../../shared/project-tabs';

defineProjectTabsTests();
