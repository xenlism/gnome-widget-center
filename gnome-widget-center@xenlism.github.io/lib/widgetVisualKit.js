import Pango from "gi://Pango";

let _forcedTheme = null;

export function setForcedTheme(theme) {
    _forcedTheme = theme ?? null;
}

function _isForced(category) {
    return !!_forcedTheme?.[category]?.force;
}

let _forceSettingsHelper = null;

export function setForceSettingsHelper(helper) {
    _forceSettingsHelper = helper ?? null;
}

function _resolveForceSettings(settings, {backgroundColorKey: backgroundColorKey = "backgroundColor", cornerRadiusKey: cornerRadiusKey = "cornerRadius"} = {}) {
    if (!_forceSettingsHelper) return null;
    const effIgnore = settings?.__ignoreForce === true;
    if (effIgnore) return null;
    
    const s = settings ?? {};
    return _forceSettingsHelper.resolve({
        background: {
            color: s[backgroundColorKey],
            cornerRadius: s[cornerRadiusKey],
            blur: s.blurEnabled ?? BLUR_DEFAULTS.blurEnabled ? s.blurRadius : 0
        },
        shadow: {
            enabled: s.shadowEnabled,
            color: s.shadowColor,
            opacity: s.shadowOpacity,
            spread: 0,
            blur: s.shadowBlur
        }
    });
}

export const SHADOW_ANGLE_STEPS = [ 45, 90, 135, 180, 225, 270, 315 ];

export function angleDistanceToOffset(angleDeg, distance) {
    const rad = angleDeg * Math.PI / 180;
    return {
        offsetX: Math.round(Math.cos(rad) * distance * 100) / 100,
        offsetY: Math.round(Math.sin(rad) * distance * 100) / 100
    };
}

export const SHADOW_DEFAULTS = {
    shadowEnabled: false,
    shadowColor: "#000000",
    shadowOpacity: 30,
    shadowAngle: 90,
    shadowDistance: 6,
    shadowBlur: 16
};

export function boxShadowCss({color: color, opacityPercent: opacityPercent, angleDeg: angleDeg, distance: distance, blur: blur, spread: spread}) {
    const {offsetX: offsetX, offsetY: offsetY} = angleDistanceToOffset(angleDeg, distance);
    let hex = (color ?? SHADOW_DEFAULTS.shadowColor).trim().replace(/^#/, "");
    if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) hex = "000000";
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = Math.min(1, Math.max(0, opacityPercent / 100));
    return `box-shadow: ${offsetX}px ${offsetY}px ${Math.max(0, blur)}px ${spread}px rgba(${r}, ${g}, ${b}, ${a});`;
}

export function getForceAwareBlurSettings(settings, ignoreForce = false) {
    const effIgnore = ignoreForce || settings?.__ignoreForce === true;
    const resolved = effIgnore ? null : _resolveForceSettings(settings);
    if (resolved) {
        const radius = resolved.background.blur;
        return {
            enabled: Number.isFinite(radius) && radius > 0,
            radius: Math.max(0, radius ?? BLUR_DEFAULTS.blurRadius)
        };
    }
    if (!effIgnore && _isForced("background")) {
        const radius = _forcedTheme.background?.blur;
        return {
            enabled: Number.isFinite(radius) && radius > 0,
            radius: Math.max(0, radius ?? BLUR_DEFAULTS.blurRadius)
        };
    }
    const s = settings ?? {};
    return {
        enabled: s.blurEnabled ?? BLUR_DEFAULTS.blurEnabled,
        radius: Number.isFinite(s.blurRadius) ? Math.max(0, s.blurRadius) : BLUR_DEFAULTS.blurRadius
    };
}

