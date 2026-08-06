// lib/themePackRegistry.js
//
// Standalone add-on for the Widget Center overlay (lib/widgetCenterOverlay.js)
// — NOT wired into extension.js yet, see that file's header and
// overlay-integration-example.js for why.
//
// A "theme pack" here is a DIFFERENT concept from lib/themeService.js's
// "theme" (which is per-widget/global background+corner-radius+drop-shadow
// styling, see that file's header) — a theme pack is a curated bundle:
// {id, name, description, author, screenshot, widgets: [widget ids]} that
// the Widget Center overlay's "Themes" tab lists so a user can enable a
// whole matched set of widgets at once. Deliberately its own file/registry
// (not folded into ThemeService) to avoid overloading that class's already
// well-established meaning of "theme" in this codebase.
//
// Two on-disk shapes are recognized, both discovered from the SAME search
// paths:
//   1. Folder form: <searchPath>/<pack-id>/theme.json (+ optional
//      screenshot file referenced by a relative `screenshot` field) — the
//      original shape, still the recommended one for a hand-authored pack.
//   2. Flat-file form: <searchPath>/<anything>.gwct — a single JSON file,
//      same on-disk extension/shape the Preferences window's own
//      "Export theme…" (lib/exportService.js's buildGwctDocument()) and
//      the newer Export-Theme-Pack dialog (lib/themePackExportDialog.js)
//      both produce. This is genuinely what ends up in a themepacks/
//      folder in practice (see themepacks/README.txt's history — every
//      file actually dropped in there so far is one of these, not a
//      theme.json subfolder), so discovery has to recognize it directly
//      rather than only supporting the folder form nothing currently
//      writes. `packMeta`/`screenshot` (added by
//      lib/themePackExportDialog.js) are optional — a plain desktop-
//      appearance `.gwct` export (no packMeta at all) is still shown,
//      just with its filename as the name and no description/author/url.
//
// 2026-08-05 addition: every search path can now be given as a plain
// string (legacy, treated as `source: 'bundled'`) or as
// `{path, source: 'bundled'|'user'}`. `source` is stamped onto every
// discovered entry so callers (the overlay's Remove button, in
// particular — see widgetCenterOverlay.js's `_buildThemePackCard()`) can
// tell a bundled/built-in pack (never removable) from one the user
// dropped into their own `~/.config/gnome-widget-center/themepacks/`
// (removable). Each entry also now carries `mtimeUnix` (file/folder
// modification time) and `widgetCount` (`manifest.widgets.length`) so the
// overlay's sort control (Name / Widget size / Date modified) has
// something to sort on without re-stat'ing anything itself.
//
// Discovery mirrors lib/widgetLoader.js's discover() shape on purpose
// (folder-per-entry, metadata.json-like manifest, invalid entries skipped
// without aborting the rest) so anyone who already knows that pattern can
// read this in one pass — but this class never imports St, never
// dynamically imports any code, and never instantiates anything. It only
// ever reads theme.json/.gwct files. Safe to use from any process.

import Gio from 'gi://Gio';

const MANIFEST_FILENAME = 'theme.json';
const REQUIRED_FIELDS = ['id', 'name', 'widgets'];
const FLAT_FILE_EXTENSION = '.gwct';
const ENUM_ATTRS = 'standard::name,standard::type,time::modified';

export class ThemePackRegistry {
    /**
     * @param {Array<string|{path: string, source?: string}>} searchPaths -
     *   directories to scan, each either a bare path (treated as
     *   `source: 'bundled'`) or `{path, source}` — see file header.
     */
    constructor(searchPaths) {
        this._searchPaths = (searchPaths ?? []).map(entry =>
            typeof entry === 'string' ? {path: entry, source: 'bundled'} : {path: entry.path, source: entry.source ?? 'bundled'});
        this._lastErrors = [];
    }

    /** Errors recorded during the most recent discover() call. */
    get lastErrors() {
        return this._lastErrors;
    }

