import Gio from "gi://Gio";

import GLib from "gi://GLib";

// XDG special folders (Downloads, Documents, Music, Pictures, Videos,
// Desktop, Public, Templates) plus $HOME itself, mapped to the same
// icon names GNOME's own file manager/sidebar uses for them. Built once
// on import - GLib.get_user_special_dir()/get_home_dir() are cheap
// synchronous lookups of already-resolved XDG user-dirs.
const _SPECIAL_FOLDERS = (() => {
    const entries = [
        [ GLib.UserDirectory.DIRECTORY_DOWNLOAD, "folder-download", "Downloads" ],
        [ GLib.UserDirectory.DIRECTORY_DOCUMENTS, "folder-documents", "Documents" ],
        [ GLib.UserDirectory.DIRECTORY_MUSIC, "folder-music", "Music" ],
        [ GLib.UserDirectory.DIRECTORY_PICTURES, "folder-pictures", "Pictures" ],
        [ GLib.UserDirectory.DIRECTORY_VIDEOS, "folder-videos", "Videos" ],
        [ GLib.UserDirectory.DIRECTORY_DESKTOP, "user-desktop", "Desktop" ],
        [ GLib.UserDirectory.DIRECTORY_PUBLIC_SHARE, "folder-publicshare", "Public" ],
        [ GLib.UserDirectory.DIRECTORY_TEMPLATES, "folder-templates", "Templates" ]
    ];
    const map = new Map;
    for (const [ dir, icon, label ] of entries) {
        try {
            const path = GLib.get_user_special_dir(dir);
            if (path) map.set(path, {
                icon: icon,
                label: label
            });
        } catch (e) {}
    }
    try {
        const home = GLib.get_home_dir();
        if (home && !map.has(home)) map.set(home, {
            icon: "user-home",
            label: "Home"
        });
    } catch (e) {}
    return map;
})();

/**
 * Looks up a path against the user's XDG special folders (Downloads,
 * Documents, Music, Pictures, Videos, Desktop, Public, Templates, Home).
 * Returns {icon, label} for a recognized special folder, or null for any
 * other directory - callers should fall back to a generic folder icon
 * and the path's own basename in that case.
 */
export function getSpecialFolderInfo(path) {
    if (!path) return null;
    return _SPECIAL_FOLDERS.get(path) ?? null;
}

export function fileExists(path) {
    return Gio.File.new_for_path(path).query_exists(null);
}

export function ensureDirectory(dirPath) {
    const dir = Gio.File.new_for_path(dirPath);
    if (!dir.query_exists(null)) dir.make_directory_with_parents(null);
    return dir;
}

export function readTextFile(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null)) return null;
    const [success, contents] = file.load_contents(null);
    if (!success) return null;
    return new TextDecoder("utf-8").decode(contents);
}

export function writeTextFile(path, text) {
    const file = Gio.File.new_for_path(path);
    const bytes = (new TextEncoder).encode(text);
    file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

export function readBytesFile(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null)) return null;
    const [success, contents] = file.load_contents(null);
    if (!success) return null;
    return new Uint8Array(contents);
}

export function writeBytesFile(path, bytes) {
    const file = Gio.File.new_for_path(path);
    file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

export function writeJsonFile(path, data, indent = 4) {
    writeTextFile(path, JSON.stringify(data, null, indent));
}