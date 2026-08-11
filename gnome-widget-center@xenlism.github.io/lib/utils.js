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