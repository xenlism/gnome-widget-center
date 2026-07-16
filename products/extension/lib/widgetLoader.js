// products/extension/lib/widgetLoader.js
//
// Discovers widget plugin folders (bundled + user-installed), validates
// each metadata.json, and dynamically imports/instantiates widget.js.
// This is the ONLY place that knows how to turn a folder on disk into a
// running widget instance — the host (extension.js) and everything else
// never needs to know a specific widget id. See development/docs/WIDGET_API.md for the
// full contract this enforces.
//
// Per task 01 scope: buildActor() is called but the returned actor is NOT
// added to the stage here (task 02's job). `api.settings` is now backed by
// the real per-widget JSON store (task 03, see widgetSettings.js) when a
// StorageService is passed to the constructor - see _buildApi() below.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {WidgetSettings} from './widgetSettings.js';

const REQUIRED_METADATA_FIELDS = ['id', 'name', 'entry'];

export class WidgetLoader {
    /**
     * @param {string[]} searchPaths - directories to scan; each is expected
     *   to contain one subfolder per widget: <searchPath>/<widget-id>/metadata.json
     * @param {StorageService} [storageService] - task 03's file layer, used
     *   to back `api.settings` with the real per-widget JSON store
     *   (WidgetSettings). Optional only so existing tests/callers that
     *   don't care about settings persistence keep working — without it,
     *   widgets get an inert `{}` for api.settings (same as before task 03).
     * @param {object} [logger] - optional {log,warn,error} - defaults to console
     */
    constructor(searchPaths, storageService = null, logger = console) {
        this._searchPaths = searchPaths;
        this._storageService = storageService;
        this._logger = logger;
        this._instances = new Map(); // id -> {id, metadata, path, ModuleClass, instance, actor}
        this._errors = [];           // [{id, path, reason}]
    }

    /** Errors recorded during the most recent discover()/loadAll() call. */
    get errors() {
        return this._errors;
    }

    /** Currently loaded widget entries (after loadAll()). */
    get instances() {
        return Array.from(this._instances.values());
    }

    /**
     * Scans all search paths, validates metadata.json, returns
     * [{id, metadata, path}]. Invalid or duplicate entries are skipped and
     * recorded in this.errors instead of throwing - one broken folder must
     * never stop discovery of the rest.
     */
    discover() {
        const found = new Map(); // id -> {id, metadata, path}
        this._errors = [];

        for (const basePath of this._searchPaths) {
            const dir = Gio.File.new_for_path(basePath);
            let enumerator;
            try {
                enumerator = dir.enumerate_children(
                    'standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );
            } catch (e) {
                // Search path doesn't exist yet (e.g. user has never
                // installed a widget) - not an error, just nothing to scan.
                continue;
            }

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                    continue;

                const folderName = info.get_name();

                // Folders starting with "_" are conventionally non-widgets
                // (e.g. widgets/_template/ - the scaffold third-party devs
                // copy from, see development/docs/PUBLISHING_A_WIDGET.md).
                // Skip silently - this is not an error, just an intentional
                // exclusion, so it must not show up in this.errors.
                if (folderName.startsWith('_'))
                    continue;

                const widgetDir = dir.get_child(folderName);
                const widgetPath = widgetDir.get_path();
                const metadataFile = widgetDir.get_child('metadata.json');

                let metadata;
                try {
                    metadata = this._readMetadata(metadataFile);
                } catch (e) {
                    this._recordError({id: folderName, path: widgetPath}, `invalid metadata.json: ${e.message}`);
                    continue;
                }

                const missing = REQUIRED_METADATA_FIELDS.filter(field => !(field in metadata));
                if (missing.length > 0) {
                    this._recordError(
                        {id: metadata.id ?? folderName, path: widgetPath},
                        `metadata.json missing required field(s): ${missing.join(', ')}`
                    );
                    continue;
                }

                if (found.has(metadata.id)) {
                    this._recordError(
                        {id: metadata.id, path: widgetPath},
                        `duplicate widget id, already loaded from ${found.get(metadata.id).path}`
                    );
                    continue;
                }

                found.set(metadata.id, {id: metadata.id, metadata, path: widgetPath});
            }
        }

        return Array.from(found.values());
    }

