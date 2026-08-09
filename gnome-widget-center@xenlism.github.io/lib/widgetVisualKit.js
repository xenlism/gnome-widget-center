// lib/widgetVisualKit.js
//
// Shared visual helpers for widgets/*/widget.js: drop-shadow CSS, hex/rgba
// color conversion, and Pango font-description parsing. Every one of these
// was previously a byte-for-byte copy pasted into 30+ individual widget.js
// files (see WIDGET_API.md §9.3) - this module is the single source of
// truth they now import from instead.
//
// Path restriction (same as lib/mediaApi.js §9.1 and
// lib/systemMetricsApi.js §9.2): the relative import
// `../../lib/widgetVisualKit.js` only resolves for widgets bundled inside
// this extension. Third-party widgets installed under
// ~/.local/share/gnome-widget-center/widgets/ cannot reach this file and
// must keep their own local copies of any of these helpers they need.
//
// Every function here is a pure function of its arguments - no GObject
// state, no signals, safe to call from buildActor()/_render()/repaint
// handlers alike.

import Pango from 'gi://Pango';

// --- Global "Force" theme state (2026-08-04 bug fix) ------------------
//
// Bug: the Appearance page's "Force this X on every widget" switches
// (lib/themeService.js's background.force/cornerRadius.force/
// dropShadow.force/border.force) only ever actually reached 2 real
// widgets (calendar-minimal, clock) - everything else that calls
// cardStyleCss()/shadowBoxShadowCss() below (~50 widgets, after
// 2026-08-03's standardization sweep) kept painting its own local
// settings, completely unaware "force" existed, and its next natural
// re-render (a media player's next track, a clock's next tick, a
// settings change, ...) would silently overwrite whatever
// lib/themeService.js's applyWidgetStyle() had painted moments earlier
// anyway - that mechanism only runs once, at widget placement / on a
// theme.json file change, not on every render.
//
// Fix: rather than touch every widget's own call site (or every
// widget's _render() needing to know about ThemeService), the force
// state lives here as plain module state that these CSS-string builder
// functions consult on every call, transparently to their callers - so
// the exact same `cardStyleCss(this._settings, {...})` every widget
// already calls automatically starts respecting "force" the moment
// setForcedTheme() below has been called once, with zero widget.js
// changes needed. extension.js calls setForcedTheme() once at startup
// and again every time ThemeService's file-watch fires (theme.json
// changed - same live cross-process reload path applyWidgetStyle()
// already used).
let _forcedTheme = null;

/**
 * Sets (or clears, with `null`) the process-wide forced theme state that
 * cardStyleCss()/shadowBoxShadowCss()/borderCss()/blurCss() below consult.
 * Called by extension.js, never by a widget itself.
 * @param {{background: object, cornerRadius: object, dropShadow: object, border: object}|null} theme
 *   - the shape lib/themeService.js's ThemeService.getGlobalTheme() returns.
 */
export function setForcedTheme(theme) {
    _forcedTheme = theme ?? null;
}

/** @private true if `_forcedTheme[category].force` is on. */
function _isForced(category) {
    return !!_forcedTheme?.[category]?.force;
}

// --- ForceSettingsHelper wiring (2026-08-09, HANDOVER_FORCE_SETTINGS.md
// "not done yet" step 1) --------------------------------------------
//
// Background Color / Corner Radius / Background Blur / Shadow now
// resolve through lib/forceSettingsHelper.js's GSettings-backed
// ForceSettingsHelper instead of the OLDER _forcedTheme state above.
// Border and Opacity are UNCHANGED — by product decision they stay on
// the older theme.json _forcedTheme mechanism (see borderCss() below,
// untouched by this wiring), so _forcedTheme/_isForced()/setForcedTheme()
// are still very much alive, just no longer consulted for the three
// properties this helper now owns.
//
// Same injection pattern as setForcedTheme() above: plain module state,
// set once by extension.js (HANDOVER's "not done yet" step 2, not yet
// wired as of this commit) so every widget's existing
// `cardStyleCss(this._settings, {...})` call site starts respecting the
// new 4 switches with zero widget.js changes, the moment extension.js
// calls setForceSettingsHelper() at startup - identical zero-call-site-
// change contract to setForcedTheme()'s own doc comment above.
//
// Until extension.js wiring lands, `_forceSettingsHelper` stays `null`
// and every function below transparently falls back to its pre-existing
// behavior (old _forcedTheme consultation for background/cornerRadius/
// dropShadow, or the widget's own settings if nothing is forced) - so
// this commit changes no runtime behavior by itself.
let _forceSettingsHelper = null;

