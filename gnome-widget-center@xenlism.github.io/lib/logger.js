export function createLogger(settingsService) {
    const isDevMode = () => {
        try {
            return !!settingsService?.isReady && !!settingsService.getGlobalValue("dev-mode");
        } catch (e) {
            return false;
        }
    };
    // Two calling conventions are in use across the codebase:
    // `logger.debug("edit-mode", "attach(...)")` (tag + message, the
    // original convention - prefixed as "[widget-center:edit-mode]"),
    // and a single already-fully-formatted message string like
    // WidgetLoader's `logger.log('[widget-loader] loaded "id" from ...')`.
    // Wrapping a single-arg call in the tag-bracket format would just
    // double up the bracketing, so only apply the "[widget-center:tag]"
    // prefix when a second argument is actually present.
    const format = (tagOrMessage, args) => args.length > 0 ? [ `[widget-center:${tagOrMessage}]`, ...args ] : [ tagOrMessage ];
    return {
        debug(tagOrMessage, ...args) {
            if (isDevMode()) console.log(...format(tagOrMessage, args));
        },
        // Alias for `debug` - same dev-mode gating, for call sites (e.g.
        // WidgetLoader) written against a plain console-shaped logger
        // (`.log()`) rather than this module's original `.debug()` name.
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