    _readMetadata(metadataFile) {
        if (!metadataFile.query_exists(null))
            throw new Error('metadata.json not found');

        const [ok, contents] = metadataFile.load_contents(null);
        if (!ok)
            throw new Error('could not read metadata.json');

        return JSON.parse(new TextDecoder('utf-8').decode(contents));
    }

    /**
     * Dynamically imports widgetInfo's entry file and returns its default
     * export (expected to be a class). Never throws - failures are recorded
     * in this.errors and null is returned, so one broken widget's syntax
     * error can never take down the rest of the pipeline.
     */
    async loadModule(widgetInfo) {
        const entry = widgetInfo.metadata.entry ?? 'widget.js';
        const entryPath = GLib.build_filenamev([widgetInfo.path, entry]);
        const entryFile = Gio.File.new_for_path(entryPath);

        if (!entryFile.query_exists(null)) {
            this._recordError(widgetInfo, `entry file "${entry}" not found`);
            return null;
        }

        try {
            const module = await import(`file://${entryPath}`);
            if (typeof module.default !== 'function') {
                this._recordError(widgetInfo, `${entry} has no default export class`);
                return null;
            }
            return module.default;
        } catch (e) {
            this._recordError(widgetInfo, `failed to import ${entry}: ${e.message}`);
            return null;
        }
    }

    /**
     * discover() + loadModule() + instantiate + buildActor() + enable() for
     * every widget found (except any id in `disabledIds` — task 05's
     * Control Center toggles, see extension.js — skipped before
     * loadModule() ever runs, so a disabled widget's widget.js is never
     * even imported). Every step is isolated per-widget with try/catch so
     * one bad widget (bad JSON, bad import, throwing constructor, throwing
     * buildActor/enable) can never abort the others. Returns the list of
     * successfully started entries; failures land in this.errors.
     * @param {Set<string>} [disabledIds] - widget ids to skip entirely.
     */
    async loadAll(disabledIds = new Set()) {
        const widgets = this.discover().filter(w => !disabledIds.has(w.id));
        const started = [];

        for (const widgetInfo of widgets) {
            const entry = await this.loadOne(widgetInfo);
            if (entry)
                started.push(entry);
        }

        return started;
    }

    /**
     * Loads and starts a single already-discovered widget — the per-widget
     * body factored out of loadAll() so task 05's Control Center can turn a
     * single widget back on (via its GSettings toggle) without re-running
     * the whole discovery pipeline. No-op (returns the existing entry) if
     * this widget id is already loaded, since addWidgetActor() would
     * otherwise throw on the duplicate.
     * @param {{id, metadata, path}} widgetInfo - one entry from discover()
     * @returns {Promise<object|null>} the started entry, or null on any
     *   failure (recorded in this.errors, same as loadAll()).
     */
    async loadOne(widgetInfo) {
        if (this._instances.has(widgetInfo.id))
            return this._instances.get(widgetInfo.id);

        const ModuleClass = await this.loadModule(widgetInfo);
        if (!ModuleClass)
            return null;

        // Live proxy backed by widgets/<id>.json — no defaults applied
        // yet, since defaults come from the instance we're about to
        // construct (see widgetSettings.js header comment for why this
        // has to be two-phase).
        const settings = this._storageService
            ? WidgetSettings.load(widgetInfo.id, this._storageService)
            : {};

        const api = this._buildApi(widgetInfo, settings);

        let instance;
        try {
            instance = new ModuleClass(api);
        } catch (e) {
            this._recordError(widgetInfo, `constructor threw: ${e.message}`);
            return null;
        }

        if (this._storageService) {
            try {
                const defaults = instance.getDefaultSettings?.() ?? {};
                WidgetSettings.applyDefaults(settings, defaults);
            } catch (e) {
                this._recordError(widgetInfo, `getDefaultSettings() threw: ${e.message}`);
            }
        }

        let actor;
        try {
            actor = instance.buildActor();
            if (!actor) {
                this._recordError(widgetInfo, 'buildActor() returned null/undefined');
                return null;
            }
        } catch (e) {
            this._recordError(widgetInfo, `buildActor() threw: ${e.message}`);
            return null;
        }

        try {
            instance.enable?.();
        } catch (e) {
            // actor exists but enable() failed - still track the entry
            // so unloadAll()/unloadOne() cleans it up instead of leaking it.
            this._recordError(widgetInfo, `enable() threw: ${e.message}`);
        }

        const entry = {...widgetInfo, ModuleClass, instance, actor};
        this._instances.set(widgetInfo.id, entry);
        this._logger.log?.(`[widget-loader] loaded "${widgetInfo.id}" from ${widgetInfo.path}`);
        return entry;
    }

