// lib/iconAccentColor.js
//
// Best-effort "accent color from an app icon" helper for the Xtile
// widget family (widgets/xtile-*/widget.js). Resolves a Gio.AppInfo's
// icon to an on-disk file (GdkPixbuf decodes PNG directly, and SVG too
// when librsvg's gdk-pixbuf loader is installed - most desktops have
// it), samples its pixels, and averages the most saturated opaque ones
// into a single accent color, blended toward a dark neutral base so
// the result stays readable as a card background behind white label
// text. Every failure path (icon not found, pixbuf can't decode it, no
// opaque pixels, GdkPixbuf missing the loader for this format, etc.)
// falls back to the caller-supplied fallback color instead of throwing
// - buildActor()/_render() must never throw (see WIDGET_API.md §3).
//
// Deliberately does NOT use Gtk.IconTheme - widget.js runs in the
// Shell's own GJS process (WIDGET_API.md §3's "never import Gtk in
// widget.js" rule) where a GTK icon theme/display isn't reliably
// available. Themed icon names are instead resolved with a plain
// filesystem search across the icon theme directories XDG defines,
// newest/largest size first - good enough for the common case (an
// installed app's own icon, under Adwaita or hicolor) without pulling
// in a whole icon-theme-inheritance implementation.
//
// Bundled widgets only (imports gi://GdkPixbuf) - same path
// restriction as lib/mediaApi.js / lib/systemMetricsApi.js (see
// WIDGET_API.md §9.1-9.3): third-party widgets outside this extension
// can't reach lib/*.js at all and must keep their own copy if they
// want this.

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GdkPixbuf from "gi://GdkPixbuf";

function _iconThemeRoots() {
    const dataDirs = GLib.get_system_data_dirs().map(d => GLib.build_filenamev([ d, "icons" ]));
    return [
        GLib.build_filenamev([ GLib.get_home_dir(), ".local/share/icons" ]),
        GLib.build_filenamev([ GLib.get_home_dir(), ".icons" ]),
        ...dataDirs,
        "/usr/share/pixmaps"
    ];
}

// Preference order for icon theme names: whatever the user picked in
// GNOME's own icon-theme setting first, then the two near-universal
// fallbacks most apps also ship an icon to.
function _iconThemeNames() {
    const names = [];
    try {
        const settings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" });
        const current = settings.get_string("icon-theme");
        if (current) names.push(current);
    } catch (e) {}
    for (const n of [ "Adwaita", "hicolor" ]) if (!names.includes(n)) names.push(n);
    return names;
}

const SIZES = [ "256x256", "128x128", "96x96", "64x64", "48x48", "32x32", "scalable" ];
const EXTS = [ "png", "svg" ];

function _resolveThemedIconPath(iconName) {
    for (const root of _iconThemeRoots()) {
        // flat pixmaps-style dirs have no theme/size subfolders
        for (const ext of EXTS) {
            const flat = GLib.build_filenamev([ root, `${iconName}.${ext}` ]);
            if (GLib.file_test(flat, GLib.FileTest.EXISTS)) return flat;
        }
        for (const theme of _iconThemeNames()) {
            for (const size of SIZES) {
                for (const ext of EXTS) {
                    const p = GLib.build_filenamev([ root, theme, size, "apps", `${iconName}.${ext}` ]);
                    if (GLib.file_test(p, GLib.FileTest.EXISTS)) return p;
                }
            }
        }
    }
    return null;
}

function _resolveIconPath(gicon) {
    if (!gicon) return null;
    // Gio.FileIcon (an app whose .desktop Icon= is an absolute path)
    try {
        if (typeof gicon.get_file === "function") {
            const file = gicon.get_file();
            const path = file?.get_path();
            if (path) return path;
        }
    } catch (e) {}
    // Gio.ThemedIcon (an app whose .desktop Icon= is a theme name)
    try {
        if (typeof gicon.get_names === "function") {
            for (const name of gicon.get_names()) {
                const path = _resolveThemedIconPath(name);
                if (path) return path;
            }
        }
    } catch (e) {}
    return null;
}

// Averages the most saturated opaque pixels of a small pixbuf into one
// {r,g,b} (0-255) - this is what makes the result the icon's "brand
// color" rather than a muddy grey average of everything including its
// background/outline. Falls back to a plain average of all opaque
// pixels if nothing passes the saturation filter (e.g. a monochrome
// symbolic-style icon).
function _averageColor(pixbuf) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const hasAlpha = pixbuf.get_has_alpha();
    const pixels = pixbuf.get_pixels();

    let satR = 0, satG = 0, satB = 0, satW = 0;
    let allR = 0, allG = 0, allB = 0, allW = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = y * rowstride + x * channels;
            const r = pixels[offset];
            const g = pixels[offset + 1];
            const b = pixels[offset + 2];
            const a = hasAlpha ? pixels[offset + 3] : 255;
            if (a < 128) continue;
            allR += r; allG += g; allB += b; allW += 1;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max > 245 && min > 230) continue; // near-white
            if (max < 20) continue;                // near-black
            const saturation = max - min;
            if (saturation < 24) continue;          // low-saturation grey
            satR += r * saturation; satG += g * saturation; satB += b * saturation;
            satW += saturation;
        }
    }

    if (satW > 0) return { r: satR / satW, g: satG / satW, b: satB / satW };
    if (allW > 0) return { r: allR / allW, g: allG / allW, b: allB / allW };
    return null;
}

function _toHex2(n) {
    return Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
}

const _cache = new Map();

/**
 * @param {Gio.AppInfo|null} appInfo
 * @param {string} fallbackHex - 8-char "#rrggbbaa" used on any failure
 *   (no app selected, icon not found, decode failure, etc.)
 * @param {number} [strength=0.7] - 0..1, how much of the extracted
 *   icon color survives a blend toward a fixed dark neutral base
 *   (keeps the card readable behind white label text regardless of
 *   how bright the source icon is).
 * @returns {string} 8-char "#rrggbbaa"
 */
export function getAccentColorForApp(appInfo, fallbackHex, strength = 0.7) {
    if (!appInfo) return fallbackHex;
    let path;
    try {
        path = _resolveIconPath(appInfo.get_icon());
    } catch (e) {
        path = null;
    }
    if (!path) return fallbackHex;

    const mix = Math.min(1, Math.max(0, strength));
    const cacheKey = `${path}::${mix}`;
    if (_cache.has(cacheKey)) return _cache.get(cacheKey);

    let hex = fallbackHex;
    try {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 48, 48);
        const avg = _averageColor(pixbuf);
        if (avg) {
            const baseR = 32, baseG = 34, baseB = 38; // neutral dark slate floor
            const r = baseR + (avg.r - baseR) * mix;
            const g = baseG + (avg.g - baseG) * mix;
            const b = baseB + (avg.b - baseB) * mix;
            hex = `#${_toHex2(r)}${_toHex2(g)}${_toHex2(b)}f0`;
        }
    } catch (e) {
        hex = fallbackHex;
    }
    _cache.set(cacheKey, hex);
    return hex;
}

/** Clears the per-icon-path accent color cache. Not called by anything
 * today - exported for a widget that wants to force a recompute (e.g.
 * after the user changes the system icon theme mid-session). */
export function clearAccentColorCache() {
    _cache.clear();
}
