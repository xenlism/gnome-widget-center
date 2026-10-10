// hostLibLink.js - widgets import the host kit as "../../lib/<file>.js".
// Next to the bundled widgets that is <extension>/lib. A widget installed from the store lives in
// ~/.local/share/gnome-widget-center/widgets/<id>/, where the same path means ~/.local/share/gnome-widget-center/lib.
// That path is a symlink to the extension's own lib/ folder. Idempotent and cheap: safe to call before every import.
import Gio from "gi://Gio";
import GLib from "gi://GLib";

/** @returns {boolean} true when the user-data lib/ path now resolves to `libDir` (or to a real folder the user put there) */
export function ensureHostLibLink(libDir, logger = null) {
    const linkPath = GLib.build_filenamev([ GLib.get_user_data_dir(), "gnome-widget-center", "lib" ]);
    const link = Gio.File.new_for_path(linkPath);
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(linkPath), 0o755);
        let info = null;
        try {
            info = link.query_info("standard::is-symlink,standard::symlink-target", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        } catch (_e) { /* nothing there yet */ }
        if (info) {
            if (!info.get_is_symlink()) {
                logger?.warn?.(`a real lib/ folder sits at ${linkPath}; not replacing it with a link`);
                return GLib.file_test(GLib.build_filenamev([ linkPath, "widgetVisualKit.js" ]), GLib.FileTest.EXISTS);
            }
            // right target and it resolves: done. A dangling or stale link is replaced.
            if (info.get_symlink_target() === libDir && GLib.file_test(linkPath, GLib.FileTest.IS_DIR)) return true;
            link.delete(null);
        }
        link.make_symbolic_link(libDir, null);
        return true;
    } catch (e) {
        logger?.error?.(`could not link ${linkPath} -> ${libDir} (user-installed widgets cannot import the host kit)`, e);
        return false;
    }
}
