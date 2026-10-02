import { applySchemeToSettings } from "./colorScheme.js";

import { applyCardSettingsToSettings } from "./cardDefaults.js";

import { applyFontSettingsToSettings, deriveFontSettings } from "./fontScheme.js";

import GLib from "gi://GLib";

import { writeJsonFile, readTextFileAsync, ensureDirectory, fileExists } from "./fsUtils.js";

import { readWidgetConfig } from "./widgetConfigReader.js";

import { redactSecrets } from "./secretFields.js";

import { verifyWidgetDependencies } from "./dependencyChecker.js";

export const GWCT_EXTENSION = ".gwct";

const GWCT_FORMAT = "gwct";

const GWCT_VERSION = 1;

const HOST_SETTINGS_KEYS = [ "prevent-widget-overlap", "edge-margin", "widget-spacing", "language", "guide-color", "snap-enabled", "snap-distance", "grid-snap-enabled", "grid-size", "shadow-angle", "shadow-distance", "widget-center-overlay-keybinding", "auto-enable-new-widgets" ];

// Personal settings: exported with a pack, never overwritten when one is loaded.
const PACK_APPLY_SKIP_HOST_KEYS = new Set([ "language", "widget-center-overlay-keybinding", "auto-enable-new-widgets" ]);

export function ensureGwctExtension(path) {
    return path.endsWith(GWCT_EXTENSION) ? path : `${path}${GWCT_EXTENSION}`;
}

function _buildWidgetEntry(widget, {storage: storage, theme: theme}, redactedFields, fontItems) {
    const {config: config} = readWidgetConfig(widget.path);
    const rawSettings = storage.getWidgetSettings(widget.id);
    fontItems?.push({ config: config, settings: rawSettings });
    const {redacted: redacted, removedKeys: removedKeys} = redactSecrets(rawSettings, config);
    if (removedKeys.length > 0) redactedFields.push({
        widgetId: widget.id,
        keys: removedKeys
    });
    const position = storage.getWidgetPosition(widget.id);
    const widgetTheme = theme.getWidgetTheme(widget.id);
    const dependencies = Array.isArray(widget.metadata?.dependencies?.system) ? widget.metadata.dependencies.system.filter(dep => dep && typeof dep.bin === "string" && dep.bin).map(dep => ({
        bin: dep.bin,
        reason: dep.reason ?? "",
        package: dep.package ?? {}
    })) : [];
    return {
        id: widget.id,
        name: widget.metadata?.name ?? widget.id,
        position: position ?? null,
        settings: redacted,
        theme: {
            theme: widgetTheme.theme,
            config: widgetTheme.config
        },
        dependencies: dependencies
    };
}

function _buildDocumentShell(theme, settings, widgetEntries, fontItems) {
    const globalTheme = theme.getGlobalTheme();
    // Font defaults (text-1 / text-2 face + size): use the block the user set
    // in Preferences, otherwise derive it from the exported widgets (most
    // common value per role) so every exported pack carries them.
    const fontSettings = globalTheme.fontSettings ?? deriveFontSettings(fontItems);
    const hostSettings = {};
    if (settings?.isReady) {
        for (const key of HOST_SETTINGS_KEYS) {
            try {
                hostSettings[key] = settings.getGlobalValue(key);
            } catch (e) {}
        }
    }
    return {
        format: GWCT_FORMAT,
        version: GWCT_VERSION,
        exportedAt: (new Date).toISOString(),
        appearance: {
            background: {
                ...globalTheme.background
            },
            cornerRadius: {
                ...globalTheme.cornerRadius
            },
            dropShadow: {
                ...globalTheme.dropShadow
            },
            ...globalTheme.colorScheme ? { colorScheme: { ...globalTheme.colorScheme } } : {},
            ...globalTheme.cardSettings ? { cardSettings: { ...globalTheme.cardSettings } } : {},
            ...fontSettings ? { fontSettings: { ...fontSettings } } : {}
        },
        hostSettings: hostSettings,
        widgets: widgetEntries
    };
}

function _enabledWidgets(widgets, storage, settings) {
    const disabledIds = settings?.isReady ? new Set(settings.getGlobalValue("disabled-widgets")) : new Set;
    return widgets.filter(widget => !disabledIds.has(widget.id) && storage.getWidgetPosition(widget.id) !== null);
}

