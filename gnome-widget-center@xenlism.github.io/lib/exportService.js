// products/extension/lib/exportService.js
//
// Task 11 (theme export/backup) — ".gwct" (GNOME Widget Center Theme)
// files: a single JSON document, extension `.gwct`, that captures
// "how this desktop is set up" WITHOUT anything a user would be
// uncomfortable handing to someone else:
//
//   INCLUDED:
//     - global appearance (theme.json's `background` + `cornerRadius`,
//       force flags included — see themeService.js)
//     - per widget: its id, its saved position (layout.json), its own
//       BEHAVIOR settings (widgets/<id>.json via StorageService) with
//       every secret field redacted (see secretFields.js), and its own
//       theme override (theme.json's per-widget `config`/`theme` name)
//     - each referenced widget's declared system `dependencies` (from
//       metadata.json — see dependencyChecker.js), so importing this file
//       on another machine can warn about a missing `playerctl`-style
//       binary before the widget ever runs.
//   EXCLUDED:
//     - secrets: anything a widget's config.json marks `fieldType:
//       "password"`/`format: "email"`, or anything that just LOOKS like
//       a credential by name (api key, token, username, ...) — see
//       secretFields.js for exactly how that's decided.
//     - the widgets' own files (widget.js, stylesheet.css, icons, ...).
//       A `.gwct` only ever describes widgets the IMPORTING machine
//       already has installed; importing one that references a widget
//       you don't have surfaces that widget in the import report instead
//       of silently doing nothing (see importTheme() below) — installing
//       the widget itself is a separate, explicit action, never implied
//       by opening a theme file.
//
// A `.gwcbak` full backup (backupService.js) is the file for "give me
// everything back exactly as it was, including secrets and the widget
// code itself" — deliberately a different, password-protected format;
// see that file's header for why the two aren't the same thing.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {readWidgetConfig} from './widgetConfigReader.js';
import {redactSecrets} from './secretFields.js';
import {verifyWidgetDependencies} from './dependencyChecker.js';

export const GWCT_EXTENSION = '.gwct';
const GWCT_FORMAT = 'gwct';
const GWCT_VERSION = 1;

/**
 * @param {string} path - any path/filename the user picked.
 * @returns {string} the same path, guaranteed to end in `.gwct`.
 */
export function ensureGwctExtension(path) {
    return path.endsWith(GWCT_EXTENSION) ? path : `${path}${GWCT_EXTENSION}`;
}

/**
 * @typedef {object} DiscoveredWidget - one entry from PrefsWidgetList.list().ok
 * @property {string} id
 * @property {string} path
 * @property {object} metadata
 */

/**
 * Builds the full `.gwct` document in memory (callers write it to disk
 * with `writeGwctFile()` — kept separate so tests/callers can inspect the
 * object before it's serialized).
 * @param {DiscoveredWidget[]} widgets - every widget to include, e.g. all
 *   currently-installed widgets, or a user-picked subset.
 * @param {{storage: import('./storageService.js').StorageService,
 *           theme: import('./themeService.js').ThemeService}} services
 * @returns {{document: object, redactedFields: Array<{widgetId: string, keys: string[]}>}}
 *   `redactedFields` lists what got left out of each widget's settings,
 *   purely for showing the user a "these fields were not exported"
 *   summary — it's not part of the document itself.
 */
export function buildGwctDocument(widgets, {storage, theme}) {
    const globalTheme = theme.getGlobalTheme();
    const redactedFields = [];

    const widgetEntries = widgets.map(widget => {
        const {config} = readWidgetConfig(widget.path);
        const rawSettings = storage.getWidgetSettings(widget.id);
        const {redacted, removedKeys} = redactSecrets(rawSettings, config);
        if (removedKeys.length > 0)
            redactedFields.push({widgetId: widget.id, keys: removedKeys});

        const position = storage.getWidgetPosition(widget.id);
        const widgetTheme = theme.getWidgetTheme(widget.id);

        const dependencies = Array.isArray(widget.metadata?.dependencies?.system)
            ? widget.metadata.dependencies.system
                .filter(dep => dep && typeof dep.bin === 'string' && dep.bin)
                .map(dep => ({bin: dep.bin, reason: dep.reason ?? '', package: dep.package ?? {}}))
            : [];

        return {
            id: widget.id,
            name: widget.metadata?.name ?? widget.id,
            position: position ?? null,
            settings: redacted,
            theme: {
                theme: widgetTheme.theme,
                config: widgetTheme.config,
            },
            dependencies,
        };
    });

    const document = {
        format: GWCT_FORMAT,
        version: GWCT_VERSION,
        exportedAt: new Date().toISOString(),
        appearance: {
            background: {...globalTheme.background},
            cornerRadius: {...globalTheme.cornerRadius},
        },
        widgets: widgetEntries,
    };

    return {document, redactedFields};
}