    /**
     * Calls disable() on every loaded instance and destroys its actor,
     * isolating failures per-widget, then clears all internal state. Safe
     * to call multiple times / on an empty loader.
     */
    unloadAll() {
        // Flush pending debounced settings writes (task 03) before
        // destroying anything — a setting a widget set just before
        // disable() shouldn't be silently dropped along with its
        // now-cancelled GLib timeout.
        WidgetSettings.flushAll();

        for (const id of Array.from(this._instances.keys()))
            this._unloadOneInternal(id);
    }

    /**
     * Unloads a single widget by id (task 05 — a Control Center toggle
     * switching one widget off, without disabling the whole extension).
     * Flushes that widget's own pending debounced settings write
     * individually first, since unloadAll()'s single flushAll() call isn't
     * involved in this path. Safe to call for an id that isn't currently
     * loaded (no-op).
     * @param {string} widgetId
     */
    unloadOne(widgetId) {
        if (!this._instances.has(widgetId))
            return;

        WidgetSettings.flush(widgetId);
        this._unloadOneInternal(widgetId);
    }

    /** @private shared teardown body for unloadAll()/unloadOne() — assumes
     * any relevant settings flush already happened. */
    _unloadOneInternal(id) {
        const entry = this._instances.get(id);
        if (!entry)
            return;

        try {
            entry.instance.disable?.();
        } catch (e) {
            this._logger.error?.(`[widget-loader] "${id}" disable() threw: ${e.message}`);
        }
        try {
            entry.actor?.destroy?.();
        } catch (e) {
            this._logger.error?.(`[widget-loader] "${id}" actor destroy threw: ${e.message}`);
        }
        this._instances.delete(id);
    }

