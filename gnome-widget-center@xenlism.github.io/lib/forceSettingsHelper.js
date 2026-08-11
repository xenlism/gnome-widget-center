import { SHADOW_ANGLE_STEPS } from "./widgetVisualKit.js";

export { SHADOW_ANGLE_STEPS };

const DEFAULT_BACKGROUND = Object.freeze({
    color: "#1e1e2eff",
    cornerRadius: 12,
    blur: 0
});

const DEFAULT_SHADOW = Object.freeze({
    enabled: true,
    color: "#000000ff",
    opacity: 45,
    spread: 0,
    blur: 12
});

const DEFAULT_DISTANCE = 4;

const DEFAULT_ANGLE = 90;

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function coerceAngle(value) {
    const n = Math.round(Number(value));
    return SHADOW_ANGLE_STEPS.includes(n) ? n : DEFAULT_ANGLE;
}

export class ForceSettingsHelper {
    constructor(settings) {
        this._settings = settings;
    }
    isBackgroundColorForced() {
        return this._settings.get_boolean("force-background-color-enabled");
    }
    isCornerRadiusForced() {
        return this._settings.get_boolean("force-corner-radius-enabled");
    }
    isBackgroundBlurForced() {
        return this._settings.get_boolean("force-background-blur-enabled");
    }
    isShadowForced() {
        return this._settings.get_boolean("force-shadow-appearance-enabled");
    }
    _globalShadowDistanceAngle() {
        return {
            distance: clampInt(this._settings.get_int("shadow-distance"), 0, 30, DEFAULT_DISTANCE),
            angle: coerceAngle(this._settings.get_int("shadow-angle"))
        };
    }
    _globalBackground() {
        return {
            color: this._settings.get_string("force-background-color") || DEFAULT_BACKGROUND.color,
            cornerRadius: clampInt(this._settings.get_int("force-corner-radius"), 0, 32, DEFAULT_BACKGROUND.cornerRadius),
            blur: clampInt(this._settings.get_int("force-background-blur"), 0, 60, DEFAULT_BACKGROUND.blur)
        };
    }
    _globalShadow() {
        return {
            enabled: this._settings.get_boolean("force-shadow-enabled"),
            color: this._settings.get_string("force-shadow-color") || DEFAULT_SHADOW.color,
            opacity: clampInt(this._settings.get_int("force-shadow-opacity"), 0, 100, DEFAULT_SHADOW.opacity),
            spread: clampInt(this._settings.get_int("force-shadow-spread"), 0, 20, DEFAULT_SHADOW.spread),
            blur: clampInt(this._settings.get_int("force-shadow-blur"), 0, 60, DEFAULT_SHADOW.blur)
        };
    }
    resolve(widgetAppearance) {
        const {distance: distance, angle: angle} = this._globalShadowDistanceAngle();
        const globalBackground = this.isBackgroundColorForced() || this.isCornerRadiusForced() || this.isBackgroundBlurForced() ? this._globalBackground() : null;
        const background = {
            color: this.isBackgroundColorForced() ? globalBackground.color : widgetAppearance?.background?.color ?? DEFAULT_BACKGROUND.color,
            cornerRadius: this.isCornerRadiusForced() ? globalBackground.cornerRadius : clampInt(widgetAppearance?.background?.cornerRadius, 0, 32, DEFAULT_BACKGROUND.cornerRadius),
            blur: this.isBackgroundBlurForced() ? globalBackground.blur : clampInt(widgetAppearance?.background?.blur, 0, 60, DEFAULT_BACKGROUND.blur)
        };
        const shadowBase = this.isShadowForced() ? this._globalShadow() : {
            enabled: widgetAppearance?.shadow?.enabled ?? DEFAULT_SHADOW.enabled,
            color: widgetAppearance?.shadow?.color ?? DEFAULT_SHADOW.color,
            opacity: clampInt(widgetAppearance?.shadow?.opacity, 0, 100, DEFAULT_SHADOW.opacity),
            spread: clampInt(widgetAppearance?.shadow?.spread, 0, 20, DEFAULT_SHADOW.spread),
            blur: clampInt(widgetAppearance?.shadow?.blur, 0, 60, DEFAULT_SHADOW.blur)
        };
        return {
            background: background,
            shadow: {
                ...shadowBase,
                distance: distance,
                angle: angle
            }
        };
    }
    watch(onChange) {
        return this._settings.connect("changed", (_settings, key) => {
            if (key.startsWith("force-") || key === "shadow-distance" || key === "shadow-angle") onChange();
        });
    }
    unwatch(handlerId) {
        if (handlerId) this._settings.disconnect(handlerId);
    }
}