export function shadowBoxShadowCss(settings, ignoreForce = false) {
    const effIgnore = ignoreForce || settings?.__ignoreForce === true;
    const resolved = effIgnore ? null : _resolveForceSettings(settings);
    if (resolved) {
        const {shadow: shadow} = resolved;
        if (!shadow.enabled) return "";
        return boxShadowCss({
            color: shadow.color,
            opacityPercent: shadow.opacity,
            angleDeg: shadow.angle,
            distance: shadow.distance,
            blur: shadow.blur,
            spread: shadow.spread
        });
    }
    if (!effIgnore && _isForced("dropShadow")) return _forcedShadowBoxShadowCss(_forcedTheme.dropShadow);
    const s = settings ?? {};
    if (!(s.shadowEnabled ?? SHADOW_DEFAULTS.shadowEnabled)) return "";
    return boxShadowCss({
        color: s.shadowColor ?? SHADOW_DEFAULTS.shadowColor,
        opacityPercent: Number.isFinite(s.shadowOpacity) ? s.shadowOpacity : SHADOW_DEFAULTS.shadowOpacity,
        angleDeg: Number.isFinite(s.shadowAngle) ? s.shadowAngle : SHADOW_DEFAULTS.shadowAngle,
        distance: Number.isFinite(s.shadowDistance) ? s.shadowDistance : SHADOW_DEFAULTS.shadowDistance,
        blur: Number.isFinite(s.shadowBlur) ? s.shadowBlur : SHADOW_DEFAULTS.shadowBlur,
        spread: 0
    });
}

function _forcedShadowBoxShadowCss(dropShadow) {
    if (!dropShadow?.enabled || dropShadow?.transparent) return "";
    const opacity = Number.isFinite(dropShadow.opacity) ? Math.min(1, Math.max(0, dropShadow.opacity)) : .45;
    return boxShadowCss({
        color: dropShadow.color ?? "#000000",
        opacityPercent: opacity * 100,
        angleDeg: Number.isFinite(dropShadow.angle) ? dropShadow.angle : 90,
        distance: Number.isFinite(dropShadow.distance) ? dropShadow.distance : 4,
        blur: Number.isFinite(dropShadow.blurRadius) ? dropShadow.blurRadius : 12,
        spread: Number.isFinite(dropShadow.spread) ? dropShadow.spread : 0
    });
}

export function withAlphaHex(hex6, alpha01) {
    const m = /^#([0-9a-fA-F]{6})$/.exec((hex6 ?? "").trim());
    if (!m) return "#000000" + Math.round(Math.min(1, Math.max(0, alpha01)) * 255).toString(16).padStart(2, "0");
    const alphaByte = Math.round(Math.min(1, Math.max(0, alpha01)) * 255).toString(16).padStart(2, "0");
    return `#${m[1]}${alphaByte}`;
}

export const TEXT_SHADOW_DEFAULTS = {
    textShadowEnabled: false,
    textShadowColor: "#000000",
    textShadowOpacity: 60,
    textShadowAngle: 90,
    textShadowDistance: 5,
    textShadowBlur: 0
};

export function textShadowCss(settings) {
    const s = settings ?? {};
    if (!(s.textShadowEnabled ?? TEXT_SHADOW_DEFAULTS.textShadowEnabled)) return "";
    const opacityPercent = Number.isFinite(s.textShadowOpacity) ? s.textShadowOpacity : TEXT_SHADOW_DEFAULTS.textShadowOpacity;
    const angleDeg = Number.isFinite(s.textShadowAngle) ? s.textShadowAngle : TEXT_SHADOW_DEFAULTS.textShadowAngle;
    const distance = Number.isFinite(s.textShadowDistance) ? s.textShadowDistance : TEXT_SHADOW_DEFAULTS.textShadowDistance;
    const blur = Number.isFinite(s.textShadowBlur) ? Math.max(0, s.textShadowBlur) : TEXT_SHADOW_DEFAULTS.textShadowBlur;
    const {offsetX: offsetX, offsetY: offsetY} = angleDistanceToOffset(angleDeg, distance);
    let hex = (s.textShadowColor ?? TEXT_SHADOW_DEFAULTS.textShadowColor).trim().replace(/^#/, "");
    if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) hex = "000000";
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = Math.min(1, Math.max(0, opacityPercent / 100));
    return `text-shadow: ${offsetX}px ${offsetY}px ${blur}px rgba(${r}, ${g}, ${b}, ${a});`;
}