function _idleTick() {
    return new Promise(resolve => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

export function buildGwctDocument(widgets, {storage: storage, theme: theme, settings: settings}) {
    const redactedFields = [];
    const fontItems = [];
    const enabledWidgets = _enabledWidgets(widgets, storage, settings);
    const widgetEntries = enabledWidgets.map(widget => _buildWidgetEntry(widget, {
        storage: storage,
        theme: theme
    }, redactedFields, fontItems));
    return {
        document: _buildDocumentShell(theme, settings, widgetEntries, fontItems),
        redactedFields: redactedFields
    };
}

export async function buildGwctDocumentAsync(widgets, {storage: storage, theme: theme, settings: settings}, onProgress) {
    const redactedFields = [];
    const fontItems = [];
    const enabledWidgets = _enabledWidgets(widgets, storage, settings);
    const total = enabledWidgets.length;
    const widgetEntries = [];
    for (let i = 0; i < enabledWidgets.length; i++) {
        widgetEntries.push(_buildWidgetEntry(enabledWidgets[i], {
            storage: storage,
            theme: theme
        }, redactedFields, fontItems));
        onProgress?.(i + 1, total);
        if ((i + 1) % 5 === 0) await _idleTick();
    }
    return {
        document: _buildDocumentShell(theme, settings, widgetEntries, fontItems),
        redactedFields: redactedFields
    };
}

export function writeGwctFile(path, document) {
    const finalPath = ensureGwctExtension(path);
    writeJsonFile(finalPath, document, 2);
    return finalPath;
}

export async function readGwctFile(path) {
    const contents = await readTextFileAsync(path);
    if (contents === null) throw new Error(`File not found: ${path}`);
    const parsed = JSON.parse(contents);
    if (parsed.format !== GWCT_FORMAT) throw new Error("Not a GNOME Widget Center theme file (.gwct).");
    if (typeof parsed.version !== "number" || parsed.version > GWCT_VERSION) throw new Error(`This theme file needs a newer version of GNOME Widget Center (file version ${parsed.version}).`);
    return parsed;
}

export function importGwctDocument(document, {storage: storage, theme: theme, settings: settings, discoveredWidgetsById: discoveredWidgetsById}) {
    const appliedWidgetIds = [];
    const missingWidgets = [];
    const dependencyWarnings = [];
    theme.setGlobalTheme({
        background: document.appearance?.background ?? {},
        cornerRadius: document.appearance?.cornerRadius ?? {},
        dropShadow: document.appearance?.dropShadow ?? {},
        // A pack without a colorScheme clears the current one, so the
        // imported theme is self-contained.
        colorScheme: document.appearance?.colorScheme ?? null,
        // Same for card settings: a pack without them clears the current block.
        cardSettings: document.appearance?.cardSettings ?? null,
        // Same for font settings (text-1 / text-2 face + size).
        fontSettings: document.appearance?.fontSettings ?? null
    });
    if (settings?.isReady && document.hostSettings) {
        for (const [key, value] of Object.entries(document.hostSettings)) {
            if (!HOST_SETTINGS_KEYS.includes(key) || PACK_APPLY_SKIP_HOST_KEYS.has(key)) continue;
            try {
                settings.setGlobalValue(key, value);
            } catch (e) {}
        }
    }
    const disabledIds = settings?.isReady ? new Set(discoveredWidgetsById.keys()) : null;
    for (const entry of document.widgets ?? []) {
        const discovered = discoveredWidgetsById.get(entry.id);
        if (!discovered) {
            missingWidgets.push({
                id: entry.id,
                name: entry.name ?? entry.id
            });
            continue;
        }
        const {missing: missing} = verifyWidgetDependencies(discovered.metadata);
        for (const dep of missing) {
            dependencyWarnings.push({
                widgetId: entry.id,
                bin: dep.bin,
                reason: dep.reason,
                suggestedCommand: dep.suggestedCommand
            });
        }
        storage.saveWidgetSettings(entry.id, entry.settings ?? {});
        if (entry.position) {
            storage.updateWidgetPosition(entry.id, entry.position.x, entry.position.y, entry.position.monitorIndex ?? 0);
        } else {
            storage.removeWidgetLayoutEntry(entry.id);
        }
        theme.setWidgetTheme(entry.id, {
            theme: entry.theme?.theme ?? undefined,
            config: entry.theme?.config ?? {}
        });
        disabledIds?.delete(entry.id);
        appliedWidgetIds.push(entry.id);
    }
    // The applied pack is the source of truth for every widget, not only the
    // ones it lists. Widgets outside the pack are switched off right now, but
    // may carry an old <id>.json from an earlier session; the loader only
    // fills *missing* keys, so such a widget would come back with stale card
    // colors the moment the user enables it. Overwrite the pack-covered keys
    // (card settings, color scheme, fonts) on those widgets now, so enabling
    // one later always matches the theme. Widgets that ARE in the pack are
    // skipped: their own entry.settings above already won.
    const packWidgetIds = new Set(appliedWidgetIds);
    const outsidePack = [ ...discoveredWidgetsById.values() ].filter(w => !packWidgetIds.has(w.id)).map(w => ({
        id: w.id,
        path: w.path,
        hasConfigJson: true // discover() doesn't set it; readWidgetConfig() returns null when absent
    }));
    if (outsidePack.length > 0) {
        const ctx = { storage: storage, discoveredWidgets: outsidePack };
        const appearance = document.appearance ?? {};
        applyCardSettingsToWidgets(appearance.cardSettings ?? null, ctx);
        applyColorSchemeToWidgets(appearance.colorScheme ?? null, ctx);
        applyFontSettingsToWidgets(appearance.fontSettings ?? null, ctx);
    }
    if (disabledIds !== null) settings.setGlobalValue("disabled-widgets", Array.from(disabledIds));
    return {
        appliedWidgetIds: appliedWidgetIds,
        missingWidgets: missingWidgets,
        dependencyWarnings: dependencyWarnings,
        packMeta: document.packMeta ?? null
    };
}

export function installGwctAsThemePack(document, userThemepacksDir) {
    ensureDirectory(userThemepacksDir);
    const baseSlug = (document.packMeta?.name || document.packMeta?.id || "imported-theme").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "imported-theme";
    let fileName = `${baseSlug}${GWCT_EXTENSION}`;
    let destPath = GLib.build_filenamev([ userThemepacksDir, fileName ]);
    let suffix = 2;
    while (fileExists(destPath)) {
        fileName = `${baseSlug}-${suffix}${GWCT_EXTENSION}`;
        destPath = GLib.build_filenamev([ userThemepacksDir, fileName ]);
        suffix += 1;
    }
    writeJsonFile(destPath, document, 2);
    return destPath;
}

// Writes the color scheme into every widget that declares schemeRole fields,
// overwriting those colors. Returns the ids of widgets that actually changed.
export function applyColorSchemeToWidgets(scheme, {storage: storage, discoveredWidgets: discoveredWidgets}) {
    const changedIds = [];
    for (const widget of discoveredWidgets ?? []) {
        if (!widget.hasConfigJson) continue;
        try {
            const { config } = readWidgetConfig(widget.path);
            if (!config) continue;
            const current = { ...storage.getWidgetSettings(widget.id) ?? {} };
            if (applySchemeToSettings(config, current, scheme) > 0) {
                storage.saveWidgetSettings(widget.id, current);
                changedIds.push(widget.id);
            }
        } catch (e) {
            logError(e, `could not apply color scheme to ${widget.id}`);
        }
    }
    return changedIds;
}

// Writes the global card settings (radius, border, shadow, blur, opacity, ...)
// into every widget that declares the matching card fields, overwriting those
// values. Returns the ids of widgets that actually changed.
export function applyCardSettingsToWidgets(cardSettings, {storage: storage, discoveredWidgets: discoveredWidgets}) {
    const changedIds = [];
    for (const widget of discoveredWidgets ?? []) {
        if (!widget.hasConfigJson) continue;
        try {
            const { config } = readWidgetConfig(widget.path);
            if (!config) continue;
            const current = { ...storage.getWidgetSettings(widget.id) ?? {} };
            if (applyCardSettingsToSettings(config, current, cardSettings) > 0) {
                storage.saveWidgetSettings(widget.id, current);
                changedIds.push(widget.id);
            }
        } catch (e) {
            logError(e, `could not apply card settings to ${widget.id}`);
        }
    }
    return changedIds;
}

// Writes the global font settings (text-1 / text-2 face + size) into every
// widget that declares fields with a matching fontRole, overwriting those
// values. Returns the ids of widgets that actually changed.
export function applyFontSettingsToWidgets(fontSettings, {storage: storage, discoveredWidgets: discoveredWidgets}) {
    const changedIds = [];
    for (const widget of discoveredWidgets ?? []) {
        if (!widget.hasConfigJson) continue;
        try {
            const { config } = readWidgetConfig(widget.path);
            if (!config) continue;
            const current = { ...storage.getWidgetSettings(widget.id) ?? {} };
            if (applyFontSettingsToSettings(config, current, fontSettings) > 0) {
                storage.saveWidgetSettings(widget.id, current);
                changedIds.push(widget.id);
            }
        } catch (e) {
            logError(e, `could not apply font settings to ${widget.id}`);
        }
    }
    return changedIds;
}