    /**
     * @method reloadWidget
     * @description Task 08 — hot-reloads a single already-loaded widget:
     * re-imports its entry file (cache-busted so GJS's module cache doesn't
     * just hand back the stale copy from before the edit) and builds a
     * fresh instance/actor. The OLD instance is only disable()'d and its
     * actor only destroyed once the NEW one has successfully imported,
     * constructed, and built an actor — if anything throws before that
     * point, the old widget is left completely untouched and still
     * running. This is a stricter ordering than loadOne()'s (which has
     * nothing "old" to protect) specifically so a mid-edit syntax error
     * can never leave the desktop with a missing widget, per
     * development/tasks/08-hot-reload-dev-mode.md acceptance criteria.
     *
     * Actor PLACEMENT (removing the old actor from / adding the new one to
     * the Widget Layer at the same position) is the caller's job —
     * extension.js's dev-mode wiring — same separation as loadOne()'s
     * caller doing _placeEntry(); this method only ever touches module
     * loading and instance lifecycle, never WidgetLayer/scene graph.
     * @param {string} widgetId
     * @returns {Promise<object|null>} the new entry on success, or null if
     *   the reload failed (old entry keeps running unchanged, reason
     *   logged via `logger.error`) or the widget wasn't loaded at all.
     */
    async reloadWidget(widgetId) {
        const oldEntry = this._instances.get(widgetId);
        if (!oldEntry) {
            this._logger.warn?.(`[widget-loader] reloadWidget("${widgetId}") — not currently loaded`);
            return null;
        }

        const widgetInfo = {id: oldEntry.id, metadata: oldEntry.metadata, path: oldEntry.path};

        let ModuleClass;
        try {
            const entryName = widgetInfo.metadata.entry ?? 'widget.js';
            const entryPath = GLib.build_filenamev([widgetInfo.path, entryName]);
            const entryFile = Gio.File.new_for_path(entryPath);
            if (!entryFile.query_exists(null))
                throw new Error(`entry file "${entryName}" not found`);

            // Cache-bust: re-importing the exact same file:// URL would
            // just return the module object GJS already has cached from
            // before the edit. A throwaway query string makes this import
            // a distinct cache entry every time.
            const module = await import(`file://${entryPath}?t=${Date.now()}`);
            if (typeof module.default !== 'function')
                throw new Error(`${entryName} has no default export class`);
            ModuleClass = module.default;
        } catch (e) {
            this._logger.error?.(`[widget-loader] "${widgetId}" hot-reload import failed: ${e.message} — keeping previous version running`);
            return null;
        }

        const settings = this._storageService
            ? WidgetSettings.load(widgetId, this._storageService)
            : {};
        const api = this._buildApi(widgetInfo, settings);

        let instance, actor;
        try {
            instance = new ModuleClass(api);
            if (this._storageService) {
                const defaults = instance.getDefaultSettings?.() ?? {};
                WidgetSettings.applyDefaults(settings, defaults);
            }
            actor = instance.buildActor();
            if (!actor)
                throw new Error('buildActor() returned null/undefined');
        } catch (e) {
            this._logger.error?.(`[widget-loader] "${widgetId}" hot-reload build failed: ${e.message} — keeping previous version running`);
            return null;
        }

        // New instance/actor confirmed working — safe to retire the old
        // one now. Failures past this point are logged but can no longer
        // "fall back to old", since we've already committed to the swap.
        try {
            oldEntry.instance.disable?.();
        } catch (e) {
            this._logger.error?.(`[widget-loader] "${widgetId}" old instance disable() threw during hot-reload: ${e.message}`);
        }
        try {
            oldEntry.actor?.destroy?.();
        } catch (e) {
            this._logger.error?.(`[widget-loader] "${widgetId}" old actor destroy threw during hot-reload: ${e.message}`);
        }
        try {
            instance.enable?.();
        } catch (e) {
            this._logger.error?.(`[widget-loader] "${widgetId}" new instance enable() threw during hot-reload: ${e.message}`);
        }

        const newEntry = {...widgetInfo, ModuleClass, instance, actor};
        this._instances.set(widgetId, newEntry);
        this._logger.log?.(`[widget-loader] hot-reloaded "${widgetId}"`);
        return newEntry;
    }

    _recordError(widgetInfo, reason) {
        this._errors.push({id: widgetInfo.id, path: widgetInfo.path, reason});
        this._logger.warn?.(`[widget-loader] "${widgetInfo.id}": ${reason}`);
    }

    // TODO(task 04/07): api.position is still a no-op stub — the drag
    // controller (task 04) currently writes positions straight through
    // WidgetLayer/StorageService rather than this API surface, so a widget
    // reading its own `api.position` won't see drag updates live. Left
    // out of task 04's scope on purpose (see development/tasks/04-drag-reposition.md
    // "Out of scope"); revisit if a widget actually needs to react to
    // being dragged.
    _buildApi(widgetInfo, settings) {
        return {
            settings,
            monitorInfo: null,
            position: {x: 0, y: 0, setPosition() {}},
            bus: {emit() {}, on() {}, off() {}},
            logger: {
                info: (...args) => console.log(`[${widgetInfo.id}]`, ...args),
                warn: (...args) => console.warn(`[${widgetInfo.id}]`, ...args),
                error: (...args) => console.error(`[${widgetInfo.id}]`, ...args),
            },
        };
    }
}