/**
 * Sets (or clears, with `null`) the process-wide ForceSettingsHelper
 * instance that cardStyleCss()/shadowBoxShadowCss()/blurCss() below
 * consult for Background Color/Corner Radius/Background Blur/Shadow.
 * Called by extension.js, never by a widget itself.
 * @param {import('./forceSettingsHelper.js').ForceSettingsHelper|null} helper
 */
export function setForceSettingsHelper(helper) {
    _forceSettingsHelper = helper ?? null;
}

/** @private Maps this file's flat widget-settings field names (a
 * widget's own config.json/settings object) into the
 * `{background, shadow}` shape lib/forceSettingsHelper.js's resolve()
 * expects, and returns its resolved result - or `null` when no helper
 * has been wired in yet (setForceSettingsHelper() never called), so
 * callers can fall back to the older _forcedTheme path.
 *
 * Field-shape differences bridged here:
 *  - blur: this file models it as `blurEnabled` (bool) + `blurRadius`
 *    (px), the helper just wants a single `blur` px number where 0
 *    means off - `blurEnabled ? blurRadius : 0` bridges that.
 *  - shadow spread: widgets bundled in this codebase have no per-widget
 *    spread field (shadowBoxShadowCss() has always hardcoded 0 for it,
 *    see below) - passed through as 0 here too, unchanged behavior.
 *  - shadow distance/angle: deliberately NOT read from `settings` here
 *    at all - the helper always returns GSettings' shadow-distance/
 *    shadow-angle regardless of what's passed in, per
 *    ForceSettingsSpecification.md's "Distance and Angle are always
 *    stored in GSettings" rule, so there's nothing to bridge for them.
 * @param {object} settings - widget's own settings object
 * @param {{backgroundColorKey?: string, cornerRadiusKey?: string}} [keys]
 * @returns {{background: {color: string, cornerRadius: number, blur: number},
 *   shadow: {enabled: boolean, color: string, opacity: number, spread: number,
 *   blur: number, distance: number, angle: number}}|null}
 */
function _resolveForceSettings(settings, {backgroundColorKey = 'backgroundColor', cornerRadiusKey = 'cornerRadius'} = {}) {
    if (!_forceSettingsHelper)
        return null;

    const s = settings ?? {};
    return _forceSettingsHelper.resolve({
        background: {
            color: s[backgroundColorKey],
            cornerRadius: s[cornerRadiusKey],
            blur: (s.blurEnabled ?? BLUR_DEFAULTS.blurEnabled) ? s.blurRadius : 0,
        },
        shadow: {
            enabled: s.shadowEnabled,
            color: s.shadowColor,
            opacity: s.shadowOpacity,
            spread: 0,
            blur: s.shadowBlur,
        },
    });
}

/** Allowed shadow-angle steps, shared by every "Shadow angle" dropdown in
 * the codebase (a widget's own Appearance settings, the Control Center's
 * global Appearance page, and its St-overlay twin) so they can never drift
 * out of sync with each other. Degrees: 0 = right, 90 = down, 180 = left,
 * 270 = up - same convention SHADOW_DEFAULTS/TEXT_SHADOW_DEFAULTS below
 * already documented before this became a fixed-step dropdown. */
