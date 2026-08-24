export function createLogger(settingsService) {
    const isDevMode = () => {
        try {
            return !!settingsService?.isReady && !!settingsService.getGlobalValue("dev-mode");
        } catch (e) {
            return false;
        }
    };
    // Two calling conventions are supported: `logger.debug("edit-mode",
    // "attach(...)")` (tag + message, prefixed as
    // "[widget-center:edit-mode]"), and a single already-fully-formatted
    // message string, e.g. `logger.log('[widget-loader] loaded "id" from
    // ...')`. Wrapping a single-arg call in the tag-bracket format would
    // double up the bracketing, so the "[widget-center:tag]" prefix is
    // only applied when a second argument is actually present.
    const format = (tagOrMessage, args) => args.length > 0 ? [ `[widget-center:${tagOrMessage}]`, ...args ] : [ tagOrMessage ];
    return {
        debug(tagOrMessage, ...args) {
            if (isDevMode()) console.log(...format(tagOrMessage, args));
        },
        // Alias for `debug` with the same dev-mode gating, for call sites
        // (e.g. WidgetLoader) written against a plain console-shaped
        // logger interface (`.log()`).
        log(tagOrMessage, ...args) {
            if (isDevMode()) console.log(...format(tagOrMessage, args));
        },
        warn(tagOrMessage, ...args) {
            console.warn(...format(tagOrMessage, args));
        },
        error(tagOrMessage, ...args) {
            console.error(...format(tagOrMessage, args));
        }
    };
}