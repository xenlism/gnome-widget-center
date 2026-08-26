import { SHADOW_ANGLE_STEPS } from "./widgetVisualKit.js";

export { SHADOW_ANGLE_STEPS };

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

export class GlobalShadowHelper {
    constructor(settings) {
        this._settings = settings;
    }
    getGlobalShadowDistanceAngle() {
        return {
            distance: clampInt(this._settings.get_int("shadow-distance"), 0, 30, DEFAULT_DISTANCE),
            angle: coerceAngle(this._settings.get_int("shadow-angle"))
        };
    }
    watch(onChange) {
        return this._settings.connect("changed", (_settings, key) => {
            if (key === "shadow-distance" || key === "shadow-angle") onChange(key);
        });
    }
    unwatch(handlerId) {
        if (handlerId) this._settings.disconnect(handlerId);
    }
}
