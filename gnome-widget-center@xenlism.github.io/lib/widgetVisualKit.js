import Pango from "gi://Pango";

export const SHADOW_ANGLE_STEPS = [ 45, 90, 135, 180, 225, 270, 315 ];

export function angleDistanceToOffset(angleDeg, distance) {
    const rad = angleDeg * Math.PI / 180;
    return {
        offsetX: Math.round(Math.cos(rad) * distance * 100) / 100,
        offsetY: Math.round(Math.sin(rad) * distance * 100) / 100
    };
}

// Registered by extension.js at enable() with a GlobalShadowHelper
// instance (see lib/globalShadowHelper.js). shadow-distance/shadow-angle
// are the one appearance value every widget's drop shadow always shares
// - everything else (color/opacity/blur/spread) is purely per-widget,
// read straight from that widget's own settings below. There is no more
// "Force Settings" system pinning background/corner-radius/blur/shadow
// to a global value - each widget always owns its own card styling.
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
    // shadow-distance/shadow-angle are always-global (see
    // lib/globalShadowHelper.js) - every other shadow property still
    // comes from the widget's own settings.
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
    // Angle is never a real per-widget choice for text shadows either -
    // same "one global light source direction" rule as card shadows
    // (see shadowBoxShadowCss() above / GlobalShadowHelper.
    // getGlobalShadowDistanceAngle()). Distance/blur/color/opacity stay
    // fully per-widget; only angle always comes from the shared global
    // value when one is registered.
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
    // Absolute last-resort fallback only - used when borderCss() has
    // neither a settings.borderColor NOR a background color to fall
    // back to (see borderCss() below). Every normal call path goes
    // through cardStyleCss(), which always has a background color to
    // pass in, so this rarely fires in practice.
    borderColor: "#FFFFFF33"
};

// Border color priority (see extension.js's Layer Lab "card A" /
// resolveBorderColor() - same policy, transplanted here):
//   1. settings.borderColor - the widget's own config.json default AND
//      any later user override both live here, in that order of
//      precedence, because WidgetSettings.applyDefaults() (see
//      lib/widgetSettings.js) bakes a widget's config.json default for
//      this field straight into settings the very first time it loads
//      - a user pick simply overwrites that same key afterward. So by
//      the time borderCss() runs, settings.borderColor already IS
//      "user setting, or failing that, this widget's config.json
//      default" - there's no separate tier to check for that.
//   2. backgroundColorCss - the card's own resolved background color,
//      passed in by cardStyleCss() below. Only reached if settings
//      truly has no borderColor key at all (e.g. a bare/partial
//      settings object that never went through the defaults merge).
//   3. BORDER_DEFAULTS.borderColor, only if neither of the above exist.
//
// Falling through to the background when tier 1 is genuinely empty
// means an enabled border reads as a soft rim on the glass instead of
// an outline in an unrelated color that draws the eye to the live-blur
// layer's square corners (see cardLayers.js's applyLayeredCardStyle()).
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

// NOTE: this used to also emit a `-st-background-blur` CSS declaration
// here for cardStyleCss() to include. Dropped it - St's CSS parser
// doesn't actually recognize that property (confirmed: it wasn't doing
// anything, just quietly parsed-and-ignored - which is also liable to
// spam "unknown property" warnings into the Shell's log on every
// style update, i.e. every _render() call, for widgets like clocks that
// re-render every second). Real background blur for this extension's
// widgets goes entirely through the actual Shell.BlurEffect Clutter
// effect now - see lib/cardLayers.js's applyCardBlur().
export function blurCss() {
    return "";
}

export function cardStyleCss(settings, options = {}) {
    const { backgroundColorKey: backgroundColorKey = "backgroundColor", backgroundColorFallback: backgroundColorFallback = "#000000F5", cornerRadiusKey: cornerRadiusKey = "cornerRadius", cornerRadiusFallback: cornerRadiusFallback = 18, includeShadow: includeShadow = true, includeBorder: includeBorder = true, includeBlur: includeBlur = true} = options;
    const backgroundColor = toCssColor(settings?.[backgroundColorKey], backgroundColorFallback);
    const cornerRadiusRaw = settings?.[cornerRadiusKey];
    const cornerRadius = Number.isFinite(cornerRadiusRaw) ? cornerRadiusRaw : cornerRadiusFallback;
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
