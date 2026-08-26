import { pathIsUnder } from "./fsUtils.js";

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