export const BORDER_DEFAULTS = {
    borderEnabled: false,
    borderWidth: 1,
    borderColor: "#FFFFFF33"
};

export function borderCss(settings, ignoreForce = false) {
    const effIgnore = ignoreForce || settings?.__ignoreForce === true;
    if (!effIgnore && _isForced("border")) {
        const forced = _forcedTheme.border;
        if (!forced?.enabled) return "";
        const width = Number.isFinite(forced.width) ? Math.max(0, forced.width) : BORDER_DEFAULTS.borderWidth;
        const color = toCssColor(forced.color ?? BORDER_DEFAULTS.borderColor, BORDER_DEFAULTS.borderColor);
        return `border: ${width}px solid ${color};`;
    }
    const s = settings ?? {};
    const widgetEnabled = s.borderEnabled ?? BORDER_DEFAULTS.borderEnabled;
    // Not forced: the widget's own border setting can still override, but
    // when the widget hasn't turned its own border on, fall back to the
    // plain global "Enabled" toggle as the default — same base-default
    // behavior ThemeService.getEffectiveWidgetTheme() already gives every
    // themeable widget that goes through applyWidgetStyle().
    const globalBorder = !effIgnore ? _forcedTheme?.border : null;
    const enabled = widgetEnabled || !!globalBorder?.enabled;
    if (!enabled) return "";
    const width = widgetEnabled ? (Number.isFinite(s.borderWidth) ? Math.max(0, s.borderWidth) : BORDER_DEFAULTS.borderWidth) : Number.isFinite(globalBorder?.width) ? Math.max(0, globalBorder.width) : BORDER_DEFAULTS.borderWidth;
    const color = widgetEnabled ? toCssColor(s.borderColor ?? BORDER_DEFAULTS.borderColor, BORDER_DEFAULTS.borderColor) : toCssColor(globalBorder?.color ?? BORDER_DEFAULTS.borderColor, BORDER_DEFAULTS.borderColor);
    return `border: ${width}px solid ${color};`;
}

export const OPACITY_DEFAULTS = {
    opacity: 100
};

export function opacityValue(settings, ignoreForce = false) {
    const effIgnore = ignoreForce || settings?.__ignoreForce === true;
    if (!effIgnore && _isForced("opacity")) {
        const forced = _forcedTheme.opacity;
        const percent = Number.isFinite(forced?.value) ? Math.min(100, Math.max(0, forced.value)) : OPACITY_DEFAULTS.opacity;
        return Math.round(percent / 100 * 255);
    }
    const s = settings ?? {};
    const percent = Number.isFinite(s.opacity) ? Math.min(100, Math.max(0, s.opacity)) : OPACITY_DEFAULTS.opacity;
    return Math.round(percent / 100 * 255);
}

export function applyCardOpacity(actor, settings, ignoreForce = false) {
    if (actor) actor.opacity = opacityValue(settings, ignoreForce);
}

export const BLUR_DEFAULTS = {
    blurEnabled: false,
    blurRadius: 24
};

export function blurCss(settings, ignoreForce = false) {
    const effIgnore = ignoreForce || settings?.__ignoreForce === true;
    const resolved = effIgnore ? null : _resolveForceSettings(settings);
    if (resolved) {
        const radius = resolved.background.blur;
        return Number.isFinite(radius) && radius > 0 ? `-st-background-blur: ${Math.round(radius)}px;` : "";
    }
    if (!effIgnore && _isForced("background")) {
        const radius = _forcedTheme.background?.blur;
        return Number.isFinite(radius) && radius > 0 ? `-st-background-blur: ${Math.round(radius)}px;` : "";
    }
    const s = settings ?? {};
    if (!(s.blurEnabled ?? BLUR_DEFAULTS.blurEnabled)) return "";
    const radius = Number.isFinite(s.blurRadius) ? Math.max(0, s.blurRadius) : BLUR_DEFAULTS.blurRadius;
    return `-st-background-blur: ${Math.round(radius)}px;`;
}

