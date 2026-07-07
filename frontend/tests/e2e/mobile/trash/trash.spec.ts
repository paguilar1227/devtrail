// Thin device wrapper — the workflow lives in shared/trash.ts so the
// desktop and mobile projects run the identical suite (parity by construction).
import { defineTrashTests } from '../../shared/trash';

defineTrashTests();