// 2026-08-09 fix: was `[45, 90, 135, 180, 225, 275]` — 275 was a typo
// for 270, and 315 was missing entirely (breaks the otherwise-even
// 45-degree spacing). lib/forceSettingsHelper.js used to keep its own
// separate, already-correct copy of this array specifically because
// this one had the bug (see that file's own comment, now stale —
// updated alongside this fix to import from here instead of
// duplicating). A stored `theme.json`/GSettings angle value of 275 that
// predates this fix will no longer match any entry here — anything that
// validates against this array before falling back to 90° (e.g.
// forceSettingsHelper.js's own coerceAngle()) already treats an
// unrecognized value as "reset to default", so this degrades to the
// default angle rather than crashing, but IS a behavior change for
// anyone who had explicitly picked the old (nonstandard) 275° option.
export const SHADOW_ANGLE_STEPS = [45, 90, 135, 180, 225, 270, 315];

/** Degrees + px distance -> `{offsetX, offsetY}` px, the one trig
 * conversion every box-shadow/text-shadow builder in this file (and
 * lib/themeService.js's global-theme equivalents) goes through, so an
 * angle always maps to the same offset everywhere it's used. */
export function angleDistanceToOffset(angleDeg, distance) {
    const rad = (angleDeg * Math.PI) / 180;
    return {
        offsetX: Math.round(Math.cos(rad) * distance * 100) / 100,
        offsetY: Math.round(Math.sin(rad) * distance * 100) / 100,
    };
}

/** Default shadow settings a widget's getDefaultSettings() should spread
 * in (`...SHADOW_DEFAULTS`) so the shadow fields exist with sane values
 * even before the user opens the widget's settings panel. */
export const SHADOW_DEFAULTS = {
    shadowEnabled: false,
    shadowColor: '#000000',
    shadowOpacity: 30, // percent, 0-100
    shadowAngle: 90,   // degrees - one of SHADOW_ANGLE_STEPS above
    shadowDistance: 6, // px
    shadowBlur: 16,    // px
};

/** Shared by shadowBoxShadowCss()/_forcedShadowBoxShadowCss() below so
 * the "which shape of shadow settings am I reading" code paths (a
 * widget's own angle+distance settings vs. lib/themeService.js's global
 * angle+distance theme) still funnel through exactly one "build the
 * box-shadow string" implementation, instead of two copies that could
 * quietly drift apart. Exported (2026-08-09, HANDOVER_FORCE_SETTINGS.md
 * next-steps item 1) so lib/themeService.js's applyWidgetStyle() — the
 * themeable-widget render path, entirely separate from this file's own
 * cardStyleCss()/shadowBoxShadowCss() — can build an identical
 * `box-shadow:` string from its own ForceSettingsHelper.resolve() result,
 * rather than hand-rolling a third copy of this logic.
 *
 * NOTE: `color` is validated as a plain 6-hex-digit string (post
 * `#`-stripping) — an 8-digit alpha-baked hex (as ForceSettingsHelper's
 * forced shadow color is stored) will fail that check and fall back to
 * black, with `opacityPercent` supplying the alpha instead. Pre-existing
 * behavior, unchanged by this export.
 * @param {{color: string, opacityPercent: number, angleDeg: number,
 *   distance: number, blur: number, spread: number}} shadow
 * @returns {string}
 */
export function boxShadowCss({color, opacityPercent, angleDeg, distance, blur, spread}) {
    const {offsetX, offsetY} = angleDistanceToOffset(angleDeg, distance);

    let hex = (color ?? SHADOW_DEFAULTS.shadowColor).trim().replace(/^#/, '');
    if (hex.length === 3)
        hex = hex.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(hex))
        hex = '000000';
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = Math.min(1, Math.max(0, opacityPercent / 100));

    return `box-shadow: ${offsetX}px ${offsetY}px ${Math.max(0, blur)}px ${spread}px rgba(${r}, ${g}, ${b}, ${a});`;
}

/**
 * Force-aware blur decision helper for cardLayers.js's applyCardBlur().
 * Returns {enabled, radius} based on force state or widget settings.
 * @param {object} settings
 * @returns {{enabled: boolean, radius: number}}
 */
