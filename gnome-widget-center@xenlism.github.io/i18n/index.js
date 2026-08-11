import Gio from "gi://Gio";

import GLib from "gi://GLib";

export const SUPPORTED_LOCALES = Object.freeze([ "en", "zh", "es", "th", "de", "ja" ]);

export function scanAvailableLocales(dirPath) {
    const dir = Gio.File.new_for_path(dirPath);
    const found = [];
    try {
        const enumerator = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const match = /^([a-z]{2})\.js$/.exec(info.get_name());
            if (match && SUPPORTED_LOCALES.includes(match[1])) found.push(match[1]);
        }
    } catch (e) {}
    return found;
}

export function pickLocale(available, overrideLocale) {
    if (available.length === 0) return null;
    if (overrideLocale && available.includes(overrideLocale)) return overrideLocale;
    for (const name of GLib.get_language_names()) {
        const code = name.slice(0, 2).toLowerCase();
        if (available.includes(code)) return code;
    }
    return available.includes("en") ? "en" : available[0];
}

export async function loadTranslations(dirPath, overrideLocale) {
    const locale = pickLocale(scanAvailableLocales(dirPath), overrideLocale);
    if (!locale) return {};
    try {
        const filePath = GLib.build_filenamev([ dirPath, `${locale}.js` ]);
        const module = await (import(`file://${filePath}`));
        return module.default ?? {};
    } catch (e) {
        return {};
    }
}

export function t(translations, key, fallback) {
    const value = translations?.[key];
    return typeof value === "string" && value.length > 0 ? value : fallback;
}