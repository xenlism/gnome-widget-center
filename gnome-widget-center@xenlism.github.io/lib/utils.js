import GioUnix from 'gi://GioUnix';

/**
 * Safely loads a DesktopAppInfo from a .desktop file PATH (not a desktop
 * id) using GioUnix to eliminate the "Gio.DesktopAppInfo has been moved"
 * deprecation warning. Matches the new_from_filename() usage in
 * widgets/launcher-big-1 and widgets/launcher-square-1.
 */
export function getAppInfoFromFilename(path) {
    if (!path) return null;
    try {
        return GioUnix.DesktopAppInfo.new_from_filename(path);
    } catch (err) {
        console.error(`[widget-center] Failed to load app info for ${path}: ${err.message}`);
        return null;
    }
}
