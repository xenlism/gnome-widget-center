// products/extension/lib/exportService.js
//
// Task 11 (theme export/backup) — ".gwct" (GNOME Widget Center Theme)
// files: a single JSON document, extension `.gwct`, that captures
// "how this desktop is set up" WITHOUT anything a user would be
// uncomfortable handing to someone else:
//
//   INCLUDED:
//     - global appearance (theme.json's `background`, `cornerRadius`,
//       and `dropShadow` — force flags included — see themeService.js)
//     - host-level preferences (edge margin, widget spacing, snapping,
//       language, overlay keybinding, ... — see HOST_SETTINGS_KEYS below.
//       All non-secret by construction: this schema is host-only flags/
//       preferences, per its own file header, and has never carried a
//       credential-shaped key)
//     - per ENABLED widget only — "enabled" meaning it's actually placed
//       on the desktop (has a saved position) AND not in the host's
//       `disabled-widgets` GSettings list; a widget that's merely
//       installed but never placed is skipped too, same as a disabled
//       one — a `.gwct` describes the desktop you're actually using,
//       not every widget you've ever installed: its id, its saved
//       position (layout.json), its own BEHAVIOR settings
//       (widgets/<id>.json via StorageService) with
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
//     - disabled widgets (see "ENABLED widget only" above).
//     - host settings that aren't real preferences: `requested-widget-id`
//       (a transient one-shot IPC hint between the Shell and prefs
//       processes, explicitly documented as "NOT a widget config value"
//       in the schema itself), `dev-mode` (a developer toggle, not part
//       of "how this desktop looks"), `disabled-widgets` itself
//       (redundant now that disabled widgets are simply left out of
//       `widgets[]` above — re-importing it verbatim could disable
//       widgets on the target machine that this theme file never even
//       mentions), and `known-widget-ids` (2026-08-08 — pure
//       first-seen bookkeeping for the "load widget on install" policy,
//       not a preference; importing it verbatim on another machine
//       would wrongly mark widgets as "already seen" there).
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

import {writeJsonFile, readTextFile} from './fsUtils.js';
import {readWidgetConfig} from './widgetConfigReader.js';
import {redactSecrets} from './secretFields.js';
import {verifyWidgetDependencies} from './dependencyChecker.js';

export const GWCT_EXTENSION = '.gwct';
const GWCT_FORMAT = 'gwct';
const GWCT_VERSION = 1;

// Host-level GSettings keys that count as "theme"/preference data — see
// this file's header for exactly why `disabled-widgets`,
// `requested-widget-id`, and `dev-mode` are deliberately NOT in this
// list. Every key here is a plain flag/number/string preference, never
// anything credential-shaped, so nothing here needs secretFields.js's
// redaction pass the way per-widget settings do.
const HOST_SETTINGS_KEYS = [
    'prevent-widget-overlap', 'edge-margin', 'widget-spacing', 'language',
    'guide-color', 'snap-enabled', 'snap-distance', 'grid-snap-enabled',
    'grid-size', 'widget-center-overlay-keybinding', 'auto-enable-new-widgets',
];

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
 * @param {DiscoveredWidget[]} widgets - every candidate widget, e.g. all
 *   currently-installed widgets; disabled ones are filtered out
 *   internally (see `settings` param) — callers don't need to pre-filter.
 * @param {{storage: import('./storageService.js').StorageService,
 *           theme: import('./themeService.js').ThemeService,
 *           settings?: import('./settingsService.js').SettingsService}} services
 *   `settings` is optional so existing/tested callers that don't have one
 *   handy still get a valid (just host-settings-and-enabled-state-free)
 *   document instead of a hard failure — when omitted, every widget in
 *   `widgets` is treated as enabled and `hostSettings` comes back `{}`.
 * @returns {{document: object, redactedFields: Array<{widgetId: string, keys: string[]}>}}
 *   `redactedFields` lists what got left out of each widget's settings,
 *   purely for showing the user a "these fields were not exported"
 *   summary — it's not part of the document itself.
 */
