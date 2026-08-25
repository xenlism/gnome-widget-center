import { pathIsUnder } from "./fsUtils.js";

// Reconciles newly-discovered widgets against the known-widget-ids /
// disabled-widgets / auto-enable-new-widgets gschema keys.
//
// Bundled widgets (path NOT under `userWidgetsPath`) always start
// DISABLED the first time their id is ever seen — the person has to
// switch them on from the Overview. Without this, a fresh install
// auto-enables and places all ~70 widgets shipped with the extension
// at once. A widget under the user's own
// ~/.local/share/gnome-widget-center/widgets still follows
// `auto-enable-new-widgets` (default on) exactly as before this
// change — dropping a widget in there keeps auto-loading it.
//
// Only affects a widget id's FIRST-EVER discovery, same as
// `known-widget-ids` always meant: toggling `auto-enable-new-widgets`,
// or moving a widget between bundled/user, does nothing to an id
// that's already known either way.
//
// No GTK/Adw/St imports here on purpose — this needs to run
// identically from extension.js (Shell process, gjs -m) and from
// prefsWidgetManagement.js (Prefs process).
//
// `discovered` is an array of {id, path, ...} (WidgetLoader.discover()
// / PrefsWidgetList.list() shape). Returns the resulting disabled-id
// Set so a caller can use it immediately without a second GSettings
// read.
export function applyAutoEnablePolicy(settings, discovered, userWidgetsPath, logger = console) {
    if (!settings?.isReady) return new Set;
    let known, disabled;
    try {
        known = new Set(settings.getGlobalValue("known-widget-ids"));
        disabled = new Set(settings.getGlobalValue("disabled-widgets"));
    } catch (e) {
        logger.error?.("[widget-center] could not read known-widget-ids/disabled-widgets", e);
        return new Set;
    }
    const autoEnableUserWidgets = !!settings.getGlobalValue("auto-enable-new-widgets");
    let knownChanged = false;
    let disabledChanged = false;
    for (const widget of discovered) {
        const id = widget.id;
        if (known.has(id)) continue;
        known.add(id);
        knownChanged = true;
        const isUser = pathIsUnder(widget.path, userWidgetsPath);
        const autoEnableThis = isUser ? autoEnableUserWidgets : false;
        if (!autoEnableThis && !disabled.has(id)) {
            disabled.add(id);
            disabledChanged = true;
        }
    }
    if (knownChanged) {
        try {
            settings.setGlobalValue("known-widget-ids", Array.from(known));
        } catch (e) {
            logger.error?.("[widget-center] could not save known-widget-ids", e);
        }
    }
    if (disabledChanged) {
        try {
            settings.setGlobalValue("disabled-widgets", Array.from(disabled));
        } catch (e) {
            logger.error?.("[widget-center] could not save disabled-widgets (auto-enable policy)", e);
        }
    }
    return disabled;
}
