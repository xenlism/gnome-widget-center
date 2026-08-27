import GLib from "gi://GLib";

import { fileExists } from "./fsUtils.js";

import { WidgetLoader } from "./widgetLoader.js";

import { widgetHasConfigJson } from "./widgetConfigReader.js";

function widgetHasSettingsJs(widgetPath) {
    const settingsJsPath = GLib.build_filenamev([ widgetPath, "settings.js" ]);
    return fileExists(settingsJsPath);
}

// metadata.json's "prefs" field names a file to be dynamically import()-ed
// inside the (Shell-library-free) prefs process. It comes from widget
// metadata, which for user-installed widgets is untrusted, so it must be
// constrained to a single plain filename inside the widget's own folder,
// never a path with a separator or a ".." segment that could point outside
// the widget directory (e.g. at a lib/shell/*.js file that imports
// St/Clutter/Shell, which would crash the prefs process).
export function isSafeWidgetRelativeFilename(name) {
    return typeof name === "string" && name.length > 0 && !name.includes("/") && !name.includes("\\") && name !== ".." && name !== ".";
}

export class PrefsWidgetList {
    constructor(searchPaths) {
        this._loader = new WidgetLoader(searchPaths);
    }
    async list() {
        const found = await this._loader.discover();
        const ok = found.map(({id: id, metadata: metadata, path: path}) => ({
            id: id,
            name: metadata.name ?? id,
            description: metadata.description ?? "",
            hasPrefs: isSafeWidgetRelativeFilename(metadata.prefs),
            hasSettingsSchema: Array.isArray(metadata.settings) && metadata.settings.length > 0,
            hasConfigJson: widgetHasConfigJson(path),
            hasSettingsJs: widgetHasSettingsJs(path),
            metadata: metadata,
            path: path
        }));
        return {
            ok: ok,
            errors: this._loader.errors
        };
    }
}