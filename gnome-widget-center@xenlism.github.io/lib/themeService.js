// products/extension/lib/themeService.js
//
// Theme system — one JSON file (`~/.config/gnome-widget-center/theme.json`)
// covering everything Edit Mode's Settings page and the Control Center's
// global appearance page need to read/write:
//
//   - GLOBAL appearance: desktop-wide widget background (transparent
//     on/off, color, blur radius, plus a `force` flag — see below), a
//     global widget corner radius (`cornerRadius.value` + its own
//     `force` flag), and a global drop shadow (color, transparent on/off,
//     opacity/angle/distance/blur/spread - same angle+distance model as
//     lib/widgetVisualKit.js's per-widget SHADOW_DEFAULTS, so a widget's
//     own shadow and the global one share one mental model) applied to
//     every widget's card unless a widget overrides it.
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
//     A widget can override its own background (`config.background`,
//     e.g. `{color, transparent}`) and/or corner radius
//     (`config.cornerRadius`, e.g. `{value}`) — see
//     getEffectiveWidgetTheme() below, always merged with the global
//     theme now (no force flag on this side any more — see 2026-08-09
//     note below).
//
//     2026-08-09: background/cornerRadius/dropShadow's `force` flags
//     (originally 2026-07-25/2026-08-03) were RETIRED from this file —
//     Force for those three properties now lives entirely in
//     lib/forceSettingsHelper.js's GSettings-backed 4-switch model (see
//     that file's header), which every widget that calls
//     lib/widgetVisualKit.js's cardStyleCss()/blurCss()/
//     shadowBoxShadowCss() already consults instead of these. Kept
//     UNCHANGED here: `global.border.force` / `global.opacity.force` —
//     border/opacity were a deliberate product decision to keep on this
//     older per-property mechanism (see getEffectiveWidgetTheme()'s own
//     comment) and are out of scope for this retirement.
//
//     MIGRATION NOTE: an existing theme.json written before this date
//     may still contain `"force": true/false` under `global.background`/
//     `global.cornerRadius`/`global.dropShadow`. That's harmless —
//     save()/reload() round-trip whatever's in the file verbatim, so the
//     key isn't stripped — but getEffectiveWidgetTheme() no longer reads
//     it, so it's dead data. Anyone who had e.g.
//     `global.background.force: true` set will see NO functional change
//     from that flag any more.
//
//     2026-08-09 (later same day): `themeable: true` widgets — the ones
//     routed through ThemeService.applyWidgetStyle() rather than
//     widgetVisualKit.js, see extension.js's `_reapplyTheme()` — were
//     briefly a real gap here (no equivalent Force mechanism at all, see
//     applyWidgetStyle()'s own doc comment for the full history).
//     Closed: applyWidgetStyle() now also consults ForceSettingsHelper,
//     via the new setForceSettingsHelper() below, once extension.js
//     wires one in — same GSettings-backed 4-switch model
//     widgetVisualKit.js's cardStyleCss()/blurCss()/shadowBoxShadowCss()
//     already use. Border/Opacity are unaffected either way — they stay
//     on this file's own older per-property mechanism regardless of
//     themeable/non-themeable.
//
// File format (`theme.json`):
//
//   {
//     "version": 1,
//     "global": {
//       "background": {
//         "transparent": true,
//         "color": "#1e1e2e",
//         "blur": 12,
//         "force": false
//       },
//       "cornerRadius": {
//         "value": 12,
//         "force": false
//       },
//       "dropShadow": {
//         "enabled": true,
//         "transparent": false,
//         "color": "#000000",
//         "opacity": 0.45,
//         "angle": 90,
//         "distance": 4,
//         "blurRadius": 12,
//         "spread": 0,
//         "force": false
//       }
//     },
//     "widgets": {
//       "clock": {
//         "theme": "default",
//         "config": {
//           "accentColor": "#ffffff",
//           "background": { "transparent": false, "color": "#202030" },
//           "cornerRadius": { "value": 20 }
//         },
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
import {ensureDirectory, readTextFile, writeTextFile} from './fsUtils.js';
import {angleDistanceToOffset, boxShadowCss, toCssColor, withAlphaHex} from './widgetVisualKit.js';

const THEME_FILE_NAME = 'theme.json';

