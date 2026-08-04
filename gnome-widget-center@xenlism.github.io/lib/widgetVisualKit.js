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

/** Default shadow settings a widget's getDefaultSettings() should spread
 * in (`...SHADOW_DEFAULTS`) so the shadow fields exist with sane values
 * even before the user opens the widget's settings panel. */
export const SHADOW_DEFAULTS = {
    shadowEnabled: false,
    shadowColor: '#000000',
    shadowOpacity: 30, // percent, 0-100
    shadowAngle: 90,   // degrees: 0 = right, 90 = down, 180 = left, 270 = up
    shadowDistance: 6, // px
    shadowBlur: 16,    // px
};

/** Builds a `box-shadow: ...;` CSS declaration (St supports the standard
 * CSS box-shadow syntax) from a widget's shadow settings, or '' when the
 * shadow is off - always safe to splice directly into a set_style()
 * template literal.
 * @param {object} settings - widget settings object; only the
 *   shadow* fields are read, missing ones fall back to SHADOW_DEFAULTS.
 * @returns {string}
 */
export function shadowBoxShadowCss(settings) {
    const s = settings ?? {};
    if (!(s.shadowEnabled ?? SHADOW_DEFAULTS.shadowEnabled))
        return '';

    const opacityPercent = Number.isFinite(s.shadowOpacity) ? s.shadowOpacity : SHADOW_DEFAULTS.shadowOpacity;
    const angleDeg = Number.isFinite(s.shadowAngle) ? s.shadowAngle : SHADOW_DEFAULTS.shadowAngle;
    const distance = Number.isFinite(s.shadowDistance) ? s.shadowDistance : SHADOW_DEFAULTS.shadowDistance;
    const blur = Number.isFinite(s.shadowBlur) ? Math.max(0, s.shadowBlur) : SHADOW_DEFAULTS.shadowBlur;

    const rad = (angleDeg * Math.PI) / 180;
    const offsetX = Math.round(Math.cos(rad) * distance * 100) / 100;
    const offsetY = Math.round(Math.sin(rad) * distance * 100) / 100;

    let hex = (s.shadowColor ?? SHADOW_DEFAULTS.shadowColor).trim().replace(/^#/, '');
    if (hex.length === 3)
        hex = hex.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(hex))
        hex = '000000';
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = Math.min(1, Math.max(0, opacityPercent / 100));

    return `box-shadow: ${offsetX}px ${offsetY}px ${blur}px 0px rgba(${r}, ${g}, ${b}, ${a});`;
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

    const rad = (angleDeg * Math.PI) / 180;
    const offsetX = Math.round(Math.cos(rad) * distance * 100) / 100;
    const offsetY = Math.round(Math.sin(rad) * distance * 100) / 100;

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

/** Standard "card style" builder — the single function every widget
 * should call to build its root/content actor's `background-color;
 * border-radius; box-shadow;` CSS, instead of hand-concatenating those
 * three declarations itself (which is how media-player-square/circle/
 * wide/poster ended up with four near-identical, slowly-drifting local
 * copies of the same three lines before 2026-08-03).
 * @param {object} settings - the widget's settings object
 * @param {object} [options]
 * @param {string} [options.backgroundColorKey='backgroundColor'] - settings field to read the background color from
 * @param {string} [options.backgroundColorFallback='#000000F5'] - used when the field is missing/invalid
 * @param {string} [options.cornerRadiusKey='cornerRadius'] - settings field to read the corner radius from
 * @param {number} [options.cornerRadiusFallback=18] - used when the field is missing/invalid
 * @param {boolean} [options.includeShadow=true] - append shadowBoxShadowCss(settings) too
 * @returns {string} ready for `actor.set_style()`
 */
export function cardStyleCss(settings, options = {}) {
    const {
        backgroundColorKey = 'backgroundColor',
        backgroundColorFallback = '#000000F5',
        cornerRadiusKey = 'cornerRadius',
        cornerRadiusFallback = 18,
        includeShadow = true,
    } = options;

    const backgroundColor = toCssColor(settings?.[backgroundColorKey], backgroundColorFallback);
    const cornerRadiusRaw = settings?.[cornerRadiusKey];
    const cornerRadius = Number.isFinite(cornerRadiusRaw) ? cornerRadiusRaw : cornerRadiusFallback;

    let css = `background-color: ${backgroundColor}; border-radius: ${cornerRadius}px;`;
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
