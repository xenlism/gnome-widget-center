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
    "card-shadow-enabled": false,
    "card-shadow-color": "#000000",
    "card-shadow-opacity": 30,
    "card-shadow-angle": 90,
    "card-shadow-distance": 6,
    "card-shadow-blur": 16
};

export function boxShadowCss({color: color, opacityPercent: opacityPercent, angleDeg: angleDeg, distance: distance, blur: blur, spread: spread}) {
    const {offsetX: offsetX, offsetY: offsetY} = angleDistanceToOffset(angleDeg, distance);
    let hex = (color ?? SHADOW_DEFAULTS["card-shadow-color"]).trim().replace(/^#/, "");
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
        enabled: s["card-blur-enabled"] ?? BLUR_DEFAULTS["card-blur-enabled"],
        radius: Number.isFinite(s["card-blur-radius"]) ? Math.max(0, s["card-blur-radius"]) : BLUR_DEFAULTS["card-blur-radius"]
    };
}

export function shadowBoxShadowCss(settings) {
    const s = settings ?? {};
    if (!(s["card-shadow-enabled"] ?? SHADOW_DEFAULTS["card-shadow-enabled"])) return "";
    const globalDistanceAngle = _globalShadowHelper?.getGlobalShadowDistanceAngle?.();
    return boxShadowCss({
        color: s["card-shadow-color"] ?? SHADOW_DEFAULTS["card-shadow-color"],
        opacityPercent: Number.isFinite(s["card-shadow-opacity"]) ? s["card-shadow-opacity"] : SHADOW_DEFAULTS["card-shadow-opacity"],
        angleDeg: globalDistanceAngle?.angle ?? (Number.isFinite(s["card-shadow-angle"]) ? s["card-shadow-angle"] : SHADOW_DEFAULTS["card-shadow-angle"]),
        distance: globalDistanceAngle?.distance ?? (Number.isFinite(s["card-shadow-distance"]) ? s["card-shadow-distance"] : SHADOW_DEFAULTS["card-shadow-distance"]),
        blur: Number.isFinite(s["card-shadow-blur"]) ? s["card-shadow-blur"] : SHADOW_DEFAULTS["card-shadow-blur"],
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
    "card-border-enabled": false,
    "card-border-width": 1,
    "card-border-color": "#FFFFFF33"
};

export function borderCss(settings, backgroundColorCss = null) {
    const s = settings ?? {};
    if (!(s["card-border-enabled"] ?? BORDER_DEFAULTS["card-border-enabled"])) return "";
    const width = Number.isFinite(s["card-border-width"]) ? Math.max(0, s["card-border-width"]) : BORDER_DEFAULTS["card-border-width"];
    const rawColor = s["card-border-color"] ?? backgroundColorCss ?? BORDER_DEFAULTS["card-border-color"];
    const color = toCssColor(rawColor, rawColor);
    return `border: ${width}px solid ${color};`;
}

export const OPACITY_DEFAULTS = {
    "card-opacity": 100
};

export function opacityValue(settings) {
    const s = settings ?? {};
    const percent = Number.isFinite(s["card-opacity"]) ? Math.min(100, Math.max(0, s["card-opacity"])) : OPACITY_DEFAULTS["card-opacity"];
    return Math.round(percent / 100 * 255);
}

export function applyCardOpacity(actor, settings) {
    if (actor) actor.opacity = opacityValue(settings);
}

export const BLUR_DEFAULTS = {
    "card-blur-enabled": false,
    "card-blur-radius": 24
};

export function blurCss() {
    return "";
}

export function resolveCornerRadius(settings, cornerRadiusFallback = 18, cornerRadiusKey = "card-corner-radius") {
    const s = settings ?? {};
    if (!(s["card-corner-radius-enabled"] ?? true)) return 0;
    const raw = s[cornerRadiusKey];
    return Number.isFinite(raw) ? raw : cornerRadiusFallback;
}

export function cardStyleCss(settings, options = {}) {
    const { backgroundColorKey: backgroundColorKey = "card-background-color", backgroundColorFallback: backgroundColorFallback = "#000000F5", cornerRadiusKey: cornerRadiusKey = "card-corner-radius", cornerRadiusFallback: cornerRadiusFallback = 18, includeShadow: includeShadow = true, includeBorder: includeBorder = true, includeBlur: includeBlur = true} = options;
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