export function getForceAwareBlurSettings(settings) {
    const resolved = _resolveForceSettings(settings);
    if (resolved) {
        const radius = resolved.background.blur;
        return {
            enabled: Number.isFinite(radius) && radius > 0,
            radius: Math.max(0, radius ?? BLUR_DEFAULTS.blurRadius),
        };
    }

    if (_isForced('background')) {
        const radius = _forcedTheme.background?.blur;
        return {
            enabled: Number.isFinite(radius) && radius > 0,
            radius: Math.max(0, radius ?? BLUR_DEFAULTS.blurRadius),
        };
    }

    const s = settings ?? {};
    return {
        enabled: s.blurEnabled ?? BLUR_DEFAULTS.blurEnabled,
        radius: Number.isFinite(s.blurRadius) ? Math.max(0, s.blurRadius) : BLUR_DEFAULTS.blurRadius,
    };
}

/** Builds a `box-shadow: ...;` CSS declaration (St supports the standard
 * CSS box-shadow syntax) from a widget's shadow settings, or '' when the
 * shadow is off - always safe to splice directly into a set_style()
 * template literal.
 *
 * Force-aware via lib/forceSettingsHelper.js's "Shadow" switch (see
 * setForceSettingsHelper() above) once extension.js has wired a helper
 * in - Shadow's 5 sub-fields (enabled/color/opacity/spread/blur) move
 * together as one group when forced, and Distance/Angle are ALWAYS the
 * GSettings values regardless of the switch, per spec. Falls back to
 * the OLDER `_forcedTheme` "Force this drop shadow" switch when no
 * helper has been wired in yet (same "can't even partially override"
 * contract lib/themeService.js's getEffectiveWidgetTheme() documents).
 * @param {object} settings - widget settings object; only the
 *   shadow* fields are read, missing ones fall back to SHADOW_DEFAULTS.
 * @returns {string}
 */
export function shadowBoxShadowCss(settings) {
    const resolved = _resolveForceSettings(settings);
    if (resolved) {
        const {shadow} = resolved;
        if (!shadow.enabled)
            return '';
        return boxShadowCss({
            color: shadow.color,
            opacityPercent: shadow.opacity,
            angleDeg: shadow.angle,
            distance: shadow.distance,
            blur: shadow.blur,
            spread: shadow.spread,
        });
    }

    if (_isForced('dropShadow'))
        return _forcedShadowBoxShadowCss(_forcedTheme.dropShadow);

    const s = settings ?? {};
    if (!(s.shadowEnabled ?? SHADOW_DEFAULTS.shadowEnabled))
        return '';

    return boxShadowCss({
        color: s.shadowColor ?? SHADOW_DEFAULTS.shadowColor,
        opacityPercent: Number.isFinite(s.shadowOpacity) ? s.shadowOpacity : SHADOW_DEFAULTS.shadowOpacity,
        angleDeg: Number.isFinite(s.shadowAngle) ? s.shadowAngle : SHADOW_DEFAULTS.shadowAngle,
        distance: Number.isFinite(s.shadowDistance) ? s.shadowDistance : SHADOW_DEFAULTS.shadowDistance,
        blur: Number.isFinite(s.shadowBlur) ? s.shadowBlur : SHADOW_DEFAULTS.shadowBlur,
        spread: 0,
    });
}

/** @private converts lib/themeService.js's global dropShadow shape
 * (`{enabled, transparent, color, opacity: 0-1, angle, distance,
 * blurRadius, spread}` - notably a flat 0-1 opacity float rather than
 * shadowBoxShadowCss()'s own 0-100 percent) into the same
 * `box-shadow: ...;` string shape, through the SAME `boxShadowCss()`
 * helper shadowBoxShadowCss() itself uses above - mirroring
 * lib/themeService.js's applyWidgetStyle()'s identical angle+distance
 * conversion so every code path produces the same visual result for the
 * same angle. */