export function buildGwctDocument(widgets, {storage, theme, settings}) {
    const globalTheme = theme.getGlobalTheme();
    const redactedFields = [];

    // "Enabled" here has to mean "actually on this desktop right now" —
    // not just "not explicitly disabled". `disabled-widgets` only tracks
    // widgets someone deliberately turned off; a widget that's simply
    // installed but was never dragged onto the desktop at all is ALSO
    // absent from that list, so filtering on it alone exports every
    // installed widget, not the ones actually in use (this is what
    // produced a 70-widget export instead of "the handful I'm using").
    // A widget only counts as enabled if BOTH are true: it's not in
    // `disabled-widgets`, AND it has a saved position in layout.json
    // (storage.getWidgetPosition() — null means it was never placed).
    const disabledIds = settings?.isReady
        ? new Set(settings.getGlobalValue('disabled-widgets'))
        : new Set();
    const enabledWidgets = widgets.filter(widget =>
        !disabledIds.has(widget.id) && storage.getWidgetPosition(widget.id) !== null);

    const widgetEntries = enabledWidgets.map(widget => {
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

    const hostSettings = {};
    if (settings?.isReady) {
        for (const key of HOST_SETTINGS_KEYS) {
            try {
                hostSettings[key] = settings.getGlobalValue(key);
            } catch (e) {
                // Schema on this build doesn't have this key (older/newer
                // extension version) — skip it rather than fail the whole
                // export over one optional preference.
            }
        }
    }

    const document = {
        format: GWCT_FORMAT,
        version: GWCT_VERSION,
        exportedAt: new Date().toISOString(),
        appearance: {
            background: {...globalTheme.background},
            cornerRadius: {...globalTheme.cornerRadius},
            dropShadow: {...globalTheme.dropShadow},
        },
        hostSettings,
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
    writeJsonFile(finalPath, document, 2);
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
    const contents = readTextFile(path);
    if (contents === null)
        throw new Error(`File not found: ${path}`);

    const parsed = JSON.parse(contents);

    if (parsed.format !== GWCT_FORMAT)
        throw new Error('Not a GNOME Widget Center theme file (.gwct).');
    if (typeof parsed.version !== 'number' || parsed.version > GWCT_VERSION)
        throw new Error(`This theme file needs a newer version of GNOME Widget Center (file version ${parsed.version}).`);

    return parsed;
}

/**
 * Applies a parsed `.gwct` document to this machine: global appearance,
 * host preferences, then each widget entry that has a matching widget
 * actually installed here. Never installs a widget, never writes widget
 * FILES — only ever touches theme.json/layout.json/widgets/<id>.json/
 * GSettings via the services passed in, exactly like the Control
 * Center's own settings pages do.
 * @param {object} document - from readGwctFile().
 * @param {{storage: import('./storageService.js').StorageService,
 *           theme: import('./themeService.js').ThemeService,
 *           settings?: import('./settingsService.js').SettingsService,
 *           discoveredWidgetsById: Map<string, DiscoveredWidget>}} services
 *   `settings` is optional (see buildGwctDocument()'s matching note) —
 *   when omitted, `hostSettings` is skipped and widgets are applied
 *   without touching `disabled-widgets` (so an already-disabled widget
 *   stays disabled even if its settings got updated). When provided,
 *   every discovered widget NOT covered by this document ends up
 *   disabled (see the disabledIds comment below) — importing a theme
 *   replaces which widgets are enabled, it doesn't just add to them.
 * @returns {{
 *   appliedWidgetIds: string[],
 *   missingWidgets: Array<{id: string, name: string}>,
 *   dependencyWarnings: Array<{widgetId: string, bin: string, reason: string, suggestedCommand: string|null}>
 * }}
 */
export function importGwctDocument(document, {storage, theme, settings, discoveredWidgetsById}) {
    const appliedWidgetIds = [];
    const missingWidgets = [];
    const dependencyWarnings = [];

    theme.setGlobalTheme({
        background: document.appearance?.background ?? {},
        cornerRadius: document.appearance?.cornerRadius ?? {},
        dropShadow: document.appearance?.dropShadow ?? {},
    });

    if (settings?.isReady && document.hostSettings) {
        for (const [key, value] of Object.entries(document.hostSettings)) {
            // Ignore anything not in HOST_SETTINGS_KEYS (a newer exporter's
            // extra key, or a hand-edited file) and anything the local
            // schema doesn't recognize (older/newer extension build) —
            // one unknown preference shouldn't fail the whole import.
            if (!HOST_SETTINGS_KEYS.includes(key)) continue;
            try {
                settings.setGlobalValue(key, value);
            } catch (e) {
                // skip
            }
        }
    }

    // buildGwctDocument() is *supposed* to only include enabled widgets,
    // but its "enabled" check is just "not in disabled-widgets" — a
    // widget that was never explicitly disabled (e.g. never placed on
    // the desktop at all) still counts as "enabled" and ends up in
    // document.widgets. So document.widgets can't be trusted as "exactly
    // the widgets that should be enabled" on its own.
    //
    // A theme import is meant to reproduce a whole desktop, not layer
    // config onto whatever's currently enabled here. So: start from
    // EVERY discovered widget disabled, then re-enable only the ones
    // this document actually applies below. That also means a widget
    // enabled locally but absent from the theme ends up disabled after
    // import, same as every widget the theme itself doesn't mention.
    // Batched into one disabled-widgets write at the end rather than one
    // per widget.
    const disabledIds = settings?.isReady
        ? new Set(discoveredWidgetsById.keys())
        : null;

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
        disabledIds?.delete(entry.id);

        appliedWidgetIds.push(entry.id);
    }

    if (disabledIds !== null)
        settings.setGlobalValue('disabled-widgets', Array.from(disabledIds));

    return {appliedWidgetIds, missingWidgets, dependencyWarnings};
}
