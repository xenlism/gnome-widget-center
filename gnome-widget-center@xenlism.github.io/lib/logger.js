// products/extension/lib/logger.js
//
// Development mode debug logging (requested 2026-07-19, alongside the
// real-hardware Edit Mode bug-fix session — see
// development/handoff-2026-07-19-editmode-bugs.md). Reuses the existing
// `dev-mode` GSettings key (products/extension/schemas/*.gschema.xml,
// previously only wired to task 08's hot-reload file watcher) as the
// single "I am actively developing/debugging this extension" switch —
// when it's on, every `logger.debug(...)` call in the Shell process
// prints; when it's off, `debug()` is a silent no-op so normal users
// never see extension-internals spam in `journalctl`.
//
// Why reuse `dev-mode` instead of adding a second key: both hot-reload
// and verbose logging are "things a developer/bug-reporter wants on,
// end users never do" — one checkbox in the Control Center
// ("Development Mode") now drives both, instead of asking a
// non-developer to understand the difference between two very similar
// sounding toggles.
//
// Usage — construct once in enable(), pass down to anything that wants
// to log:
//   const logger = createLogger(settingsService);
//   logger.debug('widget-edit-mode', `attach(${widgetId})`);
//   logger.warn('widget-edit-mode', 'onBackActorReady fired with no back actor');
//
// `warn`/`error` always print (same as plain console.warn/error always
// did throughout this codebase before this file existed) — only `debug`
// is gated by dev-mode, so turning dev-mode off never hides a real
// problem, only the verbose step-by-step trace.
//
// View the output on real hardware with:
//   journalctl -f -o cat /usr/bin/gnome-shell | grep widget-center
// (or `journalctl --user -f` if running under a user session bus,
// e.g. a nested/Wayland test session) — every line from this module is
// prefixed `[widget-center:<tag>]` so it's easy to grep down further,
// e.g. `| grep 'widget-center:edit-mode'`.

/**
 * @param {SettingsService|null} settingsService - read live so flipping
 *   the Control Center's "Development Mode" switch takes effect on the
 *   very next log call, no restart needed - same "live toggle" property
 *   as dev-mode's existing hot-reload behavior.
 * @returns {{debug: Function, warn: Function, error: Function}}
 */
export function createLogger(settingsService) {
    const isDevMode = () => {
        try {
            return !!settingsService?.isReady && !!settingsService.getGlobalValue('dev-mode');
        } catch (e) {
            // Missing/uninitialized SettingsService must never crash a log
            // call - fail closed (silent), same defensive stance as every
            // other `settings?.isReady` guard in this codebase.
            return false;
        }
    };

    const prefix = tag => `[widget-center:${tag}]`;

    return {
        /**
         * @param {string} tag - short module name, e.g. 'edit-mode',
         *   'edit-drag' - lets `journalctl | grep` narrow to one subsystem.
         * @param {...*} args
         */
        debug(tag, ...args) {
            if (isDevMode())
                console.log(prefix(tag), ...args);
        },
        warn(tag, ...args) {
            console.warn(prefix(tag), ...args);
        },
        error(tag, ...args) {
            console.error(prefix(tag), ...args);
        },
    };
}
