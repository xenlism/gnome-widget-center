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
import {fileExists} from './fsUtils.js';
import {WidgetSettings} from './widgetSettings.js';
import {validateSettingsSchema, getSchemaDefaults} from './settingsSchema.js';
import {SettingsWatcher} from './settingsWatcher.js';
import {BlockSizeManager, BLOCK_CELL_SIZE} from './blockSizeManager.js';

// NOTE: StWidgetWrapper is intentionally NOT statically imported here.
// widgetLoader.js is shared between extension.js (Shell process, where St
// exists) and prefs.js's PrefsWidgetList (GTK4 prefs process, where St's
// typelib is not available at all — see prefs.js's header comment and
// development/docs/WIDGET_API.md §4). A static `import ... from
// './gjskit/st/StWidget.js'` at the top of this file is resolved eagerly by
// GJS the moment ANYTHING imports widgetLoader.js — even though
// PrefsWidgetList only ever calls discover(), which never touches St — and
// that eager resolution is exactly what crashes the prefs window with
// "Requiring St, version none: Typelib file for namespace 'St' (any
// version) not found". _enforceBlockSize() below is only ever reached from
// loadOne()/hot-reload, which only run in the Shell process, so it lazily
// dynamic-imports StWidget.js right where it's used instead.

// Default block-type when a widget's metadata.json omits the field
// entirely - see development/docs/WIDGET_API.md §2 ("ถ้าไม่ประกาศ field
// นี้เลย จะได้ค่า default กลาง (10 x 6 cell) แทน"). The actual default
// values now live solely in blockSizeManager.js's DEFAULT_BLOCK_SIZE
// (see the 2026-07-26 bug-fix note on _enforceBlockSize() below for why
// this file no longer keeps its own separate copy).

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
     * @param {number} [shadowOverflowMargin=0] - px a widget's own paint
     *   (its drop-shadow, specifically - see lib/widgetVisualKit.js's
     *   shadowBoxShadowCss()) is allowed to bleed past its block-type
     *   footprint before being clipped - see _enforceBlockSize() below.
     *   Defaults to 0 (exact clip, no bleed - the old behavior) so
     *   callers that don't pass this (e.g. prefs.js's PrefsWidgetList,
     *   where _enforceBlockSize() never actually runs anyway) are
     *   unaffected. extension.js seeds this from the `widget-spacing`
     *   GSetting and keeps it live via the shadowOverflowMargin setter.
     * @param {SettingsService|null} [hostSettings] - 2026-08-04. Optional,
     *   only extension.js passes one (prefs.js's PrefsWidgetList doesn't
     *   need it - it never calls buildActor()). Backs api.hostLanguage
     *   (§5 of WIDGET_API.md) - read live off this each time a widget
     *   accesses it, so it's never a stale snapshot even without
     *   notifyHostLanguageChanged() below being called.
     */
    constructor(searchPaths, storageService = null, logger = console, shadowOverflowMargin = 0, hostSettings = null) {
        this._searchPaths = searchPaths;
        this._storageService = storageService;
        this._logger = logger;
        this._instances = new Map(); // id -> {id, metadata, path, ModuleClass, instance, actor, settings}
        this._errors = [];           // [{id, path, reason}]
        this._shadowOverflowMargin = Math.max(0, Number(shadowOverflowMargin) || 0);
        this._hostSettings = hostSettings;

        // Cross-process live update — only meaningful with a real
        // StorageService (same optionality as `settings` itself below;
        // callers that pass none, e.g. lightweight tests, simply never
        // get file monitors installed).
        this._settingsWatcher = storageService ? new SettingsWatcher(storageService) : null;
    }

    /** Called by extension.js's SettingsService.onChanged('language', ...)
     * listener - actively pushes the new value to every currently-loaded
     * widget instance that opted into WIDGET_API.md §3's
     * onHostLanguageChanged(language) hook, for widgets that need to
     * redo work immediately (reload a translation table, re-render)
     * rather than just picking up the new value next time something else
     * happens to re-render them (api.hostLanguage is live either way -
     * see the getter in _buildApi() below - this is only for the "do
     * something right now" case).
     * @param {string} language
     */
    notifyHostLanguageChanged(language) {
        for (const entry of this._instances.values()) {
            try {
                entry.instance.onHostLanguageChanged?.(language);
            } catch (e) {
                this._logger.error?.(`[widget-loader] "${entry.id}".onHostLanguageChanged() threw`, e);
            }
        }
    }

    /** Current shadow-bleed clip margin in px - see the constructor doc. */
    get shadowOverflowMargin() {
        return this._shadowOverflowMargin;
    }

    /** Live update (e.g. extension.js's `widget-spacing` onChanged
     * listener) - re-clips every already-loaded widget's actor at the
     * new margin immediately, same "takes effect without a shell
     * restart" behavior LayoutEngine's edgeMargin/spacing setters have.
     * A no-op for any widget whose actor no longer exists. */
    set shadowOverflowMargin(value) {
        this._shadowOverflowMargin = Math.max(0, Number(value) || 0);
        for (const [id, entry] of this._instances) {
            if (!entry.actor)
                continue;
            // `entry` already carries widgetInfo's fields (id, metadata,
            // path) spread in - see loadOne()/hotReload() below - so it
            // doubles as the widgetInfo argument _enforceBlockSize()
            // expects.
            this._enforceBlockSize(entry, entry.actor)
                .catch(e => this._logger.warn?.(`[widget-loader] "${id}": failed to re-clip after widget-spacing change: ${e.message}`));
        }
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

                // Optional declarative "settings" array (task 05's
                // schema-driven prefs UI, see settingsSchema.js) — a
                // widget isn't required to have one (it may use its own
                // prefs.js instead, or no settings UI at all), but if
                // present it must be well-formed. Same reject-the-whole-
                // widget-and-record-why treatment as a broken
                // metadata.json, rather than silently ignoring bad
                // entries, so an author finds out immediately instead of
                // shipping a schema that produces a blank/broken prefs
                // page.
                const settingsProblems = validateSettingsSchema(metadata.settings);
                if (settingsProblems.length > 0) {
                    this._recordError(
                        {id: metadata.id, path: widgetPath},
                        `invalid "settings" schema: ${settingsProblems.join('; ')}`
                    );
                    continue;
                }

                found.set(metadata.id, {id: metadata.id, metadata, path: widgetPath});
            }
        }

        // Cached separately from this._instances (which only holds
        // widgets that have actually been loadOne()'d, in load order) so
        // api.path.id() below can resolve ANY discovered widget's folder
        // - including ones not yet loaded, or never loaded at all this
        // session - the same way `me` resolves the calling widget's own
        // folder without it needing to be "loaded" from another widget's
        // point of view.
        this._pathById = new Map(Array.from(found.values(), w => [w.id, w.path]));

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

        if (!fileExists(entryPath)) {
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
                // Schema-declared defaults (task 05) are the base layer;
                // an explicit instance.getDefaultSettings() return wins
                // on any key both define, since author-written code is
                // more specific than a declarative shorthand. A widget
                // using ONLY a schema (no getDefaultSettings() override)
                // gets its defaults from the schema alone here.
                const schemaDefaults = getSchemaDefaults(widgetInfo.metadata.settings);
                const defaults = {...schemaDefaults, ...(instance.getDefaultSettings?.() ?? {})};
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
        await this._enforceBlockSize(widgetInfo, actor);

        try {
            instance.enable?.();
        } catch (e) {
            // actor exists but enable() failed - still track the entry
            // so unloadAll()/unloadOne() cleans it up instead of leaking it.
            this._recordError(widgetInfo, `enable() threw: ${e.message}`);
        }

        const entry = {...widgetInfo, ModuleClass, instance, actor, settings};
        this._instances.set(widgetInfo.id, entry);
        this._logger.log?.(`[widget-loader] loaded "${widgetInfo.id}" from ${widgetInfo.path}`);

        // Cross-process live update — start watching THIS widget's
        // settings file for changes made by another process (e.g. the
        // Control Center's prefs.js, task 05) now that it's actually
        // loaded. Looks the entry up fresh from `_instances` at fire time
        // rather than closing over `entry`/`settings` directly, so a
        // later hot-reload (reloadWidget()) swapping in a new instance/
        // settings proxy for the same widgetId is picked up automatically
        // without re-registering the watch — see settingsWatcher.js.
        this._settingsWatcher?.watch(widgetInfo.id, () => {
            const changed = WidgetSettings.reloadFromDisk(widgetInfo.id, this._storageService);
            if (!changed)
                return; // event fired but nothing actually differs (e.g. an echo of our own save)

            const current = this._instances.get(widgetInfo.id);
            try {
                current?.instance.onSettingsChanged?.(current.settings);
            } catch (e) {
                this._logger.error?.(`[widget-loader] "${widgetInfo.id}" onSettingsChanged() threw: ${e.message}`);
            }
        });

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

        // Defensive belt-and-braces: every id normally gets unwatched
        // individually inside _unloadOneInternal() above, but this
        // guarantees zero leftover Gio.FileMonitors even if `_instances`
        // and `_settingsWatcher`'s internal map were ever to drift apart.
        this._settingsWatcher?.unwatchAll();
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

        // Cross-process live update teardown — stop watching this
        // widget's settings file (no more Gio.FileMonitor sitting around
        // for a widget that isn't running) and drop it from
        // WidgetSettings' live-targets registry, so a stray/late file
        // event can never try to write into a proxy nothing references
        // anymore. Order doesn't matter relative to the disable()/
        // destroy() calls below - this is independent cleanup.
        this._settingsWatcher?.unwatch(id);
        WidgetSettings.release(id);

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
            if (!fileExists(entryPath))
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
                const schemaDefaults = getSchemaDefaults(widgetInfo.metadata.settings);
                const defaults = {...schemaDefaults, ...(instance.getDefaultSettings?.() ?? {})};
                WidgetSettings.applyDefaults(settings, defaults);
            }
            actor = instance.buildActor();
            if (!actor)
                throw new Error('buildActor() returned null/undefined');
            await this._enforceBlockSize(widgetInfo, actor);
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

        const newEntry = {...widgetInfo, ModuleClass, instance, actor, settings};
        this._instances.set(widgetId, newEntry);
        this._logger.log?.(`[widget-loader] hot-reloaded "${widgetId}"`);
        // No need to re-register the settings watch (task 08 hot-reload
        // keeps the same widgetId/file path throughout) — the existing
        // watch from loadOne() already looks entries up fresh from
        // `_instances` each time it fires, so it picks up this new
        // instance/settings proxy automatically. See loadOne()'s watch()
        // callback and its doc comment.
        return newEntry;
    }

    _recordError(widgetInfo, reason) {
        this._errors.push({id: widgetInfo.id, path: widgetInfo.path, reason});
        this._logger.warn?.(`[widget-loader] "${widgetInfo.id}": ${reason}`);
    }

    // Locks widgetInfo's actor to the pixel size implied by its own
    // metadata.json `block-type` (falls back to DEFAULT_BLOCK_TYPE if the
    // field is omitted) and clips every child exactly at that allocation.
    // Text, icons, images, and shadows must never extend outside the
    // widget background or declared block footprint. This is deliberately
    // enforced here —
    // once, centrally — rather than left to each widget.js to hand-roll
    // correctly. Relying on every widget
    // author (bundled or third-party) to independently compute
    // cols*BLOCK_CELL_SIZE and remember clip_to_allocation is exactly how
    // calendar-header ended up overflowing its box in the first place;
    // one widget getting it wrong (or a new widget copy-pasting an old
    // template that never had it) reintroduces the same bug. Using
    // GjsKit's StWidgetWrapper here (rather than poking Clutter/St
    // properties directly) also means bundled AND third-party widgets
    // built with GjsKit get the exact same size()/clip() semantics the
    // host uses on them.
    //
    // Bug fix (2026-07-26): this used to compute cols/rows itself via
    // `Number(blockType.cols) || DEFAULT_BLOCK_TYPE.cols` - which let a
    // NEGATIVE value straight through (`Number(-5)` is truthy, so `-5 ||
    // 10` evaluates to `-5`, not the fallback), had no upper bound at
    // all, and didn't round non-integers. That was a second, slightly
    // different copy of the same validation blockSizeManager.js already
    // does properly - now calls BlockSizeManager.getBlockSizeFor()
    // instead so there's exactly one place block-type gets sanitized,
    // and this actor gets the same clamped, validated size
    // extension.js's own BlockSizeManager.applyBlockSize() call already
    // guarantees for the Shell-side actor.
    async _enforceBlockSize(widgetInfo, actor) {
        const {cols, rows} = BlockSizeManager.getBlockSizeFor(widgetInfo.metadata);
        try {
            // Lazy import — see the note above the imports at the top of
            // this file for why StWidget.js can't be a static import here.
            const {StWidgetWrapper} = await import('./gjskit/st/StWidget.js');
            new StWidgetWrapper(actor)
                .size(cols * BLOCK_CELL_SIZE, rows * BLOCK_CELL_SIZE)
                .clip(true);
        } catch (e) {
            this._recordError(widgetInfo, `failed to enforce block-type size: ${e.message}`);
        }
    }

    // 2026-07-28 (closes the task 04/07 TODO that used to live here):
    // WidgetLayer/DragController only ever call
    // StorageService.updateWidgetPosition() on DROP, never per-frame
    // during the drag itself (see dragController.js/widgetLayer.js's own
    // comments to that effect) - so a widget's `api.position` doesn't
    // need any new event/signal plumbing to be "live". Reading straight
    // through to the SAME StorageService instance WidgetLayer just wrote
    // to (both live in this one Shell process) is enough: the very next
    // access after a drop already sees the new x/y, with no caching layer
    // of our own to go stale. Returns the {x:0,y:0,setPosition(){}} shape
    // this always had when no StorageService is available (e.g. a future
    // caller that builds a WidgetLoader without one), so this is a
    // behavior-preserving change for that case.
    _buildPositionApi(widgetInfo) {
        const storageService = this._storageService;
        if (!storageService)
            return {x: 0, y: 0, monitorIndex: 0, setPosition() {}};

        return {
            get x() {
                return storageService.getWidgetPosition(widgetInfo.id)?.x ?? 0;
            },
            get y() {
                return storageService.getWidgetPosition(widgetInfo.id)?.y ?? 0;
            },
            get monitorIndex() {
                return storageService.getWidgetPosition(widgetInfo.id)?.monitorIndex ?? 0;
            },
            /**
             * @param {number} x
             * @param {number} y
             * @param {number} [monitorIndex=0]
             */
            setPosition(x, y, monitorIndex = 0) {
                storageService.updateWidgetPosition(widgetInfo.id, x, y, monitorIndex);
            },
        };
    }

    _buildApi(widgetInfo, settings) {
        const hostSettings = this._hostSettings;
        return {
            settings,
            monitorInfo: null,
            position: this._buildPositionApi(widgetInfo),
            bus: {emit() {}, on() {}, off() {}},
            // A getter, not a plain string snapshot - always reads the
            // CURRENT GSettings value, so it's never stale even for a
            // widget that only reads it once during a re-render
            // triggered by something else (see notifyHostLanguageChanged()
            // above for actively pushing a change instead of waiting for
            // that). '' means "no override, use system locale" - same
            // meaning as the gschema key's own default.
            get hostLanguage() {
                return hostSettings?.isReady ? (hostSettings.getGlobalValue('language') || '') : '';
            },
            path: {
                // Absolute path to this widget's own folder on disk - e.g.
                // for reading a bundled asset (icons/, a template file)
                // that lives alongside widget.js. Always a plain string,
                // never null - a widget only reaches buildActor() (and
                // therefore ever sees an `api`) after discover() has
                // already resolved its folder.
                me: widgetInfo.path,
                // Absolute path to another widget's folder by id, e.g. for
                // one widget to read an asset shipped by another - falls
                // back to a fresh discover() if called before this
                // WidgetLoader's first discover() (id -> path cache not
                // populated yet), same lookup either way. Returns null if
                // no widget with that id exists.
                id: otherId => {
                    if (otherId === widgetInfo.id)
                        return widgetInfo.path;
                    if (!this._pathById)
                        this.discover();
                    return this._pathById.get(otherId) ?? null;
                },
            },
            logger: {
                info: (...args) => console.log(`[${widgetInfo.id}]`, ...args),
                warn: (...args) => console.warn(`[${widgetInfo.id}]`, ...args),
                error: (...args) => console.error(`[${widgetInfo.id}]`, ...args),
            },
        };
    }
}
