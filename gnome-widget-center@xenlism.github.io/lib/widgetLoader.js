import GLib from "gi://GLib";

import Gio from "gi://Gio";

import { validateSettingsSchema } from "./settingsSchema.js";

const REQUIRED_METADATA_FIELDS = [ "id", "name", "entry" ];

// NOTE: This class must stay reachable from BOTH extension.js (shell process)
// and prefs.js (prefs process) — it only scans metadata.json on disk and must
// never import GNOME Shell libraries (Clutter/St/Shell) or anything that does,
// directly or dynamically. Actual widget instantiation/rendering (which needs
// those libraries) lives in lib/shell/widgetRuntimeLoader.js instead, so that
// file's import graph never crosses into the prefs process.
export class WidgetLoader {
    constructor(searchPaths) {
        this._searchPaths = searchPaths;
        this._errors = [];
        this._pathById = null;
    }
    get errors() {
        return this._errors;
    }
    discover() {
        const found = new Map;
        this._errors = [];
        for (const basePath of this._searchPaths) {
            const dir = Gio.File.new_for_path(basePath);
            let enumerator;
            try {
                enumerator = dir.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                continue;
            }
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue;
                const folderName = info.get_name();
                if (folderName.startsWith("_")) continue;
                const widgetDir = dir.get_child(folderName);
                const widgetPath = widgetDir.get_path();
                const metadataFile = widgetDir.get_child("metadata.json");
                let metadata;
                try {
                    metadata = this._readMetadata(metadataFile);
                } catch (e) {
                    this._recordError({
                        id: folderName,
                        path: widgetPath
                    }, `invalid metadata.json: ${e.message}`);
                    continue;
                }
                const missing = REQUIRED_METADATA_FIELDS.filter(field => !(field in metadata));
                if (missing.length > 0) {
                    this._recordError({
                        id: metadata.id ?? folderName,
                        path: widgetPath
                    }, `metadata.json missing required field(s): ${missing.join(", ")}`);
                    continue;
                }
                if (found.has(metadata.id)) {
                    this._recordError({
                        id: metadata.id,
                        path: widgetPath
                    }, `duplicate widget id, already loaded from ${found.get(metadata.id).path}`);
                    continue;
                }
                const settingsProblems = validateSettingsSchema(metadata.settings);
                if (settingsProblems.length > 0) {
                    this._recordError({
                        id: metadata.id,
                        path: widgetPath
                    }, `invalid "settings" schema: ${settingsProblems.join("; ")}`);
                    continue;
                }
                found.set(metadata.id, {
                    id: metadata.id,
                    metadata: metadata,
                    path: widgetPath
                });
            }
        }
        this._pathById = new Map(Array.from(found.values(), w => [ w.id, w.path ]));
        return Array.from(found.values());
    }
    _readMetadata(metadataFile) {
        if (!metadataFile.query_exists(null)) throw new Error("metadata.json not found");
        const [ok, contents] = metadataFile.load_contents(null);
        if (!ok) throw new Error("could not read metadata.json");
        return JSON.parse(new TextDecoder("utf-8").decode(contents));
    }
    _recordError(widgetInfo, reason) {
        this._errors.push({
            id: widgetInfo.id,
            path: widgetInfo.path,
            reason: reason
        });
    }
}