function _forcedShadowBoxShadowCss(dropShadow) {
    if (!dropShadow?.enabled || dropShadow?.transparent)
        return '';
    const opacity = Number.isFinite(dropShadow.opacity) ? Math.min(1, Math.max(0, dropShadow.opacity)) : 0.45;
    return boxShadowCss({
        color: dropShadow.color ?? '#000000',
        opacityPercent: opacity * 100,
        angleDeg: Number.isFinite(dropShadow.angle) ? dropShadow.angle : 90,
        distance: Number.isFinite(dropShadow.distance) ? dropShadow.distance : 4,
        blur: Number.isFinite(dropShadow.blurRadius) ? dropShadow.blurRadius : 12,
        spread: Number.isFinite(dropShadow.spread) ? dropShadow.spread : 0,
    });
}

/** "#rrggbb" + a 0-1 alpha float -> "#rrggbbaa", so it can be run back
 * through toCssColor() the same way every other color in this file is -
 * keeps the hex-alpha-encoding convention in exactly one place
 * (toCssColor()) instead of building an rgba() string by hand here too.
 * Exported (2026-08-09, HANDOVER_FORCE_SETTINGS.md next-steps item 1) so
 * lib/themeService.js's applyWidgetStyle() can bake its own separate
 * `background.transparent` boolean into the same alpha-in-hex shape
 * before handing it to ForceSettingsHelper.resolve() - same bridging
 * this file already does for `_forcedTheme.background` just above. */
export function withAlphaHex(hex6, alpha01) {
    const m = /^#([0-9a-fA-F]{6})$/.exec((hex6 ?? '').trim());
    if (!m)
        return '#000000' + Math.round(Math.min(1, Math.max(0, alpha01)) * 255).toString(16).padStart(2, '0');
    const alphaByte = Math.round(Math.min(1, Math.max(0, alpha01)) * 255).toString(16).padStart(2, '0');
    return `#${m[1]}${alphaByte}`;
}

/** Default text-shadow settings a widget's getDefaultSettings() should
 * spread in (`...TEXT_SHADOW_DEFAULTS`). Same angle/distance/blur model
 * as SHADOW_DEFAULTS above, just applied as `text-shadow` (behind glyphs)
 * instead of `box-shadow` (behind the whole actor) - used for legibility
 * of text sitting on top of a background image or a busy accent color.
 * Default of angle 90 / distance 5 / blur 0 = a plain "0px 5px" drop
 * straight down, no soft blur. */
export const TEXT_SHADOW_DEFAULTS = {
    textShadowEnabled: false,
    textShadowColor: '#000000',
    textShadowOpacity: 60, // percent, 0-100
    textShadowAngle: 90,   // degrees: 0 = right, 90 = down, 180 = left, 270 = up
    textShadowDistance: 5, // px
    textShadowBlur: 0,     // px
};

/** Builds a `text-shadow: ...;` CSS declaration (St supports this the
 * same way it supports box-shadow) from a widget's text-shadow settings,
 * or '' when the shadow is off.
 * @param {object} settings - widget settings object; only the
 *   textShadow* fields are read, missing ones fall back to
 *   TEXT_SHADOW_DEFAULTS.
 * @returns {string}
 */
export function textShadowCss(settings) {
    const s = settings ?? {};
    if (!(s.textShadowEnabled ?? TEXT_SHADOW_DEFAULTS.textShadowEnabled))
        return '';

    const opacityPercent = Number.isFinite(s.textShadowOpacity) ? s.textShadowOpacity : TEXT_SHADOW_DEFAULTS.textShadowOpacity;
    const angleDeg = Number.isFinite(s.textShadowAngle) ? s.textShadowAngle : TEXT_SHADOW_DEFAULTS.textShadowAngle;
    const distance = Number.isFinite(s.textShadowDistance) ? s.textShadowDistance : TEXT_SHADOW_DEFAULTS.textShadowDistance;
    const blur = Number.isFinite(s.textShadowBlur) ? Math.max(0, s.textShadowBlur) : TEXT_SHADOW_DEFAULTS.textShadowBlur;

    const {offsetX, offsetY} = angleDistanceToOffset(angleDeg, distance);

    let hex = (s.textShadowColor ?? TEXT_SHADOW_DEFAULTS.textShadowColor).trim().replace(/^#/, '');
    if (hex.length === 3)
        hex = hex.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(hex))
        hex = '000000';
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = Math.min(1, Math.max(0, opacityPercent / 100));

    return `text-shadow: ${offsetX}px ${offsetY}px ${blur}px rgba(${r}, ${g}, ${b}, ${a});`;
}

