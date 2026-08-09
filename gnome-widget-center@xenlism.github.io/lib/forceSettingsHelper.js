// lib/forceSettingsHelper.js
//
// Implements ForceSettingsSpecification.md (2026-08-09; switches split
// same day per user request into 4 independent toggles instead of 1 -
// see HANDOVER_FORCE_SETTINGS.md addendum). This is the ONE place that
// knows how to resolve a widget's Background + Shadow appearance between
// "the widget's own config.json" and "the global GSettings values" -
// see schemas/org.gnome.shell.extensions.widget-center.gschema.xml's
// "Force Settings" block for the keys this reads.
//
// FOUR independent switches, each gating its own slice - any
// combination can be on/off at once, e.g. Corner Radius forced while
// Background Color/Blur/Shadow stay per-widget:
//   force-background-color-enabled  -> background.color
//   force-corner-radius-enabled     -> background.cornerRadius
//   force-background-blur-enabled   -> background.blur
//   force-shadow-appearance-enabled -> shadow.{enabled,color,opacity,spread,blur}
//
// Per property: switch OFF -> widget config.json value for that
// property; switch ON -> the matching force-* GSettings value.
//
// Distance and Angle are the one exception to all 4 switches: they are
// ALWAYS read from GSettings, regardless of any switch's state (see
// schema key docs for shadow-distance/shadow-angle). Changing any force
// switch must never modify or overwrite a widget's own config.json
// values (spec's "Behavior" section) - this module only ever READS
// GSettings/config, it never writes a per-widget config as a side
// effect of resolving it.
//
// Per the spec's "Responsibility" table:
//   Widget                - content, widget-specific settings
//   Force Settings Helper (this file) - read/write settings, resolve
//                                        global vs per-widget values
//   Widget Container       - background/blur/shadow/corner-radius
//                            rendering of the RESOLVED values this file
//                            returns
// A widget must never read force-* GSettings keys itself, and must never
// contain force on/off branching - it hands its own config.json values
// to resolve() and paints whatever comes back.
//
// NOTE on where "Widget Container" is in this codebase: this project
// doesn't have one literal object by that name - each widget paints
// itself via the shared lib/widgetVisualKit.js CSS-string builders
// (cardStyleCss()/shadowBoxShadowCss()/etc), which is where those
// builders now call this helper instead of consulting the OLDER
// per-property force flags directly. See HANDOVER_FORCE_SETTINGS.md.
//
// This is a SEPARATE mechanism from the older, still-live per-property
// force system (background.force/cornerRadius.force/dropShadow.force/
// border.force/opacity.force, lib/themeService.js's theme.json) - by
// product decision border/opacity keep using that older mechanism
// unchanged. Only background/cornerRadius/dropShadow now go through
// this file.

/** Allowed shadow-angle steps per ForceSettingsSpecification.md.
 * 2026-08-09: imported from lib/widgetVisualKit.js instead of a
 * separate hand-kept copy — that file's own array used to have a
 * long-standing typo (275 instead of 270, missing 315) that this file
 * deliberately avoided inheriting by duplicating a corrected version
 * instead; now that the typo is fixed at the source, importing (and
 * re-exporting, since callers of this file — see prefsPageBuilders.js —
 * already get it from here) removes the duplication without
 * reintroducing the bug. Safe to import directly (no circularity):
 * widgetVisualKit.js has no static import of this file (or of anything
 * Shell/Clutter-only), only an externally-injected helper reference via
 * setForceSettingsHelper() — see that file's own header comment. */
import {SHADOW_ANGLE_STEPS} from './widgetVisualKit.js';
export {SHADOW_ANGLE_STEPS};

const DEFAULT_BACKGROUND = Object.freeze({
    color: '#1e1e2eff',
    cornerRadius: 12,
    blur: 0,
});

const DEFAULT_SHADOW = Object.freeze({
    enabled: true,
    color: '#000000ff',
    opacity: 45,
    spread: 0,
    blur: 12,
});

const DEFAULT_DISTANCE = 4;
const DEFAULT_ANGLE = 90;

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
}

function coerceAngle(value) {
    const n = Math.round(Number(value));
    return SHADOW_ANGLE_STEPS.includes(n) ? n : DEFAULT_ANGLE;
}

/**
 * @class ForceSettingsHelper
 * @description Reads schema's force-* GSettings keys and resolves the
 * effective Background/Shadow appearance for a widget. One instance is
 * shared process-wide (constructed once in extension.js, same lifecycle
 * as ThemeService) - it holds no per-widget state itself, `resolve()` is
 * a pure function of (GSettings, the config passed in).
 */
export class ForceSettingsHelper {
    /** @param {Gio.Settings} settings - the extension's own GSettings
     *  object (schema org.gnome.shell.extensions.widget-center), same
     *  instance extension.js already builds via Extension.getSettings(). */
    constructor(settings) {
        this._settings = settings;
    }

    /** @returns {boolean} whether Background Color is currently forced. */
    isBackgroundColorForced() {
        return this._settings.get_boolean('force-background-color-enabled');
    }

    /** @returns {boolean} whether Corner Radius is currently forced. */
    isCornerRadiusForced() {
        return this._settings.get_boolean('force-corner-radius-enabled');
    }

    /** @returns {boolean} whether Background Blur is currently forced. */
    isBackgroundBlurForced() {
        return this._settings.get_boolean('force-background-blur-enabled');
    }