    /**
     * Scans all search paths, validates each theme.json / .gwct,
     * returns [{id, path, manifest, source, mtimeUnix, widgetCount}].
     * Invalid or duplicate entries are skipped and recorded in
     * lastErrors — one bad theme pack never stops discovery of the
     * rest, same policy as WidgetLoader.discover().
     */
    discover() {
        const found = new Map(); // id -> entry
        this._lastErrors = [];

        for (const {path: searchPath, source} of this._searchPaths) {
            const dir = Gio.File.new_for_path(searchPath);
            if (!dir.query_exists(null))
                continue;

            let enumerator;
            try {
                enumerator = dir.enumerate_children(ENUM_ATTRS, Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                this._recordError({id: '(unknown)', path: searchPath}, `could not enumerate: ${e.message}`);
                continue;
            }

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.startsWith('_')) // e.g. "_template"
                    continue;

                if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                    this._discoverFolderPack(dir, name, info, source, found);
                } else if (info.get_file_type() === Gio.FileType.REGULAR && name.endsWith(FLAT_FILE_EXTENSION)) {
                    this._discoverFlatPack(dir, name, info, source, found);
                }
            }
        }

        return [...found.values()];
    }

    /** @private folder form: <dir>/<name>/theme.json */
    _discoverFolderPack(dir, folderName, info, source, found) {
        const packDir = dir.get_child(folderName);
        const packPath = packDir.get_path();
        const manifestFile = packDir.get_child(MANIFEST_FILENAME);

        let manifest;
        try {
            manifest = this._readJson(manifestFile);
        } catch (e) {
            this._recordError({id: folderName, path: packPath}, `invalid ${MANIFEST_FILENAME}: ${e.message}`);
            return;
        }

        const missing = REQUIRED_FIELDS.filter(field => !(field in manifest));
        if (missing.length > 0) {
            this._recordError(
                {id: manifest.id ?? folderName, path: packPath},
                `${MANIFEST_FILENAME} missing required field(s): ${missing.join(', ')}`);
            return;
        }

        this._addFound(found, {
            id: manifest.id,
            path: packPath,
            manifest,
            source,
            mtimeUnix: this._mtimeUnix(info),
            widgetCount: Array.isArray(manifest.widgets) ? manifest.widgets.length : 0,
        });
    }

    /** @private flat form: <dir>/<name>.gwct — see file header for shape. */
    _discoverFlatPack(dir, fileName, info, source, found) {
        const file = dir.get_child(fileName);
        const filePath = file.get_path();
        const baseName = fileName.slice(0, -FLAT_FILE_EXTENSION.length);

        let raw;
        try {
            raw = this._readJson(file);
        } catch (e) {
            this._recordError({id: baseName, path: filePath}, `invalid ${FLAT_FILE_EXTENSION}: ${e.message}`);
            return;
        }

        if (raw.format !== 'gwct') {
            this._recordError({id: baseName, path: filePath}, `not a recognized ${FLAT_FILE_EXTENSION} file (unexpected format)`);
            return;
        }

        // widgets[] here is exportService.js's shape ({id, name, ...} per
        // entry, one per included widget) - reduce to just the ids, the
        // same shape the folder form's manifest.widgets already is.
        const widgetIds = Array.isArray(raw.widgets)
            ? raw.widgets.map(w => (typeof w === 'string' ? w : w?.id)).filter(Boolean)
            : [];

        const packMeta = raw.packMeta ?? {};
        const id = packMeta.id || baseName;
        const manifest = {
            id,
            name: packMeta.name || baseName,
            description: packMeta.description ?? '',
            author: packMeta.author ?? '',
            url: packMeta.url ?? '',
            screenshotBase64: raw.screenshot?.base64 ?? null,
            screenshotMime: raw.screenshot?.mimeType ?? null,
            widgets: widgetIds,
        };

        this._addFound(found, {
            id, path: filePath, manifest, source,
            // Keep the original export document so the overlay's Load
            // action can apply its appearance, positions and settings.
            document: raw,
            mtimeUnix: this._mtimeUnix(info),
            widgetCount: widgetIds.length,
        });
    }

    _addFound(found, entry) {
        if (found.has(entry.id)) {
            this._recordError(
                {id: entry.id, path: entry.path},
                `duplicate theme pack id, already loaded from ${found.get(entry.id).path}`);
            return;
        }
        found.set(entry.id, entry);
    }

    _mtimeUnix(info) {
        try {
            const dt = info.get_modification_date_time?.();
            if (dt)
                return dt.to_unix();
        } catch (e) { /* fall through */ }
        try {
            return Number(info.get_attribute_uint64('time::modified')) || 0;
        } catch (e) {
            return 0;
        }
    }

    _readJson(file) {
        if (!file.query_exists(null))
            throw new Error('file not found');

        const [ok, contents] = file.load_contents(null);
        if (!ok)
            throw new Error('could not read file');

        const text = new TextDecoder('utf-8').decode(contents);
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error(`malformed JSON: ${e.message}`);
        }
    }

    _recordError(context, message) {
        const entry = {...context, message};
        this._lastErrors.push(entry);
        console.error(`[widget-center] theme pack discovery: ${context.id} (${context.path}) - ${message}`);
    }
}
