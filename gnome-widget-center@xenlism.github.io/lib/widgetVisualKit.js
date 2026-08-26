import Pango from "gi://Pango";

export const SHADOW_ANGLE_STEPS = [ 45, 90, 135, 180, 225, 270, 315 ];

export function angleDistanceToOffset(angleDeg, distance) {
    const rad = angleDeg * Math.PI / 180;
    return {
        offsetX: Math.round(Math.cos(rad) * distance * 100) / 100,
        offsetY: Math.round(Math.sin(rad) * distance * 100) / 100
    };
}

let _globalShadowHelper = null;

export function setGlobalShadowHelper(helper) {
    _globalShadowHelper = helper ?? null;
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

export function getBlurSettings(settings) {
    const s = settings ?? {};
    return {
        enabled: s.blurEnabled ?? BLUR_DEFAULTS.blurEnabled,
        radius: Number.isFinite(s.blurRadius) ? Math.max(0, s.blurRadius) : BLUR_DEFAULTS.blurRadius
    };
}

export function shadowBoxShadowCss(settings) {
    const s = settings ?? {};
    if (!(s.shadowEnabled ?? SHADOW_DEFAULTS.shadowEnabled)) return "";
    const globalDistanceAngle = _globalShadowHelper?.getGlobalShadowDistanceAngle?.();
    return boxShadowCss({
        color: s.shadowColor ?? SHADOW_DEFAULTS.shadowColor,
        opacityPercent: Number.isFinite(s.shadowOpacity) ? s.shadowOpacity : SHADOW_DEFAULTS.shadowOpacity,
        angleDeg: globalDistanceAngle?.angle ?? (Number.isFinite(s.shadowAngle) ? s.shadowAngle : SHADOW_DEFAULTS.shadowAngle),
        distance: globalDistanceAngle?.distance ?? (Number.isFinite(s.shadowDistance) ? s.shadowDistance : SHADOW_DEFAULTS.shadowDistance),
        blur: Number.isFinite(s.shadowBlur) ? s.shadowBlur : SHADOW_DEFAULTS.shadowBlur,
        spread: 0
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
    const globalAngle = _globalShadowHelper?.getGlobalShadowDistanceAngle?.();
    const angleDeg = globalAngle?.angle ?? (Number.isFinite(s.textShadowAngle) ? s.textShadowAngle : TEXT_SHADOW_DEFAULTS.textShadowAngle);
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

export function borderCss(settings, backgroundColorCss = null) {
    const s = settings ?? {};
    if (!(s.borderEnabled ?? BORDER_DEFAULTS.borderEnabled)) return "";
    const width = Number.isFinite(s.borderWidth) ? Math.max(0, s.borderWidth) : BORDER_DEFAULTS.borderWidth;
    const rawColor = s.borderColor ?? backgroundColorCss ?? BORDER_DEFAULTS.borderColor;
    const color = toCssColor(rawColor, rawColor);
    return `border: ${width}px solid ${color};`;
}

export const OPACITY_DEFAULTS = {
    opacity: 100
};

export function opacityValue(settings) {
    const s = settings ?? {};
    const percent = Number.isFinite(s.opacity) ? Math.min(100, Math.max(0, s.opacity)) : OPACITY_DEFAULTS.opacity;
    return Math.round(percent / 100 * 255);
}

export function applyCardOpacity(actor, settings) {
    if (actor) actor.opacity = opacityValue(settings);
}

export const BLUR_DEFAULTS = {
    blurEnabled: false,
    blurRadius: 24
};

export function blurCss() {
    return "";
}

export function resolveCornerRadius(settings, cornerRadiusFallback = 18, cornerRadiusKey = "cornerRadius") {
    const s = settings ?? {};
    if (!(s.cornerRadiusEnabled ?? true)) return 0;
    const raw = s[cornerRadiusKey];
    return Number.isFinite(raw) ? raw : cornerRadiusFallback;
}

export function cardStyleCss(settings, options = {}) {
    const { backgroundColorKey: backgroundColorKey = "backgroundColor", backgroundColorFallback: backgroundColorFallback = "#000000F5", cornerRadiusKey: cornerRadiusKey = "cornerRadius", cornerRadiusFallback: cornerRadiusFallback = 18, includeShadow: includeShadow = true, includeBorder: includeBorder = true, includeBlur: includeBlur = true} = options;
    const backgroundColor = toCssColor(settings?.[backgroundColorKey], backgroundColorFallback);
    const cornerRadius = resolveCornerRadius(settings, cornerRadiusFallback, cornerRadiusKey);
    let css = `background-color: ${backgroundColor}; border-radius: ${cornerRadius}px;`;
    if (includeBorder) css += borderCss(settings, backgroundColor);
    if (includeShadow) css += shadowBoxShadowCss(settings);
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
