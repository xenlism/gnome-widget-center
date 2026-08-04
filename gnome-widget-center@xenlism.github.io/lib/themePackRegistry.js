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
// Discovery mirrors lib/widgetLoader.js's discover() shape on purpose
// (folder-per-entry, metadata.json-like manifest, invalid entries skipped
// without aborting the rest) so anyone who already knows that pattern can
// read this in one pass — but this class never imports St, never
// dynamically imports any code, and never instantiates anything. It only
// ever reads theme.json files. Safe to use from any process.

import Gio from 'gi://Gio';

const MANIFEST_FILENAME = 'theme.json';
const REQUIRED_FIELDS = ['id', 'name', 'widgets'];

export class ThemePackRegistry {
    /**
     * @param {string[]} searchPaths - directories expected to contain one
     *   subfolder per theme pack: <searchPath>/<pack-id>/theme.json
     */
    constructor(searchPaths) {
        this._searchPaths = searchPaths ?? [];
        this._lastErrors = [];
    }

    /** Errors recorded during the most recent discover() call. */
    get lastErrors() {
        return this._lastErrors;
    }

    /**
     * Scans all search paths, validates each theme.json, returns
     * [{id, path, manifest}]. Invalid or duplicate entries are skipped and
     * recorded in lastErrors — one bad theme pack never stops discovery of
     * the rest, same policy as WidgetLoader.discover().
     */
    discover() {
        const found = new Map(); // id -> {id, path, manifest}
        this._lastErrors = [];

        for (const searchPath of this._searchPaths) {
            const dir = Gio.File.new_for_path(searchPath);
            if (!dir.query_exists(null))
                continue;

            let enumerator;
            try {
                enumerator = dir.enumerate_children(
                    'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                this._recordError({id: '(unknown)', path: searchPath}, `could not enumerate: ${e.message}`);
                continue;
            }

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                    continue;

                const folderName = info.get_name();
                if (folderName.startsWith('_')) // e.g. "_template"
                    continue;

                const packDir = dir.get_child(folderName);
                const packPath = packDir.get_path();
                const manifestFile = packDir.get_child(MANIFEST_FILENAME);

                let manifest;
                try {
                    manifest = this._readManifest(manifestFile);
                } catch (e) {
                    this._recordError({id: folderName, path: packPath}, `invalid ${MANIFEST_FILENAME}: ${e.message}`);
                    continue;
                }

                const missing = REQUIRED_FIELDS.filter(field => !(field in manifest));
                if (missing.length > 0) {
                    this._recordError(
                        {id: manifest.id ?? folderName, path: packPath},
                        `${MANIFEST_FILENAME} missing required field(s): ${missing.join(', ')}`);
                    continue;
                }

                if (found.has(manifest.id)) {
                    this._recordError(
                        {id: manifest.id, path: packPath},
                        `duplicate theme pack id, already loaded from ${found.get(manifest.id).path}`);
                    continue;
                }

                found.set(manifest.id, {id: manifest.id, path: packPath, manifest});
            }
        }

        return [...found.values()];
    }

    _readManifest(manifestFile) {
        if (!manifestFile.query_exists(null))
            throw new Error(`${MANIFEST_FILENAME} not found`);

        const [ok, contents] = manifestFile.load_contents(null);
        if (!ok)
            throw new Error(`could not read ${MANIFEST_FILENAME}`);

        const text = new TextDecoder('utf-8').decode(contents);
        let manifest;
        try {
            manifest = JSON.parse(text);
        } catch (e) {
            throw new Error(`malformed JSON: ${e.message}`);
        }
        return manifest;
    }

    _recordError(context, message) {
        const entry = {...context, message};
        this._lastErrors.push(entry);
        console.error(`[widget-center] theme pack discovery: ${context.id} (${context.path}) - ${message}`);
    }
}
