import Gio from "gi://Gio";

import GLib from "gi://GLib";

import { ensureDirectory, readTextFile, writeTextFile } from "./fsUtils.js";

import { angleDistanceToOffset, boxShadowCss, toCssColor, withAlphaHex } from "./widgetVisualKit.js";

const THEME_FILE_NAME = "theme.json";

const DEFAULT_GLOBAL_THEME = Object.freeze({
    border: Object.freeze({
        enabled: false,
        width: 1,
        color: "#FFFFFF33",
        force: false
    }),
    opacity: Object.freeze({
        value: 100,
        force: false
    }),
    background: Object.freeze({
        transparent: true,
        color: "#1e1e2e",
        blur: 0
    }),
    cornerRadius: Object.freeze({
        value: 12
    }),
    dropShadow: Object.freeze({
        enabled: true,
        transparent: false,
        color: "#000000",
        opacity: .45,
        angle: 90,
        distance: 4,
        blurRadius: 12,
        spread: 0
    })
});

function clampUnit(value, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(1, Math.max(0, value));
}

function hexToRgba(hex, alpha) {
    if (typeof hex !== "string") return `rgba(0, 0, 0, ${alpha})`;
    let h = hex.trim();
    if (h.startsWith("#")) h = h.slice(1);
    if (h.length === 3) h = h.split("").map(c => c + c).join("");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return hex;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export class ThemeService {
    constructor() {
        this._themeFile = null;
        this._isInitialized = false;
        this._cache = null;
        this._forceSettingsHelper = null;
    }
    setForceSettingsHelper(helper) {
        this._forceSettingsHelper = helper ?? null;
    }
    init() {
        if (this._isInitialized) return;
        const configPath = GLib.get_user_config_dir();
        const baseDirPath = GLib.build_filenamev([ configPath, "gnome-widget-center" ]);
        ensureDirectory(baseDirPath);
        const themePath = GLib.build_filenamev([ baseDirPath, THEME_FILE_NAME ]);
        this._themeFile = Gio.File.new_for_path(themePath);
        this._isInitialized = true;
        this.reload();
    }
    getThemeFilePath() {
        if (!this._isInitialized) this.init();
        return this._themeFile.get_path();
    }
    reload() {
        if (!this._isInitialized) this.init();
        try {
            const jsonString = readTextFile(this._themeFile.get_path());
            if (jsonString === null) {
                this._cache = {
                    version: 1,
                    global: {},
                    widgets: {}
                };
                return;
            }
            const parsed = JSON.parse(jsonString);
            this._cache = {
                version: parsed.version ?? 1,
                global: parsed.global ?? {},
                widgets: parsed.widgets ?? {}
            };
        } catch (error) {
            logError(error, "Failed to load theme.json — falling back to defaults");
            this._cache = {
                version: 1,
                global: {},
                widgets: {}
            };
        }
    }
    save(themeConfig) {
        if (!this._isInitialized) this.init();
        try {
            const payload = {
                version: 1,
                global: themeConfig?.global ?? {},
                widgets: themeConfig?.widgets ?? {}
            };
            writeTextFile(this._themeFile.get_path(), JSON.stringify(payload, null, 2));
            this._cache = payload;
        } catch (error) {
            logError(error, "Failed to save theme.json");
            throw error;
        }
    }
    getGlobalTheme() {
        if (!this._isInitialized) this.init();
        const g = this._cache.global ?? {};
        return {
            background: {
                ...DEFAULT_GLOBAL_THEME.background,
                ...g.background ?? {}
            },
            cornerRadius: {
                ...DEFAULT_GLOBAL_THEME.cornerRadius,
                ...g.cornerRadius ?? {}
            },
            dropShadow: {
                ...DEFAULT_GLOBAL_THEME.dropShadow,
                ...g.dropShadow ?? {}
            },
            border: {
                ...DEFAULT_GLOBAL_THEME.border,
                ...g.border ?? {}
            },
            opacity: {
                ...DEFAULT_GLOBAL_THEME.opacity,
                ...g.opacity ?? {}
            }
        };
    }
    getWidgetTheme(widgetId) {
        if (!this._isInitialized) this.init();
        const entry = this._cache.widgets?.[widgetId] ?? {};
        return {
            theme: entry.theme ?? null,
            config: entry.config ?? {},
            position: entry.position ?? null
        };
    }
    setWidgetTheme(widgetId, patch) {
        if (!this._isInitialized) this.init();
        const current = this._cache.widgets?.[widgetId] ?? {};
        const merged = {
            theme: patch.theme ?? current.theme,
            config: {
                ...current.config ?? {},
                ...patch.config ?? {}
            },
            position: patch.position ?? current.position
        };
        this.save({
            global: this._cache.global,
            widgets: {
                ...this._cache.widgets,
                [widgetId]: merged
            }
        });
    }
    setGlobalTheme(patch) {
        if (!this._isInitialized) this.init();
        const current = this.getGlobalTheme();
        this.save({
            global: {
                background: {
                    ...current.background,
                    ...patch.background ?? {}
                },
                cornerRadius: {
                    ...current.cornerRadius,
                    ...patch.cornerRadius ?? {}
                },
                dropShadow: {
                    ...current.dropShadow,
                    ...patch.dropShadow ?? {}
                },
                border: {
                    ...current.border,
                    ...patch.border ?? {}
                },
                opacity: {
                    ...current.opacity,
                    ...patch.opacity ?? {}
                }
            },
            widgets: this._cache.widgets
        });
    }
    getGlobalCornerRadiusCss() {
        const {cornerRadius: cornerRadius} = this.getGlobalTheme();
        if (!Number.isFinite(cornerRadius.value)) return "";
        return `border-radius: ${Math.round(Math.max(0, cornerRadius.value))}px;`;
    }
    getGlobalBackgroundCss() {
        const {background: background} = this.getGlobalTheme();
        const alpha = background.transparent ? 0 : 1;
        const parts = [ `background-color: ${hexToRgba(background.color, alpha)};` ];
        if (Number.isFinite(background.blur) && background.blur > 0) parts.push(`-st-background-blur: ${Math.round(background.blur)}px;`);
        return parts.join(" ");
    }
    getGlobalDropShadowCss() {
        const {dropShadow: dropShadow} = this.getGlobalTheme();
        if (!dropShadow.enabled || dropShadow.transparent) return "";
        const alpha = clampUnit(dropShadow.opacity, DEFAULT_GLOBAL_THEME.dropShadow.opacity);
        const color = hexToRgba(dropShadow.color, alpha);
        const angle = Number.isFinite(dropShadow.angle) ? dropShadow.angle : DEFAULT_GLOBAL_THEME.dropShadow.angle;
        const distance = Number.isFinite(dropShadow.distance) ? dropShadow.distance : DEFAULT_GLOBAL_THEME.dropShadow.distance;
        const blur = Number.isFinite(dropShadow.blurRadius) ? Math.max(0, dropShadow.blurRadius) : 12;
        const spread = Number.isFinite(dropShadow.spread) ? dropShadow.spread : 0;
        const {offsetX: offsetX, offsetY: offsetY} = angleDistanceToOffset(angle, distance);
        return `box-shadow: ${offsetX}px ${offsetY}px ${blur}px ${spread}px ${color};`;
    }
    applyGlobalStyle(actor) {
        if (!actor) return;
        const css = [ this.getGlobalBackgroundCss(), this.getGlobalDropShadowCss() ].filter(Boolean).join(" ");
        actor.set_style(css);
    }
    getEffectiveWidgetTheme(widgetId) {
        const base = this.getGlobalTheme();
        const {config: config} = this.getWidgetTheme(widgetId);
        const background = {
            ...base.background,
            ...config?.background ?? {}
        };
        const cornerRadius = {
            ...base.cornerRadius,
            ...config?.cornerRadius ?? {}
        };
        const dropShadow = {
            ...base.dropShadow,
            ...config?.dropShadow ?? {}
        };
        const border = base.border.force ? {
            ...base.border
        } : {
            ...base.border,
            ...config?.border ?? {}
        };
        const opacity = base.opacity.force ? {
            ...base.opacity
        } : {
            ...base.opacity,
            ...config?.opacity ?? {}
        };
        return {
            background: background,
            cornerRadius: cornerRadius,
            dropShadow: dropShadow,
            border: border,
            opacity: opacity
        };
    }
    applyWidgetStyle(actor, widgetId) {
        if (!actor) return;
        actor.set_style(this.computeWidgetStyleCss(widgetId));
    }
    // Pure CSS-string version of applyWidgetStyle() — no actor required, no
    // side effects. Exists so callers that need to fold this CSS into a
    // larger style string (e.g. a themeable widget's own _render(), which
    // also needs to set padding/spacing on the same actor) don't have to
    // call actor.set_style() twice — St's set_style() replaces the whole
    // inline style, it doesn't merge, so two independent callers styling
    // the same actor will always fight over it and the loser's CSS (which
    // is often the Force Settings / theme-pack resolved CSS) gets dropped.
    // See widgets/*/widget.js's `this._api.themeable` branches in _render().
    computeWidgetStyleCss(widgetId) {
        const {background: background, cornerRadius: cornerRadius, dropShadow: dropShadow, border: border} = this.getEffectiveWidgetTheme(widgetId);
        const resolved = this._forceSettingsHelper ? this._forceSettingsHelper.resolve({
            background: {
                color: withAlphaHex(background.color ?? "#1e1e2e", background.transparent ? 0 : 1),
                cornerRadius: cornerRadius.value,
                blur: background.blur
            },
            shadow: {
                enabled: dropShadow.enabled && !dropShadow.transparent,
                color: dropShadow.color,
                opacity: Math.round(clampUnit(dropShadow.opacity, DEFAULT_GLOBAL_THEME.dropShadow.opacity) * 100),
                spread: dropShadow.spread,
                blur: dropShadow.blurRadius
            }
        }) : null;
        const parts = [];
        
        // เพิ่มบรรทัดนี้เพื่อแก้ปัญหา Label ขยับเมื่อใช้ Force corner-radius
        parts.push("box-sizing: border-box;"); 
        
        if (resolved) {
            parts.push(`background-color: ${toCssColor(resolved.background.color, "#000000F5")};`);
            if (Number.isFinite(resolved.background.blur) && resolved.background.blur > 0) parts.push(`-st-background-blur: ${Math.round(resolved.background.blur)}px;`);
            if (Number.isFinite(resolved.background.cornerRadius)) parts.push(`border-radius: ${Math.round(Math.max(0, resolved.background.cornerRadius))}px;`);
            if (resolved.shadow.enabled) {
                parts.push(boxShadowCss({
                    color: resolved.shadow.color,
                    opacityPercent: resolved.shadow.opacity,
                    angleDeg: resolved.shadow.angle,
                    distance: resolved.shadow.distance,
                    blur: resolved.shadow.blur,
                    spread: resolved.shadow.spread
                }));
            }
        } else {
            const alpha = background.transparent ? 0 : 1;
            parts.push(`background-color: ${hexToRgba(background.color, alpha)};`);
            if (Number.isFinite(background.blur) && background.blur > 0) parts.push(`-st-background-blur: ${Math.round(background.blur)}px;`);
            if (Number.isFinite(cornerRadius.value)) parts.push(`border-radius: ${Math.round(Math.max(0, cornerRadius.value))}px;`);
            if (dropShadow.enabled && !dropShadow.transparent) {
                const shadowAlpha = clampUnit(dropShadow.opacity, DEFAULT_GLOBAL_THEME.dropShadow.opacity);
                const color = hexToRgba(dropShadow.color, shadowAlpha);
                const angle = Number.isFinite(dropShadow.angle) ? dropShadow.angle : DEFAULT_GLOBAL_THEME.dropShadow.angle;
                const distance = Number.isFinite(dropShadow.distance) ? dropShadow.distance : DEFAULT_GLOBAL_THEME.dropShadow.distance;
                const blur = Number.isFinite(dropShadow.blurRadius) ? Math.max(0, dropShadow.blurRadius) : 12;
                const spread = Number.isFinite(dropShadow.spread) ? dropShadow.spread : 0;
                const {offsetX: offsetX, offsetY: offsetY} = angleDistanceToOffset(angle, distance);
                parts.push(`box-shadow: ${offsetX}px ${offsetY}px ${blur}px ${spread}px ${color};`);
            }
        }
        if (border?.enabled) {
            const width = Number.isFinite(border.width) ? Math.max(0, border.width) : DEFAULT_GLOBAL_THEME.border.width;
            const color = toCssColor(border.color ?? DEFAULT_GLOBAL_THEME.border.color, DEFAULT_GLOBAL_THEME.border.color);
            parts.push(`border: ${width}px solid ${color};`);
        } else {
            // เพิ่มบรรทัดนี้เพื่อบังคับล้าง Border เดิมเมื่อ Disable
            parts.push("border: none;"); 
        }
        return parts.join(" ");
    }
    watch(onChange) {
        if (!this._isInitialized) this.init();
        this.unwatch();
        let monitor;
        try {
            monitor = this._themeFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
        } catch (error) {
            logError(error, "Failed to watch theme.json for external changes");
            return;
        }
        let debounceId = null;
        const handlerId = monitor.connect("changed", () => {
            if (debounceId) GLib.source_remove(debounceId);
            debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                debounceId = null;
                this.reload();
                onChange();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._watch = {
            monitor: monitor,
            handlerId: handlerId,
            get debounceId() {
                return debounceId;
            }
        };
    }
    unwatch() {
        if (!this._watch) return;
        if (this._watch.debounceId) GLib.source_remove(this._watch.debounceId);
        this._watch.monitor.disconnect(this._watch.handlerId);
        this._watch.monitor.cancel();
        this._watch = null;
    }
}