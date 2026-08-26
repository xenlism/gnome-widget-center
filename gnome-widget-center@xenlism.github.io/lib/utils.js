import GioUnix from "gi://GioUnix";

export function getAppInfoFromFilename(path) {
    if (!path) return null;
    try {
        return GioUnix.DesktopAppInfo.new_from_filename(path);
    } catch (err) {
        console.error(`[widget-center] Failed to load app info for ${path}: ${err.message}`);
        return null;
    }
}

export function findAppInfoByQuery(query) {
    const trimmed = (query ?? "").trim();
    if (!trimmed) return null;
    try {
        const rankedGroups = GioUnix.DesktopAppInfo.search(trimmed);
        for (const group of rankedGroups) {
            for (const id of group) {
                try {
                    const info = GioUnix.DesktopAppInfo.new(id);
                    if (info) return info;
                } catch (e) {}
            }
        }
    } catch (err) {
        console.error(`[widget-center] App search failed for "${trimmed}": ${err.message}`);
    }
    return null;
}