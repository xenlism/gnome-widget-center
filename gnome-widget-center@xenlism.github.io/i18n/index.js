import Gio from "gi://Gio";

import GLib from "gi://GLib";

// Registry of locale code -> the name shown in the language picker (written in
// that language itself). This is NOT a whitelist: any i18n/<code>.js on disk
// shows up in the picker automatically; this table only supplies its label.
// A code missing here is still listed - it just shows the raw code as its label.
// File naming: <language>.js or <language>_<COUNTRY>.js, e.g. th.js, pt_BR.js.
export const LOCALE_NAMES = Object.freeze({
    ar: "العربية",
    bg: "Български",
    bn: "বাংলা",
    ca: "Català",
    cs: "Čeština",
    da: "Dansk",
    de: "Deutsch",
    el: "Ελληνικά",
    en: "English",
    es: "Español",
    et: "Eesti",
    fa: "فارسی",
    fi: "Suomi",
    fr: "Français",
    he: "עברית",
    hi: "हिन्दी",
    hr: "Hrvatski",
    hu: "Magyar",
    id: "Bahasa Indonesia",
    it: "Italiano",
    ja: "日本語",
    ko: "한국어",
    lt: "Lietuvių",
    lv: "Latviešu",
    ms: "Bahasa Melayu",
    nb: "Norsk bokmål",
    nl: "Nederlands",
    pl: "Polski",
    pt: "Português",
    pt_BR: "Português (Brasil)",
    pt_PT: "Português (Portugal)",
    ro: "Română",
    ru: "Русский",
    sk: "Slovenčina",
    sr: "Српски",
    sv: "Svenska",
    ta: "தமிழ்",
    th: "ไทย",
    tr: "Türkçe",
    uk: "Українська",
    ur: "اردو",
    vi: "Tiếng Việt",
    zh: "中文",
    zh_CN: "简体中文",
    zh_TW: "繁體中文"
});

export function scanAvailableLocales(dirPath) {
    const dir = Gio.File.new_for_path(dirPath);
    const found = [];
    try {
        const enumerator = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            // "index.js" never matches (5 letters), so no explicit exclusion is needed.
            const match = /^([a-z]{2}(?:_[A-Z]{2})?)\.js$/.exec(info.get_name());
            if (match) found.push(match[1]);
        }
    } catch (e) {}
    return found;
}

// What the language picker shows: [{ code, name }], English first, rest by code.
export function listAvailableLocales(dirPath) {
    return scanAvailableLocales(dirPath)
        .sort((a, b) => (a === "en" ? -1 : b === "en" ? 1 : a.localeCompare(b)))
        .map(code => ({ code, name: LOCALE_NAMES[code] ?? code }));
}

export function pickLocale(available, overrideLocale) {
    if (available.length === 0) return null;
    if (overrideLocale && available.includes(overrideLocale)) return overrideLocale;
    for (const name of GLib.get_language_names()) {
        const normalized = name.replace("-", "_");
        const regional = normalized.match(/^([a-z]{2})_([A-Z]{2})/);
        const candidates = regional
            ? [ `${regional[1]}_${regional[2]}`, regional[1].toLowerCase() ]
            : [ normalized.slice(0, 2).toLowerCase() ];
        for (const code of candidates) {
            if (available.includes(code)) return code;
        }
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