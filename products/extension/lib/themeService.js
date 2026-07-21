// products/extension/lib/themeService.js
//
// Theme system — one JSON file (`~/.config/gnome-widget-center/theme.json`)
// covering everything Edit Mode's Settings page and the Control Center's
// global appearance page need to read/write:
//
//   - GLOBAL appearance: desktop-wide widget background (transparent
//     on/off, color, blur radius) and a global drop shadow (color,
//     transparent on/off, opacity/offset/blur/spread) applied to every
//     widget's card unless a widget overrides it.
//   - PER-WIDGET entries, keyed by widget id: which `theme` name a widget
//     is rendering with (a widget can ship more than one stylesheet
//     variant, e.g. macos-clock's "light"/"dark"), its own `config`
//     (author-defined key/value pairs a widget's own theme reads — kept
//     separate from widgetSettings.js's `widgets/<id>.json`, which is
//     WIDGET BEHAVIOR settings like showSeconds, not appearance), and its
//     `position` override (mirrors layout.json's `{x, y, monitor}`, see
//     StorageService — theme.json's copy, if present, is what a widget's
//     own theme page uses to preview/reposition without touching the
//     host's own drag/layout persistence path at all).
//
// File format (`theme.json`):
//
//   {
//     "version": 1,
//     "global": {
//       "background": {
//         "transparent": true,
//         "color": "#1e1e2e",
//         "blur": 12
//       },
//       "dropShadow": {
//         "enabled": true,
//         "transparent": false,
//         "color": "#000000",
//         "opacity": 0.45,
//         "offsetX": 0,
//         "offsetY": 4,
//         "blurRadius": 12,
//         "spread": 0
//       }
//     },
//     "widgets": {
//       "clock": {
//         "theme": "default",
//         "config": { "accentColor": "#ffffff" },
//         "position": { "x": 300, "y": 400, "monitor": 0 }
//       }
//     }
//   }
//
// Deliberately a SEPARATE file from layout.json/widgets/<id>.json (see
// StorageService) rather than folded into either — appearance (this file)
// and behavior (widgetSettings.js) are different concerns per
// development/docs/SETTINGS_SPEC.md's "one file, one responsibility"
// principle, and mixing "where a widget sits" (StorageService's job
// already) into a THEME file would give two disagreeing sources of truth
// for position. theme.json's per-widget `position` is optional and only
// consulted by callers that explicitly want a theme-driven placement
// (e.g. a "reset to theme default" action) — StorageService's layout.json
// remains the single source of truth for where a widget actually renders.
//
// CSS generation: GNOME Shell's St actors accept ad hoc CSS via
// `actor.set_style(cssString)`, which is how this module turns the JSON
// above into something that actually paints — no dynamic stylesheet
// reload/recompile needed, `set_style()` takes effect immediately, same
// mechanism widgetSettings-driven per-widget colors already use (see
// mini-notes/macos-clock widgets' own `buildPrefsWidget()`/config reads).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const THEME_FILE_NAME = 'theme.json';

const DEFAULT_GLOBAL_THEME = Object.freeze({
    background: Object.freeze({
        transparent: true,
        color: '#1e1e2e',
        blur: 0,
    }),
    dropShadow: Object.freeze({
        enabled: true,
        transparent: false,
        color: '#000000',
        opacity: 0.45,
        offsetX: 0,
        offsetY: 4,
        blurRadius: 12,
        spread: 0,
    }),
});

/** Clamp a 0-1 opacity/alpha value so a bad config value (negative, >1,
 * NaN from a hand-edited file) can never produce invalid CSS. */
function clampUnit(value, fallback) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(1, Math.max(0, value));
}

/** `#rrggbb` + a 0-1 alpha -> `rgba(r, g, b, a)`. Falls back to the raw
 * color string unchanged if it isn't a `#rrggbb`/`#rgb` hex value (e.g. a
 * user already wrote `rgba(...)` or a named CSS color directly). */