/** Default border settings a widget's getDefaultSettings() should spread
 * in (`...BORDER_DEFAULTS`). */
export const BORDER_DEFAULTS = {
    borderEnabled: false,
    borderWidth: 1,     // px
    borderColor: '#FFFFFF33',
};

/** Builds a `border: ...;` CSS declaration from a widget's border
 * settings, or '' when the border is off. St supports plain `border`
 * the same way it supports `border-radius`/`box-shadow`.
 *
 * Force-aware - see the module-level Force state note near the top of
 * this file / setForcedTheme().
 * @param {object} settings
 * @returns {string}
 */
export function borderCss(settings) {
    if (_isForced('border')) {
        const forced = _forcedTheme.border;
        if (!forced?.enabled)
            return '';
        const width = Number.isFinite(forced.width) ? Math.max(0, forced.width) : BORDER_DEFAULTS.borderWidth;
        const color = toCssColor(forced.color ?? BORDER_DEFAULTS.borderColor, BORDER_DEFAULTS.borderColor);
        return `border: ${width}px solid ${color};`;
    }

    const s = settings ?? {};
    if (!(s.borderEnabled ?? BORDER_DEFAULTS.borderEnabled))
        return '';

    const width = Number.isFinite(s.borderWidth) ? Math.max(0, s.borderWidth) : BORDER_DEFAULTS.borderWidth;
    const color = toCssColor(s.borderColor ?? BORDER_DEFAULTS.borderColor, BORDER_DEFAULTS.borderColor);
    return `border: ${width}px solid ${color};`;
}

/** Default opacity setting a widget's getDefaultSettings() should spread
 * in (`...OPACITY_DEFAULTS`). Unlike backgroundColor's own alpha channel
 * (which only fades the background fill), this fades the ENTIRE actor -
 * background, text, icons, everything - the same thing dragging a
 * window's opacity slider in a compositor does. */
export const OPACITY_DEFAULTS = {
    opacity: 100, // percent, 0-100
};

/** Converts a widget's `opacity` setting (0-100, the unit every other
 * field in this file uses) to the 0-255 integer St.Widget#opacity
 * actually takes.
 * @param {object} settings
 * @returns {number} 0-255
 */
export function opacityValue(settings) {
    // Force-aware: if opacity.force is on (from theme.json via _forcedTheme),
    // use the forced value, otherwise read from widget's settings.
    if (_isForced('opacity')) {
        const forced = _forcedTheme.opacity;
        const percent = Number.isFinite(forced?.value) ? Math.min(100, Math.max(0, forced.value)) : OPACITY_DEFAULTS.opacity;
        return Math.round((percent / 100) * 255);
    }

    const s = settings ?? {};
    const percent = Number.isFinite(s.opacity) ? Math.min(100, Math.max(0, s.opacity)) : OPACITY_DEFAULTS.opacity;
    return Math.round((percent / 100) * 255);
}

/** Applies a widget's `opacity` setting directly to `actor.opacity`.
 * Thin wrapper around opacityValue() for the common case of "just set it
 * on the root actor" - call opacityValue() directly instead if the
 * opacity needs to go somewhere else (e.g. a child actor).
 * @param {Clutter.Actor} actor
 * @param {object} settings
 */
export function applyCardOpacity(actor, settings) {
    if (actor)
        actor.opacity = opacityValue(settings);
}

/** Default blur settings a widget's getDefaultSettings() should spread
 * in (`...BLUR_DEFAULTS`). */
export const BLUR_DEFAULTS = {
    blurEnabled: false,
    blurRadius: 24, // px
};

