import { writeJsonFile, readTextFile } from "./fsUtils.js";

import { readWidgetConfig } from "./widgetConfigReader.js";

import { redactSecrets } from "./secretFields.js";

import { verifyWidgetDependencies } from "./dependencyChecker.js";

export const GWCT_EXTENSION = ".gwct";

const GWCT_FORMAT = "gwct";

const GWCT_VERSION = 1;

const HOST_SETTINGS_KEYS = [ "prevent-widget-overlap", "edge-margin", "widget-spacing", "language", "guide-color", "snap-enabled", "snap-distance", "grid-snap-enabled", "grid-size", "widget-center-overlay-keybinding", "auto-enable-new-widgets" ];

export function ensureGwctExtension(path) {
    return path.endsWith(GWCT_EXTENSION) ? path : `${path}${GWCT_EXTENSION}`;
}

export function buildGwctDocument(widgets, {storage: storage, theme: theme, settings: settings}) {
    const globalTheme = theme.getGlobalTheme();
    const redactedFields = [];
    const disabledIds = settings?.isReady ? new Set(settings.getGlobalValue("disabled-widgets")) : new Set;
    const enabledWidgets = widgets.filter(widget => !disabledIds.has(widget.id) && storage.getWidgetPosition(widget.id) !== null);
    const widgetEntries = enabledWidgets.map(widget => {
        const {config: config} = readWidgetConfig(widget.path);
        const rawSettings = storage.getWidgetSettings(widget.id);
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
    });
    const hostSettings = {};
    if (settings?.isReady) {
        for (const key of HOST_SETTINGS_KEYS) {
            try {
                hostSettings[key] = settings.getGlobalValue(key);
            } catch (e) {}
        }
    }
    const document = {
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
            }
        },
        hostSettings: hostSettings,
        widgets: widgetEntries
    };
    return {
        document: document,
        redactedFields: redactedFields
    };
}

export function writeGwctFile(path, document) {
    const finalPath = ensureGwctExtension(path);
    writeJsonFile(finalPath, document, 2);
    return finalPath;
}

export function readGwctFile(path) {
    const contents = readTextFile(path);
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
        dropShadow: document.appearance?.dropShadow ?? {}
    });
    if (settings?.isReady && document.hostSettings) {
        for (const [key, value] of Object.entries(document.hostSettings)) {
            if (!HOST_SETTINGS_KEYS.includes(key)) continue;
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
        if (entry.position) storage.updateWidgetPosition(entry.id, entry.position.x, entry.position.y, entry.position.monitorIndex ?? 0);
        theme.setWidgetTheme(entry.id, {
            theme: entry.theme?.theme ?? undefined,
            config: entry.theme?.config ?? {}
        });
        disabledIds?.delete(entry.id);
        appliedWidgetIds.push(entry.id);
    }
    if (disabledIds !== null) settings.setGlobalValue("disabled-widgets", Array.from(disabledIds));
    return {
        appliedWidgetIds: appliedWidgetIds,
        missingWidgets: missingWidgets,
        dependencyWarnings: dependencyWarnings
    };
}