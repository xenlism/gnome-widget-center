export function createLogger(settingsService) {
    const isDevMode = () => {
        try {
            return !!settingsService?.isReady && !!settingsService.getGlobalValue("dev-mode");
        } catch (e) {
            return false;
        }
    };
    const format = (tagOrMessage, args) => args.length > 0 ? [ `[widget-center:${tagOrMessage}]`, ...args ] : [ tagOrMessage ];
    return {
        debug(tagOrMessage, ...args) {
            if (isDevMode()) console.log(...format(tagOrMessage, args));
        },
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