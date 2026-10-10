// rollback.js - "go back to the previous version" for something updated from a store or a file (one step, symmetric:
// calling it twice returns to where you started). Files first, registry second: if the file swap fails nothing is recorded.
import { prevInfo, rollbackThemepack, rollbackWidget } from "./gwcFormat.js";

/** What a rollback would restore: { version } or null (nothing kept). */
export const canRollback = (kind, id) => prevInfo(kind, id);

/** @returns the version now live */
export async function rollbackInstalled(registry, kind, id) {
    const v = kind === "widgets" ? rollbackWidget(id) : rollbackThemepack(id);
    await registry.recordRollback(kind, id, v || undefined);
    return v;
}