const DEFAULT_GLOBAL_THEME = Object.freeze({
    // 2026-08-04, part of the Function Helper task's Border/Blur/Opacity
    // additions (see lib/widgetVisualKit.js's BORDER_DEFAULTS/borderCss()
    // - the per-widget settings-field equivalent of this). Same
    // independent-from-background reasoning as cornerRadius above: a
    // widget can want a border with no fill, or a fill with no border.
    border: Object.freeze({
        enabled: false,
        width: 1,
        color: '#FFFFFF33',
        force: false,
    }),
    // 2026-08-04. Fades the ENTIRE widget - background, text, icons,
    // everything - unlike background.transparent/color's alpha channel,
    // which only affects the background fill. See
    // lib/widgetVisualKit.js's OPACITY_DEFAULTS/opacityValue().
    opacity: Object.freeze({
        value: 100, // percent, 0-100
        force: false,
    }),
    background: Object.freeze({
        transparent: true,
        color: '#1e1e2e',
        blur: 0,
        // 2026-07-25: used to carry its own `force: false` here — RETIRED
        // 2026-08-09, see this file's header comment. Force for
        // background is now GSettings-backed (lib/forceSettingsHelper.js)
        // for non-themeable widgets; this object stays the plain
        // per-widget default merge target it always was for everything
        // else. blur here is the Function Helper task's "Blur" appearance
        // category (2026-08-04) - kept as a background sub-property
        // rather than its own top-level entry since it was already
        // modeled that way before this task and there's no independent
        // use for blur without a background to blur - see
        // lib/widgetVisualKit.js's BLUR_DEFAULTS/applyCardBlur() for the
        // per-widget settings-field equivalent.
    }),
    // 2026-07-25: widget card corner radius — separate from `background`
    // (a widget can want a square, opaque card, or a rounded transparent
    // one; radius and fill are independent choices). Used to carry its
    // own `force: false` here too — retired 2026-08-09, same as
    // background above.
    cornerRadius: Object.freeze({
        value: 12,
    }),
    dropShadow: Object.freeze({
        enabled: true,
        transparent: false,
        color: '#000000',
        opacity: 0.45,
        // 2026-08-05: angle+distance instead of offsetX/offsetY - matches
        // lib/widgetVisualKit.js's SHADOW_DEFAULTS model so the global
        // shadow and a widget's own shadow settings use the same "Shadow
        // angle" dropdown (lib/widgetVisualKit.js's SHADOW_ANGLE_STEPS)
        // in both the Control Center prefs window and its St-overlay
        // twin, instead of two different mental models.
        angle: 90,      // degrees - one of SHADOW_ANGLE_STEPS
        distance: 4,    // px
        blurRadius: 12,
        spread: 0,
        // 2026-08-03: used to carry its own `force: false` here too,
        // added later because it was missed in the 2026-07-25 change -
        // retired 2026-08-09, same as background/cornerRadius above.
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
        /** @private {import('./forceSettingsHelper.js').ForceSettingsHelper|null}
         * wired in by extension.js via setForceSettingsHelper() below
         * (2026-08-09, HANDOVER_FORCE_SETTINGS.md next-steps item 1) -
         * null until then, in which case applyWidgetStyle() keeps its
         * pre-2026-08-09 behavior unchanged. */
        this._forceSettingsHelper = null;
    }

    /**
     * @method setForceSettingsHelper
     * @description Wires this service to lib/forceSettingsHelper.js's
     * GSettings-backed 4-switch Force model, so `applyWidgetStyle()` —
     * the ONLY render path for `themeable: true` widgets (see that
     * method's own doc comment and extension.js's `_reapplyTheme()`) —
     * can also honor Background Color / Corner Radius / Background Blur /
     * Shadow forcing, same as lib/widgetVisualKit.js's cardStyleCss()/
     * blurCss()/shadowBoxShadowCss() already do for every non-themeable
     * widget via that file's own setForceSettingsHelper(). Border/Opacity
     * are NOT affected by this — they stay on this file's OLDER
     * `global.border.force`/`global.opacity.force` mechanism unchanged,
     * per the standing product decision documented at this file's header
     * (getEffectiveWidgetTheme() still short-circuits those two the same
     * way it always has).
     *
     * Called once by extension.js, right after constructing its
     * ForceSettingsHelper — mirrors the "seed immediately, don't wait for
     * the first change signal" pattern `setForcedTheme()`/
     * widgetVisualKit.js's own `setForceSettingsHelper()` already use, so
     * a themeable widget that opens with a Force switch already on
     * renders forced on its very first paint. Call with `null` on
     * teardown (extension.js's `disable()`).
     * @param {import('./forceSettingsHelper.js').ForceSettingsHelper|null} helper
     */
    setForceSettingsHelper(helper) {
        this._forceSettingsHelper = helper ?? null;
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
        ensureDirectory(baseDirPath);

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

        try {
            const jsonString = readTextFile(this._themeFile.get_path());
            if (jsonString === null) {
                this._cache = {version: 1, global: {}, widgets: {}};
                return;
            }
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
            writeTextFile(this._themeFile.get_path(), JSON.stringify(payload, null, 2));
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
     * @returns {{background: object, cornerRadius: object, dropShadow: object, border: object, opacity: object}}
     */
    getGlobalTheme() {
        if (!this._isInitialized) this.init();
        const g = this._cache.global ?? {};
        return {
            background: {...DEFAULT_GLOBAL_THEME.background, ...(g.background ?? {})},
            cornerRadius: {...DEFAULT_GLOBAL_THEME.cornerRadius, ...(g.cornerRadius ?? {})},
            dropShadow: {...DEFAULT_GLOBAL_THEME.dropShadow, ...(g.dropShadow ?? {})},
            border: {...DEFAULT_GLOBAL_THEME.border, ...(g.border ?? {})},
            opacity: {...DEFAULT_GLOBAL_THEME.opacity, ...(g.opacity ?? {})},
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
     * @description Merges `patch` (partial `{background, cornerRadius,
     * dropShadow, border, opacity}`) into the global theme and persists
     * the whole file.
     *
     * BUG FIX (2026-08-09, handover v3): this used to only merge/save
     * `background`/`cornerRadius`/`dropShadow` - `border` and `opacity`
     * were silently dropped from `patch` and never written to
     * `theme.json` at all, even though `getGlobalTheme()` (above) has
     * always read them back out. That's why `lib/prefsPageBuilders.js`'s
     * "Force this border/opacity on every widget" switches looked
     * completely inert: `saveBorder()`/`saveOpacity()` called this
     * method correctly, `Gio.FileMonitor` fired, `setForcedTheme()` ran
     * with fresh data - but that fresh data never actually contained the
     * border/opacity edit the user just made, because it was never
     * persisted in the first place. Root cause of the user-reported
     * "force border opacity ยังไม่มีผลกับ widget" (Force border/opacity
     * has no effect on widgets).
     * @param {{background?: object, cornerRadius?: object, dropShadow?: object, border?: object, opacity?: object}} patch
     */
    setGlobalTheme(patch) {
        if (!this._isInitialized) this.init();
        const current = this.getGlobalTheme();
        this.save({
            global: {
                background: {...current.background, ...(patch.background ?? {})},
                cornerRadius: {...current.cornerRadius, ...(patch.cornerRadius ?? {})},
                dropShadow: {...current.dropShadow, ...(patch.dropShadow ?? {})},
                border: {...current.border, ...(patch.border ?? {})},
                opacity: {...current.opacity, ...(patch.opacity ?? {})},
            },
            widgets: this._cache.widgets,
        });
    }

    /**
     * @method getGlobalCornerRadiusCss
     * @description Renders the global `cornerRadius` config to a
     * `border-radius` St ad hoc CSS declaration, ready for
     * `actor.set_style()`. A radius of 0 is a deliberate "square corners"
     * choice, so it's still emitted (unlike background blur, which omits
     * the declaration entirely at 0 since that's the CSS default anyway).
     * @returns {string}
     */
    getGlobalCornerRadiusCss() {
        const {cornerRadius} = this.getGlobalTheme();
        if (!Number.isFinite(cornerRadius.value))
            return '';
        return `border-radius: ${Math.round(Math.max(0, cornerRadius.value))}px;`;
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
        const angle = Number.isFinite(dropShadow.angle) ? dropShadow.angle : DEFAULT_GLOBAL_THEME.dropShadow.angle;
        const distance = Number.isFinite(dropShadow.distance) ? dropShadow.distance : DEFAULT_GLOBAL_THEME.dropShadow.distance;
        const blur = Number.isFinite(dropShadow.blurRadius) ? Math.max(0, dropShadow.blurRadius) : 12;
        const spread = Number.isFinite(dropShadow.spread) ? dropShadow.spread : 0;
        const {offsetX, offsetY} = angleDistanceToOffset(angle, distance);

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
     * @description Global background/cornerRadius/dropShadow, overridden
     * field-by-field by anything a widget's own `theme.json` entry sets
     * under `config.background`/`config.cornerRadius`/`config.dropShadow`
     * — e.g. a widget can opt out of the global blur just for itself with
     * `{"config": {"background": {"blur": 0}}}` without having to restate
     * every other global field. Widgets that set nothing there just get
     * the global theme unchanged.
     *
     * `global.border.force` / `global.opacity.force` still short-circuit
     * this per-widget merge entirely for those two properties — while
     * force is on, `config.border` / `config.opacity` is not read at
     * all, so a widget can't even partially override a forced property
     * (e.g. keep the global color but change its own width).
     *
     * background/cornerRadius/dropShadow no longer have a force flag on
     * this side as of 2026-08-09 — they always merge with the per-widget
     * config below now (Force for those three lives in
     * lib/forceSettingsHelper.js instead; see this file's header
     * comment for the migration note and the known themeable-widget
     * gap).
     * @param {string} widgetId
     * @returns {{background: object, cornerRadius: object, dropShadow: object, border: object, opacity: object}}
     */
    getEffectiveWidgetTheme(widgetId) {
        const base = this.getGlobalTheme();
        const {config} = this.getWidgetTheme(widgetId);

        const background = {...base.background, ...(config?.background ?? {})};
        const cornerRadius = {...base.cornerRadius, ...(config?.cornerRadius ?? {})};
        const dropShadow = {...base.dropShadow, ...(config?.dropShadow ?? {})};

        const border = base.border.force
            ? {...base.border}
            : {...base.border, ...(config?.border ?? {})};

        const opacity = base.opacity.force
            ? {...base.opacity}
            : {...base.opacity, ...(config?.opacity ?? {})};

        return {background, cornerRadius, dropShadow, border, opacity};
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
     *
     * Force Settings (2026-08-09, HANDOVER_FORCE_SETTINGS.md next-steps
     * item 1): this is the ONLY render path `themeable: true` widgets go
     * through, so — unlike every other widget, which paints via
     * lib/widgetVisualKit.js's cardStyleCss()/blurCss()/
     * shadowBoxShadowCss() and already consults
     * lib/forceSettingsHelper.js there — this method used to have no
     * equivalent at all: a themeable widget simply couldn't be forced for
     * Background Color/Corner Radius/Background Blur/Shadow, even with
     * every other widget on the desktop obeying those switches. Closed by
     * bridging this widget's effective background/cornerRadius/dropShadow
     * into the same `{background, shadow}` shape and calling
     * `this._forceSettingsHelper.resolve()`, once `setForceSettingsHelper()`
     * has wired an instance in — inert (falls through to the unchanged
     * pre-2026-08-09 rendering) until then. Border/Opacity are untouched —
     * they still only ever come from this file's own
     * `global.border.force`/`global.opacity.force`, same as before.
     * @param {St.Widget} actor
     * @param {string} widgetId
     */
    applyWidgetStyle(actor, widgetId) {
        if (!actor)
            return;
        const {background, cornerRadius, dropShadow, border} = this.getEffectiveWidgetTheme(widgetId);

        // Force Settings (2026-08-09, HANDOVER_FORCE_SETTINGS.md
        // next-steps item 1) — bridge this widget's own effective
        // background/cornerRadius/dropShadow (already merged with the
        // global theme above) into the same {background, shadow} shape
        // lib/widgetVisualKit.js's cardStyleCss()/shadowBoxShadowCss()
        // feed lib/forceSettingsHelper.js's resolve(), so a themeable
        // widget resolves Force identically to every other widget.
        // `resolved` stays `null` (falling through to the exact
        // pre-2026-08-09 rendering below, unchanged) until extension.js
        // calls setForceSettingsHelper() — same "inert until wired"
        // contract widgetVisualKit.js's own copy of this already has.
        const resolved = this._forceSettingsHelper
            ? this._forceSettingsHelper.resolve({
                background: {
                    color: withAlphaHex(background.color ?? '#1e1e2e', background.transparent ? 0 : 1),
                    cornerRadius: cornerRadius.value,
                    blur: background.blur,
                },
                shadow: {
                    // `transparent` folded into `enabled` here since
                    // resolve() only has one on/off flag for the whole
                    // group — matches this method's own pre-existing
                    // `dropShadow.enabled && !dropShadow.transparent`
                    // gate below, just evaluated once up front instead
                    // of at render time.
                    enabled: dropShadow.enabled && !dropShadow.transparent,
                    color: dropShadow.color,
                    opacity: Math.round(clampUnit(dropShadow.opacity, DEFAULT_GLOBAL_THEME.dropShadow.opacity) * 100),
                    spread: dropShadow.spread,
                    blur: dropShadow.blurRadius,
                },
            })
            : null;

        const parts = [];

        if (resolved) {
            parts.push(`background-color: ${toCssColor(resolved.background.color, '#000000F5')};`);
            if (Number.isFinite(resolved.background.blur) && resolved.background.blur > 0)
                parts.push(`-st-background-blur: ${Math.round(resolved.background.blur)}px;`);
            if (Number.isFinite(resolved.background.cornerRadius))
                parts.push(`border-radius: ${Math.round(Math.max(0, resolved.background.cornerRadius))}px;`);
            if (resolved.shadow.enabled) {
                parts.push(boxShadowCss({
                    color: resolved.shadow.color,
                    opacityPercent: resolved.shadow.opacity,
                    angleDeg: resolved.shadow.angle,
                    distance: resolved.shadow.distance,
                    blur: resolved.shadow.blur,
                    spread: resolved.shadow.spread,
                }));
            }
        } else {
            const alpha = background.transparent ? 0 : 1;
            parts.push(`background-color: ${hexToRgba(background.color, alpha)};`);
            if (Number.isFinite(background.blur) && background.blur > 0)
                parts.push(`-st-background-blur: ${Math.round(background.blur)}px;`);
            if (Number.isFinite(cornerRadius.value))
                parts.push(`border-radius: ${Math.round(Math.max(0, cornerRadius.value))}px;`);

            if (dropShadow.enabled && !dropShadow.transparent) {
                const shadowAlpha = clampUnit(dropShadow.opacity, DEFAULT_GLOBAL_THEME.dropShadow.opacity);
                const color = hexToRgba(dropShadow.color, shadowAlpha);
                const angle = Number.isFinite(dropShadow.angle) ? dropShadow.angle : DEFAULT_GLOBAL_THEME.dropShadow.angle;
                const distance = Number.isFinite(dropShadow.distance) ? dropShadow.distance : DEFAULT_GLOBAL_THEME.dropShadow.distance;
                const blur = Number.isFinite(dropShadow.blurRadius) ? Math.max(0, dropShadow.blurRadius) : 12;
                const spread = Number.isFinite(dropShadow.spread) ? dropShadow.spread : 0;
                const {offsetX, offsetY} = angleDistanceToOffset(angle, distance);
                parts.push(`box-shadow: ${offsetX}px ${offsetY}px ${blur}px ${spread}px ${color};`);
            }
        }

        // Border (2026-08-09 bug fix, HANDOVER item 1): unlike
        // Background/Corner Radius/Shadow above, Border stays on the
        // OLDER `global.border.force` mechanism regardless of whether a
        // ForceSettingsHelper is wired in (see this method's own doc
        // comment / getEffectiveWidgetTheme()'s header) - `border` above
        // is already fully force-resolved by getEffectiveWidgetTheme()
        // itself, so this is a plain, unconditional emit, same shape
        // lib/widgetVisualKit.js's borderCss() builds for every other
        // (non-themeable) widget. Previously this method never emitted a
        // `border:` declaration at all, so `themeable: true` widgets
        // (clock, calendar-minimal) had no way to show a border, forced
        // or otherwise.
        if (border?.enabled) {
            const width = Number.isFinite(border.width) ? Math.max(0, border.width) : DEFAULT_GLOBAL_THEME.border.width;
            const color = toCssColor(border.color ?? DEFAULT_GLOBAL_THEME.border.color, DEFAULT_GLOBAL_THEME.border.color);
            parts.push(`border: ${width}px solid ${color};`);
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