export function cardStyleCss(settings, options = {}) {
    const { ignoreForce = false, backgroundColorKey: backgroundColorKey = "backgroundColor", backgroundColorFallback: backgroundColorFallback = "#000000F5", cornerRadiusKey: cornerRadiusKey = "cornerRadius", cornerRadiusFallback: cornerRadiusFallback = 18, includeShadow: includeShadow = true, includeBorder: includeBorder = true, includeBlur: includeBlur = true} = options;
    const effIgnore = ignoreForce || settings?.__ignoreForce === true;
    const resolved = effIgnore ? null : _resolveForceSettings(settings, {
        backgroundColorKey: backgroundColorKey,
        cornerRadiusKey: cornerRadiusKey
    });
    let backgroundColor;
    if (resolved) {
        backgroundColor = toCssColor(resolved.background.color, backgroundColorFallback);
    } else if (!effIgnore && _isForced("background")) {
        const forced = _forcedTheme.background;
        const alpha = forced.transparent ? 0 : 1;
        backgroundColor = toCssColor(withAlphaHex(forced.color ?? "#1e1e2e", alpha), backgroundColorFallback);
    } else {
        backgroundColor = toCssColor(settings?.[backgroundColorKey], backgroundColorFallback);
    }
    let cornerRadius;
    if (resolved) {
        cornerRadius = Number.isFinite(resolved.background.cornerRadius) ? Math.max(0, resolved.background.cornerRadius) : cornerRadiusFallback;
    } else if (!effIgnore && _isForced("cornerRadius")) {
        const forcedRadius = _forcedTheme.cornerRadius?.value;
        cornerRadius = Number.isFinite(forcedRadius) ? Math.max(0, forcedRadius) : cornerRadiusFallback;
    } else {
        const cornerRadiusRaw = settings?.[cornerRadiusKey];
        cornerRadius = Number.isFinite(cornerRadiusRaw) ? cornerRadiusRaw : cornerRadiusFallback;
    }
    let css = `background-color: ${backgroundColor}; border-radius: ${cornerRadius}px;`;
    if (includeBorder) css += borderCss(settings, effIgnore);
    if (includeBlur) css += blurCss(settings, effIgnore);
    if (includeShadow) css += shadowBoxShadowCss(settings, effIgnore);
    return css;
}

export function hexToRgba(hex) {
    const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(hex ?? "");
    if (!m) return {
        r: 1,
        g: 1,
        b: 1,
        a: 1
    };
    const h = m[1];
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return {
        r: r,
        g: g,
        b: b,
        a: a
    };
}

export function toCssColor(hex, fallback) {
    const value = typeof hex === "string" ? hex : fallback;
    const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/.exec(value);
    if (!m) return value;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    const a = Math.round(parseInt(m[2], 16) / 255 * 1e3) / 1e3;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function parseFontDescription(fontStr, fallbackFamily, fallbackSize) {
    try {
        const desc = Pango.FontDescription.from_string(fontStr);
        const rawSize = desc.get_size();
        const size = rawSize > 0 ? Math.round(rawSize / Pango.SCALE) : fallbackSize;
        desc.unset_fields(Pango.FontMask.SIZE);
        const family = desc.to_string().trim();
        return {
            family: family || fallbackFamily,
            size: size
        };
    } catch (e) {
        return {
            family: fallbackFamily,
            size: fallbackSize
        };
    }
}

export function deferUntilMapped(actor, applyFn) {
    if (!actor || actor.mapped) {
        applyFn();
        return;
    }
    const id = actor.connect('notify::mapped', () => {
        if (actor.mapped) {
            actor.disconnect(id);
            applyFn();
        }
    });
}