/**
 * @param {string} path - destination file path; `.gwct` appended if
 *   missing (see ensureGwctExtension()).
 * @param {object} document - from buildGwctDocument().
 * @returns {string} the actual path written to.
 */
export function writeGwctFile(path, document) {
    const finalPath = ensureGwctExtension(path);
    const file = Gio.File.new_for_path(finalPath);
    const jsonString = JSON.stringify(document, null, 2);
    const bytes = new TextEncoder().encode(jsonString);

    file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    return finalPath;
}

/**
 * @param {string} path
 * @returns {object} the parsed document.
 * @throws {Error} if the file is missing, not valid JSON, or not a
 *   recognizable `.gwct` document (wrong `format`/newer `version` than
 *   this build knows how to read).
 */
export function readGwctFile(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        throw new Error(`File not found: ${path}`);

    const [success, contents] = file.load_contents(null);
    if (!success)
        throw new Error(`Failed to read: ${path}`);

    const parsed = JSON.parse(new TextDecoder('utf-8').decode(contents));

    if (parsed.format !== GWCT_FORMAT)
        throw new Error('Not a GNOME Widget Center theme file (.gwct).');
    if (typeof parsed.version !== 'number' || parsed.version > GWCT_VERSION)
        throw new Error(`This theme file needs a newer version of GNOME Widget Center (file version ${parsed.version}).`);

    return parsed;
}

/**
 * Applies a parsed `.gwct` document to this machine: global appearance,
 * then each widget entry that has a matching widget actually installed
 * here. Never installs a widget, never writes widget FILES — only ever
 * touches theme.json/layout.json/widgets/<id>.json via the services
 * passed in, exactly like the Control Center's own settings pages do.
 * @param {object} document - from readGwctFile().
 * @param {{storage: import('./storageService.js').StorageService,
 *           theme: import('./themeService.js').ThemeService,
 *           discoveredWidgetsById: Map<string, DiscoveredWidget>}} services
 * @returns {{
 *   appliedWidgetIds: string[],
 *   missingWidgets: Array<{id: string, name: string}>,
 *   dependencyWarnings: Array<{widgetId: string, bin: string, reason: string, suggestedCommand: string|null}>
 * }}
 */
export function importGwctDocument(document, {storage, theme, discoveredWidgetsById}) {
    const appliedWidgetIds = [];
    const missingWidgets = [];
    const dependencyWarnings = [];

    theme.setGlobalTheme({
        background: document.appearance?.background ?? {},
        cornerRadius: document.appearance?.cornerRadius ?? {},
    });

    for (const entry of document.widgets ?? []) {
        const discovered = discoveredWidgetsById.get(entry.id);
        if (!discovered) {
            missingWidgets.push({id: entry.id, name: entry.name ?? entry.id});
            continue;
        }

        const {missing} = verifyWidgetDependencies(discovered.metadata);
        for (const dep of missing) {
            dependencyWarnings.push({
                widgetId: entry.id,
                bin: dep.bin,
                reason: dep.reason,
                suggestedCommand: dep.suggestedCommand,
            });
        }

        storage.saveWidgetSettings(entry.id, entry.settings ?? {});
        if (entry.position)
            storage.updateWidgetPosition(entry.id, entry.position.x, entry.position.y, entry.position.monitorIndex ?? 0);
        theme.setWidgetTheme(entry.id, {
            theme: entry.theme?.theme ?? undefined,
            config: entry.theme?.config ?? {},
        });

        appliedWidgetIds.push(entry.id);
    }

    return {appliedWidgetIds, missingWidgets, dependencyWarnings};
}
