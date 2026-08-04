// i18n/index.js
//
// Self-contained per-widget (and per-extension) i18n loader — lives
// inside every widget's own i18n/ folder (plus one copy at the
// extension root for prefs.js/extension.js's own UI strings), same
// "a widget only ever reaches into its own files" rule autocomplete.js
// and the rest of the widget contract already follow (see
// development/docs/WIDGET_API.md §1). Deliberately duplicated verbatim
// across every i18n/ folder rather than imported from one shared
// lib/ module, on purpose.
//
// Scans THIS folder for "<code>.js" files (one of SUPPORTED_LOCALES
// each) at runtime via Gio.File.enumerate_children() - "ใช้ index.js
// ในการสแกนหาว่ามีไฟล์กี่ภาษา" - so adding a 7th language later is just
// dropping in one more file, no code change here. Pure Gio/GLib only
// (no St/Gtk/Adw imports) so this is safe to import from BOTH the Shell
// process (a widget.js wanting to translate its own on-screen text,
// e.g. weather-minimal/weather-dark's condition strings) and the Prefs
// process (widgetConfigUI.js translating config.json's labels) - same
// constraint settingsSchema.js/widgetConfigValidator.js already follow.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const SUPPORTED_LOCALES = Object.freeze(['en', 'zh', 'es', 'th', 'de', 'ja']);

/**
 * @param {string} dirPath - absolute path to this i18n/ folder (pass
 *   the widget's own folder + "i18n", e.g. via GLib.build_filenamev([
 *   widgetPath, 'i18n']) — see widgetConfigUI.js / widget.js call sites).
 * @returns {string[]} language codes actually found on disk, e.g. ['en','th']
 */
export function scanAvailableLocales(dirPath) {
    const dir = Gio.File.new_for_path(dirPath);
    const found = [];
    try {
        const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const match = /^([a-z]{2})\.js$/.exec(info.get_name());
            if (match && SUPPORTED_LOCALES.includes(match[1]))
                found.push(match[1]);
        }
    } catch (e) {
        // Folder missing/unreadable - no languages available; callers
        // fall back to their own hardcoded English strings.
    }
    return found;
}

/**
 * Picks the best available locale for the current system out of
 * `available` (from scanAvailableLocales()), falling back to "en" if
 * present, else the first available language, else null (no i18n at all).
 * @param {string[]} available
 * @param {string} [overrideLocale] - 2026-08-04. The host `language`
 *   preference (gschema key `language`, read directly via SettingsService
 *   in this Prefs-process copy - widgetConfigUI.js's call site), a locale
 *   code like "th", or ''/undefined for no override. Takes priority over
 *   the system-locale order below when set AND this available list
 *   actually has that locale; otherwise skipped entirely, never a hard
 *   failure.
 * @returns {string|null}
 */
export function pickLocale(available, overrideLocale) {
    if (available.length === 0)
        return null;

    if (overrideLocale && available.includes(overrideLocale))
        return overrideLocale;

    for (const name of GLib.get_language_names()) {
        const code = name.slice(0, 2).toLowerCase();
        if (available.includes(code))
            return code;
    }
    return available.includes('en') ? 'en' : available[0];
}

/**
 * Loads this folder's translations for the current locale.
 * @param {string} dirPath - absolute path to the i18n/ folder
 * @param {string} [overrideLocale] - see pickLocale()'s doc above.
 * @returns {Promise<Object>} flat {key: string} translation table, {} if
 *   nothing could be loaded (never throws - caller keeps using its own
 *   English defaults in that case).
 */
export async function loadTranslations(dirPath, overrideLocale) {
    const locale = pickLocale(scanAvailableLocales(dirPath), overrideLocale);
    if (!locale)
        return {};

    try {
        const filePath = GLib.build_filenamev([dirPath, `${locale}.js`]);
        const module = await import(`file://${filePath}`);
        return module.default ?? {};
    } catch (e) {
        return {};
    }
}

/** Small lookup helper: translations[key] if present and non-empty, else fallback. */
export function t(translations, key, fallback) {
    const value = translations?.[key];
    return typeof value === 'string' && value.length > 0 ? value : fallback;
}
