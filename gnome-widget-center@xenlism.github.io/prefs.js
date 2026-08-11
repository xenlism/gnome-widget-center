import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { PrefsWindowControllerV2 } from "./lib/prefsWindowController.js";

export default class WidgetCenterPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        await new PrefsWindowControllerV2(this).build(window);
    }
}