function hexToRgba(hex, alpha) {
    if (typeof hex !== 'string')
        return `rgba(0, 0, 0, ${alpha})`;

    let h = hex.trim();
    if (h.startsWith('#'))
        h = h.slice(1);

    if (h.length === 3)
        h = h.split('').map(c => c + c).join('');

    if (!/^[0-9a-fA-F]{6}$/.test(h))
        return hex; // not a hex color we recognize - pass through as-is

    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export class ThemeService {
    constructor() {
        /** @private {Gio.File} */
        this._themeFile = null;
        /** @private {boolean} */
        this._isInitialized = false;
        /** @private {object|null} in-memory cache, reloaded on save()/reload() */
        this._cache = null;
    }

    /**
     * @method init
     * @description Resolves `theme.json`'s path under
     * `~/.config/gnome-widget-center/` (same base directory
     * StorageService.init() creates) and loads it into the in-memory
     * cache. Safe to call more than once (no-op after the first).
     */
    init() {
        if (this._isInitialized)
            return;

        const configPath = GLib.get_user_config_dir();
        const baseDirPath = GLib.build_filenamev([configPath, 'gnome-widget-center']);
        const baseDir = Gio.File.new_for_path(baseDirPath);
        if (!baseDir.query_exists(null))
            baseDir.make_directory_with_parents(null);

        const themePath = GLib.build_filenamev([baseDirPath, THEME_FILE_NAME]);
        this._themeFile = Gio.File.new_for_path(themePath);

        this._isInitialized = true;
        this.reload();
    }

    /**
     * @method getThemeFilePath
     * @description Public getter for `theme.json`'s absolute path, used
     * by a ThemeWatcher (same Gio.FileMonitor pattern as
     * settingsWatcher.js) so the Shell process can pick up a change made
     * from the Control Center's (separate-process) appearance page live,
     * without needing a Shell restart.
     * @returns {string}
     */
    getThemeFilePath() {
        if (!this._isInitialized) this.init();
        return this._themeFile.get_path();
    }

    /**
     * @method reload
     * @description Re-reads `theme.json` from disk into the in-memory
     * cache. A missing or corrupt file is not an error — it just means
     * "nothing customized yet", so every getter below falls back to
     * DEFAULT_GLOBAL_THEME / an empty per-widget entry either way.
     */
    reload() {
        if (!this._isInitialized) this.init();

        if (!this._themeFile.query_exists(null)) {
            this._cache = {version: 1, global: {}, widgets: {}};
            return;
        }

        try {
            const [success, contents] = this._themeFile.load_contents(null);
            if (!success) {
                this._cache = {version: 1, global: {}, widgets: {}};
                return;
            }
            const jsonString = new TextDecoder('utf-8').decode(contents);
            const parsed = JSON.parse(jsonString);
            this._cache = {
                version: parsed.version ?? 1,
                global: parsed.global ?? {},
                widgets: parsed.widgets ?? {},
            };
        } catch (error) {
            logError(error, 'Failed to load theme.json — falling back to defaults');
            this._cache = {version: 1, global: {}, widgets: {}};
        }
    }

    /**
     * @method save
     * @description Atomically writes the full theme config back to disk
     * (same `replace_contents(..., REPLACE_DESTINATION, ...)` pattern as
     * StorageService.saveLayout()/saveWidgetSettings()), then refreshes
     * the in-memory cache from what was just written so callers reading
     * back immediately after save() never see stale data.
     * @param {object} themeConfig - `{global, widgets}`, same shape as
     *   the file format documented at the top of this file.
     */
    save(themeConfig) {
        if (!this._isInitialized) this.init();

        try {
            const payload = {
                version: 1,
                global: themeConfig?.global ?? {},
                widgets: themeConfig?.widgets ?? {},
            };
            const jsonString = JSON.stringify(payload, null, 2);
            const bytes = new TextEncoder().encode(jsonString);

            this._themeFile.replace_contents(
                bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

            this._cache = payload;
        } catch (error) {
            logError(error, 'Failed to save theme.json');
            throw error;
        }
    }

    /**
     * @method getGlobalTheme
     * @description Global background/drop-shadow config, merged over
     * DEFAULT_GLOBAL_THEME so a partially-specified `theme.json` (e.g.
     * only `background.color` set) never leaves the other fields
     * `undefined` for a CSS generator to choke on.
     * @returns {{background: object, dropShadow: object}}
     */
    getGlobalTheme() {
        if (!this._isInitialized) this.init();
        const g = this._cache.global ?? {};
        return {
            background: {...DEFAULT_GLOBAL_THEME.background, ...(g.background ?? {})},
            dropShadow: {...DEFAULT_GLOBAL_THEME.dropShadow, ...(g.dropShadow ?? {})},
        };
    }

    /**
     * @method getWidgetTheme
     * @description One widget's theme entry — `{theme, config, position}`
     * — or an empty-but-well-shaped object if the widget has no entry yet
     * (never `null`/`undefined`, so callers can destructure without a
     * null-check every time).
     * @param {string} widgetId
     * @returns {{theme: string|null, config: object, position: object|null}}
     */
    getWidgetTheme(widgetId) {
        if (!this._isInitialized) this.init();
        const entry = this._cache.widgets?.[widgetId] ?? {};
        return {
            theme: entry.theme ?? null,
            config: entry.config ?? {},
            position: entry.position ?? null,
        };
    }

    /**
     * @method setWidgetTheme
     * @description Merges `patch` into one widget's theme entry and
     * persists the whole file immediately (this is a low-frequency,
     * user-driven write from a settings/theme page — not a hot path like
     * widgetSettings.js's per-keystroke debounce, so no debounce here).
     * @param {string} widgetId
     * @param {{theme?: string, config?: object, position?: object}} patch
     */
    setWidgetTheme(widgetId, patch) {
        if (!this._isInitialized) this.init();
        const current = this._cache.widgets?.[widgetId] ?? {};
        const merged = {
            theme: patch.theme ?? current.theme,
            config: {...(current.config ?? {}), ...(patch.config ?? {})},
            position: patch.position ?? current.position,
        };
        this.save({
            global: this._cache.global,
            widgets: {...this._cache.widgets, [widgetId]: merged},
        });
    }

    /**
     * @method setGlobalTheme
     * @description Merges `patch` (partial `{background, dropShadow}`)
     * into the global theme and persists the whole file.
     * @param {{background?: object, dropShadow?: object}} patch
     */
    setGlobalTheme(patch) {
        if (!this._isInitialized) this.init();
        const current = this.getGlobalTheme();
        this.save({
            global: {
                background: {...current.background, ...(patch.background ?? {})},
                dropShadow: {...current.dropShadow, ...(patch.dropShadow ?? {})},
            },
            widgets: this._cache.widgets,
        });
    }

    /**
     * @method getGlobalBackgroundCss
     * @description Renders the global `background` config to a St
     * ad hoc CSS declaration string, ready for `actor.set_style()`.
     * `blur` is emitted as a St `-st-background-blur` px value where
     * supported; a widget's own stylesheet.css can still override any of
     * this per-widget via a more specific selector, `set_style()` is
     * lowest-priority (inline-equivalent) CSS same as HTML.
     * @returns {string}
     */
    getGlobalBackgroundCss() {
        const {background} = this.getGlobalTheme();
        const alpha = background.transparent ? 0 : 1;
        const parts = [`background-color: ${hexToRgba(background.color, alpha)};`];
        if (Number.isFinite(background.blur) && background.blur > 0)
            parts.push(`-st-background-blur: ${Math.round(background.blur)}px;`);
        return parts.join(' ');
    }

    /**
     * @method getGlobalDropShadowCss
     * @description Renders the global `dropShadow` config to a
     * `box-shadow` declaration (St supports the standard CSS box-shadow
     * syntax). Returns an empty string (no shadow at all) if `enabled`
     * is false or `transparent` is true (a fully transparent shadow is
     * indistinguishable from none, so this short-circuits rather than
     * emitting a shadow with alpha=0 that costs a render pass for
     * nothing).
     * @returns {string}
     */
    getGlobalDropShadowCss() {
        const {dropShadow} = this.getGlobalTheme();
        if (!dropShadow.enabled || dropShadow.transparent)
            return '';

        const alpha = clampUnit(dropShadow.opacity, DEFAULT_GLOBAL_THEME.dropShadow.opacity);
        const color = hexToRgba(dropShadow.color, alpha);
        const offsetX = Number.isFinite(dropShadow.offsetX) ? dropShadow.offsetX : 0;
        const offsetY = Number.isFinite(dropShadow.offsetY) ? dropShadow.offsetY : 4;
        const blur = Number.isFinite(dropShadow.blurRadius) ? Math.max(0, dropShadow.blurRadius) : 12;
        const spread = Number.isFinite(dropShadow.spread) ? dropShadow.spread : 0;

        return `box-shadow: ${offsetX}px ${offsetY}px ${blur}px ${spread}px ${color};`;
    }

    /**
     * @method applyGlobalStyle
     * @description Convenience for callers (WidgetLayer's background
     * container, a widget's back-side card in widgetEditMode.js, etc.) —
     * applies BOTH the global background and drop-shadow CSS to one
     * actor via `set_style()` in a single call. Additive with whatever
     * static class-based CSS the actor already has in stylesheet.css;
     * `set_style()` only ever sets the ad hoc declarations passed here,
     * it doesn't remove the actor's `style_class`.
     * @param {St.Widget} actor
     */
    applyGlobalStyle(actor) {
        if (!actor)
            return;
        const css = [this.getGlobalBackgroundCss(), this.getGlobalDropShadowCss()]
            .filter(Boolean)
            .join(' ');
        actor.set_style(css);
    }

    /**
     * @method getEffectiveWidgetTheme
     * @description Global background/dropShadow, overridden field-by-field
     * by anything a widget's own `theme.json` entry sets under
     * `config.background`/`config.dropShadow` — e.g. a widget can opt out
     * of the global blur just for itself with
     * `{"config": {"background": {"blur": 0}}}` without having to restate
     * every other global field. Widgets that set nothing there just get
     * the global theme unchanged.
     * @param {string} widgetId
     * @returns {{background: object, dropShadow: object}}
     */
    getEffectiveWidgetTheme(widgetId) {
        const base = this.getGlobalTheme();
        const {config} = this.getWidgetTheme(widgetId);
        return {
            background: {...base.background, ...(config?.background ?? {})},
            dropShadow: {...base.dropShadow, ...(config?.dropShadow ?? {})},
        };
    }

    /**
     * @method applyWidgetStyle
     * @description Same as `applyGlobalStyle()`, but resolved through
     * `getEffectiveWidgetTheme()` so a per-widget override (see above)
     * takes effect. Intended for a widget's own FRONT actor — deliberately
     * NOT called automatically for every widget: only widgets that opt in
     * via `metadata.json`'s `"themeable": true` (see
     * development/docs/WIDGET_API.md) get styled this way, so an existing
     * widget that already paints its own background (e.g. macos-clock)
     * isn't silently overridden by a host-wide default it never asked for.
     * @param {St.Widget} actor
     * @param {string} widgetId
     */
    applyWidgetStyle(actor, widgetId) {
        if (!actor)
            return;
        const {background, dropShadow} = this.getEffectiveWidgetTheme(widgetId);
        const alpha = background.transparent ? 0 : 1;
        const parts = [`background-color: ${hexToRgba(background.color, alpha)};`];
        if (Number.isFinite(background.blur) && background.blur > 0)
            parts.push(`-st-background-blur: ${Math.round(background.blur)}px;`);

        if (dropShadow.enabled && !dropShadow.transparent) {
            const shadowAlpha = clampUnit(dropShadow.opacity, DEFAULT_GLOBAL_THEME.dropShadow.opacity);
            const color = hexToRgba(dropShadow.color, shadowAlpha);
            const offsetX = Number.isFinite(dropShadow.offsetX) ? dropShadow.offsetX : 0;
            const offsetY = Number.isFinite(dropShadow.offsetY) ? dropShadow.offsetY : 4;
            const blur = Number.isFinite(dropShadow.blurRadius) ? Math.max(0, dropShadow.blurRadius) : 12;
            const spread = Number.isFinite(dropShadow.spread) ? dropShadow.spread : 0;
            parts.push(`box-shadow: ${offsetX}px ${offsetY}px ${blur}px ${spread}px ${color};`);
        }

        actor.set_style(parts.join(' '));
    }

    /**
     * @method watch
     * @description Cross-process live reload — same problem
     * settingsWatcher.js solves for `widgets/<id>.json`, applied to
     * `theme.json`: the Control Center's (separate process, separate GJS
     * runtime — see widgetSettings.js's doc comment on why) Appearance
     * page writes `theme.json` via `save()`/`setGlobalTheme()`/
     * `setWidgetTheme()`, but this ThemeService instance's in-memory
     * `_cache` in the SHELL process has no way to know that happened
     * until something tells it to `reload()`. `watch()` starts a
     * `Gio.FileMonitor` on `theme.json` itself (works across processes —
     * it watches the inode/path, not anything in-process) and calls
     * `onChange()` (already debounced 150ms, same value
     * settingsWatcher.js uses, for the same reason — coalesce the
     * multiple CHANGED events one atomic `replace_contents()` write can
     * fire) after reloading the cache, so the callback's own body can
     * just re-style actors with already-fresh data. Safe to call more
     * than once (any previous watch is torn down first).
     * @param {function():void} onChange
     */
    watch(onChange) {
        if (!this._isInitialized) this.init();
        this.unwatch();

        let monitor;
        try {
            monitor = this._themeFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
        } catch (error) {
            logError(error, 'Failed to watch theme.json for external changes');
            return;
        }

        let debounceId = null;
        const handlerId = monitor.connect('changed', () => {
            if (debounceId)
                GLib.source_remove(debounceId);
            debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                debounceId = null;
                this.reload();
                onChange();
                return GLib.SOURCE_REMOVE;
            });
        });

        this._watch = {monitor, handlerId, get debounceId() { return debounceId; }};
    }

    /**
     * @method unwatch
     * @description Stops watching `theme.json` and releases the
     * `Gio.FileMonitor` — call from extension.js's `disable()` alongside
     * every other watcher's teardown (SettingsWatcher.unwatchAll(),
     * DevWatcher, etc.) so nothing outlives the extension being disabled.
     * Safe to call when nothing is being watched (no-op).
     */
    unwatch() {
        if (!this._watch)
            return;
        if (this._watch.debounceId)
            GLib.source_remove(this._watch.debounceId);
        this._watch.monitor.disconnect(this._watch.handlerId);
        this._watch.monitor.cancel();
        this._watch = null;
    }
}
