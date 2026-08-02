// products/extension/lib/i18nUtils.js
//
// One tiny shared helper for a pattern that showed up independently in
// three places (prefsWindowController.js's `_tr`/`_t`,
// widgetConfigUI.js's `tr` closure): look up `key` in a translations
// table, fall back to the untranslated string if the table doesn't
// have it (missing key, not a string, or an empty string — an empty
// translated string is treated the same as "not translated" rather
// than shown as blank).

/**
 * @param {Object|null|undefined} map - a translations table (i18n keys
 *   -> translated strings), or the widget/extension's own `_i18n`.
 * @param {string} key
 * @param {string} fallback - the untranslated (English) string to use
 *   when `map` has no usable translation for `key`.
 * @returns {string}
 */
export function pickTranslation(map, key, fallback) {
    const value = map?.[key];
    return typeof value === 'string' && value.length > 0 ? value : fallback;
}