    /** @returns {boolean} whether Shadow appearance is currently forced. */
    isShadowForced() {
        return this._settings.get_boolean('force-shadow-appearance-enabled');
    }

    /** @returns {{color: string, opacity: number, spread: number, blur: number,
     *   enabled: boolean, distance: number, angle: number}}
     * Shadow Distance/Angle ALWAYS come from here, unconditionally - see
     * file header. */
    _globalShadowDistanceAngle() {
        return {
            distance: clampInt(this._settings.get_int('shadow-distance'), 0, 30, DEFAULT_DISTANCE),
            angle: coerceAngle(this._settings.get_int('shadow-angle')),
        };
    }

    _globalBackground() {
        return {
            color: this._settings.get_string('force-background-color') || DEFAULT_BACKGROUND.color,
            cornerRadius: clampInt(this._settings.get_int('force-corner-radius'), 0, 32, DEFAULT_BACKGROUND.cornerRadius),
            blur: clampInt(this._settings.get_int('force-background-blur'), 0, 60, DEFAULT_BACKGROUND.blur),
        };
    }

    _globalShadow() {
        return {
            enabled: this._settings.get_boolean('force-shadow-enabled'),
            color: this._settings.get_string('force-shadow-color') || DEFAULT_SHADOW.color,
            opacity: clampInt(this._settings.get_int('force-shadow-opacity'), 0, 100, DEFAULT_SHADOW.opacity),
            spread: clampInt(this._settings.get_int('force-shadow-spread'), 0, 20, DEFAULT_SHADOW.spread),
            blur: clampInt(this._settings.get_int('force-shadow-blur'), 0, 60, DEFAULT_SHADOW.blur),
        };
    }

    /**
     * @method resolve
     * @description The one entry point widget rendering code should call.
     * `widgetAppearance` is whatever the widget's OWN config.json/settings
     * currently hold for background/shadow (used verbatim when Force is
     * off) - this method never reads a widget's config.json itself, the
     * caller (Widget Container) owns loading that, matching the spec's
     * "helper returns the resolved values to the Widget Container"
     * contract.
     * @param {{background?: {color?: string, cornerRadius?: number, blur?: number},
     *   shadow?: {enabled?: boolean, color?: string, opacity?: number,
     *   spread?: number, blur?: number}}} widgetAppearance
     * @returns {{background: {color: string, cornerRadius: number, blur: number},
     *   shadow: {enabled: boolean, color: string, opacity: number, spread: number,
     *   blur: number, distance: number, angle: number}}}
     */
    resolve(widgetAppearance) {
        const {distance, angle} = this._globalShadowDistanceAngle();

        const globalBackground = this.isBackgroundColorForced() || this.isCornerRadiusForced() || this.isBackgroundBlurForced()
            ? this._globalBackground()
            : null;

        // Each background property resolved independently against its
        // OWN switch - e.g. Corner Radius can be forced while Background
        // Color/Blur stay on the widget's own config.json.
        const background = {
            color: this.isBackgroundColorForced()
                ? globalBackground.color
                : (widgetAppearance?.background?.color ?? DEFAULT_BACKGROUND.color),
            cornerRadius: this.isCornerRadiusForced()
                ? globalBackground.cornerRadius
                : clampInt(widgetAppearance?.background?.cornerRadius, 0, 32, DEFAULT_BACKGROUND.cornerRadius),
            blur: this.isBackgroundBlurForced()
                ? globalBackground.blur
                : clampInt(widgetAppearance?.background?.blur, 0, 60, DEFAULT_BACKGROUND.blur),
        };

        // Shadow's 5 properties (enabled/color/opacity/spread/blur) move
        // together as one group, gated by the single Shadow switch -
        // per the 4-switch split, Shadow itself isn't broken down
        // further.
        const shadowBase = this.isShadowForced()
            ? this._globalShadow()
            : {
                enabled: widgetAppearance?.shadow?.enabled ?? DEFAULT_SHADOW.enabled,
                color: widgetAppearance?.shadow?.color ?? DEFAULT_SHADOW.color,
                opacity: clampInt(widgetAppearance?.shadow?.opacity, 0, 100, DEFAULT_SHADOW.opacity),
                spread: clampInt(widgetAppearance?.shadow?.spread, 0, 20, DEFAULT_SHADOW.spread),
                blur: clampInt(widgetAppearance?.shadow?.blur, 0, 60, DEFAULT_SHADOW.blur),
            };

        return {
            background,
            shadow: {...shadowBase, distance, angle},
        };
    }

    /**
     * @method watch
     * @description Live-reload hook - calls `onChange()` whenever any
     * force-* / shadow-distance / shadow-angle key changes, so a caller can
     * re-resolve and repaint without polling. Mirrors ThemeService.watch()'s
     * shape/debounce contract so extension.js can treat both the same way.
     * @param {function():void} onChange
     * @returns {number} the GSettings handler id - pass to unwatch().
     */
    watch(onChange) {
        return this._settings.connect('changed', (_settings, key) => {
            if (key.startsWith('force-') || key === 'shadow-distance' || key === 'shadow-angle')
                onChange();
        });
    }

    /** @method unwatch @param {number} handlerId - from watch(). */
    unwatch(handlerId) {
        if (handlerId)
            this._settings.disconnect(handlerId);
    }
}
