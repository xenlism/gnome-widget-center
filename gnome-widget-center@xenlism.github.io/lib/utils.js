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

// Resolves a plain-text app name (e.g. "firefox", "gimp") to an
// installed app's Gio.DesktopAppInfo using the same fuzzy search GNOME
// Shell's own app search uses (matches display name, generic name,
// exec, and keywords) - no .desktop file path or file-browse dialog
// required. Returns the best-ranked match, or null if nothing matches
// or the query is blank.
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