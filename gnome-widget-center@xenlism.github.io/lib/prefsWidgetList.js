import GLib from "gi://GLib";

import { fileExists } from "./fsUtils.js";

import { WidgetLoader } from "./widgetLoader.js";

import { widgetHasConfigJson } from "./widgetConfigReader.js";

function widgetHasSettingsJs(widgetPath) {
    const settingsJsPath = GLib.build_filenamev([ widgetPath, "settings.js" ]);
    return fileExists(settingsJsPath);
}

export class PrefsWidgetList {
    constructor(searchPaths) {
        this._loader = new WidgetLoader(searchPaths);
    }
    list() {
        const found = this._loader.discover();
        const ok = found.map(({id: id, metadata: metadata, path: path}) => ({
            id: id,
            name: metadata.name ?? id,
            description: metadata.description ?? "",
            hasPrefs: typeof metadata.prefs === "string" && metadata.prefs.length > 0,
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