/** Builds a `-st-background-blur: ...;` CSS declaration from a widget's
 * blur settings, or '' when blur is off. This is a real St CSS property
 * (not a custom addition here) - see lib/themeService.js's
 * applyWidgetStyle() for the identical property used by the global-theme
 * force system.
 *
 * Force-aware via lib/forceSettingsHelper.js's OWN independent
 * "Background Blur" switch (see setForceSettingsHelper() above) once
 * extension.js has wired a helper in - unlike the OLDER _forcedTheme
 * mechanism this falls back to below, the new 4-switch model gives blur
 * its own switch, fully independent of Background Color/Corner Radius
 * (per HANDOVER_FORCE_SETTINGS.md's addendum, confirmed with the user).
 * Falls back to the OLDER "Force this background on every widget"
 * switch (which bundled blur in with background color/corner-radius)
 * when no helper has been wired in yet.
 * @param {object} settings
 * @returns {string}
 */
export function blurCss(settings) {
    const resolved = _resolveForceSettings(settings);
    if (resolved) {
        const radius = resolved.background.blur;
        return Number.isFinite(radius) && radius > 0 ? `-st-background-blur: ${Math.round(radius)}px;` : '';
    }

    if (_isForced('background')) {
        const radius = _forcedTheme.background?.blur;
        return Number.isFinite(radius) && radius > 0 ? `-st-background-blur: ${Math.round(radius)}px;` : '';
    }

    const s = settings ?? {};
    if (!(s.blurEnabled ?? BLUR_DEFAULTS.blurEnabled))
        return '';
    const radius = Number.isFinite(s.blurRadius) ? Math.max(0, s.blurRadius) : BLUR_DEFAULTS.blurRadius;
    return `-st-background-blur: ${Math.round(radius)}px;`;
}

/** Standard "card style" builder — the single function every widget
 * should call to build its root/content actor's `background-color;
 * border; border-radius; box-shadow;` CSS, instead of hand-concatenating
 * those declarations itself (which is how media-player-square/circle/
 * wide/poster ended up with four near-identical, slowly-drifting local
 * copies of the same lines before 2026-08-03).
 *
 * Deliberately does NOT cover opacity or blur - those aren't expressible
 * as a `set_style()` CSS string (opacity is a plain Clutter.Actor
 * property, blur needs an Actor effect) - use applyCardOpacity()/
 * applyCardBlur() alongside this for those two.
 *
 * Per the Function Helper design (2026-08-04): this covers Background/
 * Border/Corner Radius/Shadow only - the "theme" properties every widget
 * should be consistent about. Font, layout, padding, margin, animation,
 * and any other widget-specific CSS stay the widget's own responsibility,
 * appended to this function's return value same as before.
 * @param {object} settings - the widget's settings object
 * @param {object} [options]
 * @param {string} [options.backgroundColorKey='backgroundColor'] - settings field to read the background color from
 * @param {string} [options.backgroundColorFallback='#000000F5'] - used when the field is missing/invalid
 * @param {string} [options.cornerRadiusKey='cornerRadius'] - settings field to read the corner radius from
 * @param {number} [options.cornerRadiusFallback=18] - used when the field is missing/invalid
 * @param {boolean} [options.includeShadow=true] - append shadowBoxShadowCss(settings) too
 * @param {boolean} [options.includeBorder=true] - append borderCss(settings) too
 * @param {boolean} [options.includeBlur=true] - append blurCss(settings) too
 * @returns {string} ready for `actor.set_style()`
 */
