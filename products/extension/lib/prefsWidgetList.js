// products/extension/lib/prefsWidgetList.js
//
// Task 05 — pure data-gathering logic for the Control Center's widget
// list, kept separate from prefs.js so the GTK4/Adw marshalling code
// doesn't also have to know about WidgetLoader internals (see
// development/tasks/05-prefs-control-center.md "Files to touch"). Runs in the prefs
// (GTK4) process — like prefs.js itself, this file must NOT import
// St/Clutter/Meta/Shell (development/docs/WIDGET_API.md §4).
//
// Reuses WidgetLoader.discover() read-only: it never calls loadModule()
// (i.e. never imports a widget's widget.js) here, since that file is
// allowed to import St, which doesn't exist in the prefs process.
// discover() itself only ever touches metadata.json via Gio.File, so it's
// exactly as safe to run here as it is in extension.js.

import {WidgetLoader} from './widgetLoader.js';

export class PrefsWidgetList {
    /**
     * @param {string[]} searchPaths - same bundled+user widget folders
     *   extension.js scans (passed in by prefs.js's
     *   fillPreferencesWindow()).
     */
    constructor(searchPaths) {
        this._loader = new WidgetLoader(searchPaths);
    }

    /**
     * @returns {{
     *   ok: Array<{id: string, name: string, description: string,
     *              hasPrefs: boolean, metadata: object, path: string}>,
     *   errors: Array<{id: string, path: string, reason: string}>
     * }}
     *   `ok` only contains widgets whose metadata.json is valid —
     *   discover() already excludes anything malformed, missing a
     *   required field, or a duplicate id, filing those in `errors`
     *   instead (see WidgetLoader.discover()). This satisfies the
     *   acceptance criterion "widget ที่จงใจทำให้ metadata.json พัง → โชว์
     *   error ใน list ไม่ทำให้ Control Center ทั้งหน้าพัง" — the caller just
     *   renders `errors` as its own list of rows instead of throwing.
     */
    list() {
        const found = this._loader.discover();

        const ok = found.map(({id, metadata, path}) => ({
            id,
            name: metadata.name ?? id,
            description: metadata.description ?? '',
            hasPrefs: typeof metadata.prefs === 'string' && metadata.prefs.length > 0,
            metadata,
            path,
        }));

        return {ok, errors: this._loader.errors};
    }
}
