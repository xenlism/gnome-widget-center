// products/extension/lib/colorUtils.js
//
// Tiny shared helper used by prefsPageBuilders.js and
// prefsWidgetManagement.js (both split out of prefsWindowControllerBase.js,
// 2026-08-01 cleanup pass) for the color-picker fields in the Appearance
// category and per-widget appearance overrides.

/**
 * Gdk.RGBA -> `#rrggbb` (alpha deliberately dropped — theme.json's
 * "transparent" boolean fields control alpha independently, see
 * themeService.js's hexToRgba(); a stored `rgba(...)` string would bypass
 * that override entirely since hexToRgba() only recognizes hex input).
 * @param {Gdk.RGBA} rgba
 * @returns {string}
 */
export function rgbaToHex(rgba) {
    const toHex = c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0');
    return `#${toHex(rgba.red)}${toHex(rgba.green)}${toHex(rgba.blue)}`;
}