export function cardStyleCss(settings, options = {}) {
    const {
        backgroundColorKey = 'backgroundColor',
        backgroundColorFallback = '#000000F5',
        cornerRadiusKey = 'cornerRadius',
        cornerRadiusFallback = 18,
        includeShadow = true,
        includeBorder = true,
        includeBlur = true,
    } = options;

    // Background Color and Corner Radius each resolve through their OWN
    // independent lib/forceSettingsHelper.js switch (once wired in via
    // setForceSettingsHelper()) - see that helper's resolve(), which
    // already does the "either, both, or neither can be on" per-property
    // resolution internally, so there's just one _resolveForceSettings()
    // call here rather than two separate _isForced() branches.
    //
    // Falls back to the OLDER _forcedTheme background.force/
    // cornerRadius.force switches (still genuinely independent of each
    // other, per lib/themeService.js's getEffectiveWidgetTheme()) when
    // no helper has been wired in yet.
    const resolved = _resolveForceSettings(settings, {backgroundColorKey, cornerRadiusKey});

    let backgroundColor;
    if (resolved) {
        backgroundColor = toCssColor(resolved.background.color, backgroundColorFallback);
    } else if (_isForced('background')) {
        const forced = _forcedTheme.background;
        const alpha = forced.transparent ? 0 : 1;
        backgroundColor = toCssColor(withAlphaHex(forced.color ?? '#1e1e2e', alpha), backgroundColorFallback);
    } else {
        backgroundColor = toCssColor(settings?.[backgroundColorKey], backgroundColorFallback);
    }

    let cornerRadius;
    if (resolved) {
        cornerRadius = Number.isFinite(resolved.background.cornerRadius) ? Math.max(0, resolved.background.cornerRadius) : cornerRadiusFallback;
    } else if (_isForced('cornerRadius')) {
        const forcedRadius = _forcedTheme.cornerRadius?.value;
        cornerRadius = Number.isFinite(forcedRadius) ? Math.max(0, forcedRadius) : cornerRadiusFallback;
    } else {
        const cornerRadiusRaw = settings?.[cornerRadiusKey];
        cornerRadius = Number.isFinite(cornerRadiusRaw) ? cornerRadiusRaw : cornerRadiusFallback;
    }

    let css = `background-color: ${backgroundColor}; border-radius: ${cornerRadius}px;`;
    if (includeBorder)
        css += borderCss(settings);
    if (includeBlur)
        css += blurCss(settings);
    if (includeShadow)
        css += shadowBoxShadowCss(settings);
    return css;
}

/** "#rrggbb" or "#rrggbbaa" -> {r,g,b,a} each 0..1, for Cairo drawing
 * (cr.setSourceRGBA() etc). Invalid input falls back to opaque white.
 * @param {string} hex
 * @returns {{r: number, g: number, b: number, a: number}}
 */
export function hexToRgba(hex) {
    const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(hex ?? '');
    if (!m)
        return {r: 1, g: 1, b: 1, a: 1};
    const h = m[1];
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return {r, g, b, a};
}

/** 8-digit "#rrggbbaa" -> "rgba(r, g, b, a)" for St CSS, which doesn't
 * understand 8-digit hex on its own. Anything else (6-digit hex, an
 * already-CSS color string, etc.) passes through unchanged. Same fix as
 * lib/themeService.js's hexToRgba().
 * @param {string} hex
 * @param {string} fallback - used when `hex` isn't a string at all.
 * @returns {string}
 */
export function toCssColor(hex, fallback) {
    const value = typeof hex === 'string' ? hex : fallback;
    const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/.exec(value);
    if (!m)
        return value;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    const a = Math.round((parseInt(m[2], 16) / 255) * 1000) / 1000;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Splits a combined Pango font-description string (e.g. "Sans Bold 22")
 * into the family/size pieces St's set_style() needs separately (St
 * doesn't accept a single combined `font:` shorthand the way Pango
 * strings do).
 * @param {string} fontStr
 * @param {string} fallbackFamily
 * @param {number} fallbackSize
 * @returns {{family: string, size: number}}
 */
export function parseFontDescription(fontStr, fallbackFamily, fallbackSize) {
    try {
        const desc = Pango.FontDescription.from_string(fontStr);
        const rawSize = desc.get_size();
        const size = rawSize > 0 ? Math.round(rawSize / Pango.SCALE) : fallbackSize;

        // Drop just the point-size field and re-serialize - whatever's
        // left (family + weight/style words Pango recognized) is exactly
        // what St's font-family/font-size/font-weight CSS props need.
        desc.unset_fields(Pango.FontMask.SIZE);
        const family = desc.to_string().trim();

        return {family: family || fallbackFamily, size};
    } catch (e) {
        return {family: fallbackFamily, size: fallbackSize};
    }
}
