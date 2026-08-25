import GLib from "gi://GLib";

import Gio from "gi://Gio";

import { fileExists } from "./fsUtils.js";

// St-free (only pulls in Pango), so - unlike cardLayers.js - this is safe
// to import statically even though WidgetLoader is also loaded by the
// standalone GTK4 prefs process (see _ensureCardPainted()'s header comment).
import { deferUntilMapped } from "./widgetVisualKit.js";

import { WidgetSettings } from "./widgetSettings.js";

import { validateSettingsSchema, getSchemaDefaults } from "./settingsSchema.js";

import { readWidgetConfig } from "./widgetConfigReader.js";

import { getConfigDefaults } from "./widgetConfigValidator.js";

import { SettingsWatcher } from "./settingsWatcher.js";

import { BlockSizeManager, BLOCK_CELL_SIZE } from "./blockSizeManager.js";

const REQUIRED_METADATA_FIELDS = [ "id", "name", "entry" ];

export class WidgetLoader {
    constructor(searchPaths, storageService = null, logger = console, shadowOverflowMargin = 0, hostSettings = null, themeService = null, onRescanRequested = null) {
        this._searchPaths = searchPaths;
        this._storageService = storageService;
        this._logger = logger;
        this._instances = new Map;
        this._errors = [];
        // Optional host-provided callback so a widget's own `api.host.rescan()`
        // (see _buildApi() below) can ask the host to discover + load any
        // widget directories that showed up on disk since the last load,
        // without the loader needing to know anything about the host's
        // layer/placement logic itself. Used by Architect Widgets (see
        // lib/architectWidgetKit.js) right after writing a new Child's
        // files, but generic to any widget that creates files on disk.
        this._onRescanRequested = onRescanRequested;
        this._shadowOverflowMargin = Math.max(0, Number(shadowOverflowMargin) || 0);
        this._hostSettings = hostSettings;
        this._themeService = themeService;
        this._settingsWatcher = storageService ? new SettingsWatcher(storageService) : null;
    }
    notifyHostLanguageChanged(language) {
        for (const entry of this._instances.values()) {
            try {
                entry.instance.onHostLanguageChanged?.(language);
            } catch (e) {
                this._logger.error?.(`[widget-loader] "${entry.id}".onHostLanguageChanged() threw`, e);
            }
        }
    }
    get shadowOverflowMargin() {
        return this._shadowOverflowMargin;
    }
    set shadowOverflowMargin(value) {
        this._shadowOverflowMargin = Math.max(0, Number(value) || 0);
        for (const [id, entry] of this._instances) {
            if (!entry.actor) continue;
            this._enforceBlockSize(entry, entry.actor).catch(e => this._logger.warn?.(`[widget-loader] "${id}": failed to re-clip after widget-spacing change: ${e.message}`));
        }
    }
    get errors() {
        return this._errors;
    }
    get instances() {
        return Array.from(this._instances.values());
    }
    discover() {
        const found = new Map;
        this._errors = [];
        for (const basePath of this._searchPaths) {
            const dir = Gio.File.new_for_path(basePath);
            let enumerator;
            try {
                enumerator = dir.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                continue;
            }
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue;
                const folderName = info.get_name();
                if (folderName.startsWith("_")) continue;
                const widgetDir = dir.get_child(folderName);
                const widgetPath = widgetDir.get_path();
                const metadataFile = widgetDir.get_child("metadata.json");
                let metadata;
                try {
                    metadata = this._readMetadata(metadataFile);
                } catch (e) {
                    this._recordError({
                        id: folderName,
                        path: widgetPath
                    }, `invalid metadata.json: ${e.message}`);
                    continue;
                }
                const missing = REQUIRED_METADATA_FIELDS.filter(field => !(field in metadata));
                if (missing.length > 0) {
                    this._recordError({
                        id: metadata.id ?? folderName,
                        path: widgetPath
                    }, `metadata.json missing required field(s): ${missing.join(", ")}`);
                    continue;
                }
                if (found.has(metadata.id)) {
                    this._recordError({
                        id: metadata.id,
                        path: widgetPath
                    }, `duplicate widget id, already loaded from ${found.get(metadata.id).path}`);
                    continue;
                }
                const settingsProblems = validateSettingsSchema(metadata.settings);
                if (settingsProblems.length > 0) {
                    this._recordError({
                        id: metadata.id,
                        path: widgetPath
                    }, `invalid "settings" schema: ${settingsProblems.join("; ")}`);
                    continue;
                }
                found.set(metadata.id, {
                    id: metadata.id,
                    metadata: metadata,
                    path: widgetPath
                });
            }
        }
        this._pathById = new Map(Array.from(found.values(), w => [ w.id, w.path ]));
        return Array.from(found.values());
    }
    _readMetadata(metadataFile) {
        if (!metadataFile.query_exists(null)) throw new Error("metadata.json not found");
        const [ok, contents] = metadataFile.load_contents(null);
        if (!ok) throw new Error("could not read metadata.json");
        return JSON.parse(new TextDecoder("utf-8").decode(contents));
    }
    async loadModule(widgetInfo) {
        const entry = widgetInfo.metadata.entry ?? "widget.js";
        const entryPath = GLib.build_filenamev([ widgetInfo.path, entry ]);
        if (!fileExists(entryPath)) {
            this._recordError(widgetInfo, `entry file "${entry}" not found`);
            return null;
        }
        try {
            const module = await (import(`file://${entryPath}`));
            if (typeof module.default !== "function") {
                this._recordError(widgetInfo, `${entry} has no default export class`);
                return null;
            }
            return module.default;
        } catch (e) {
            this._recordError(widgetInfo, `failed to import ${entry}: ${e.message}`);
            return null;
        }
    }
    async loadAll(disabledIds = new Set) {
        const widgets = this.discover().filter(w => !disabledIds.has(w.id));
        const started = [];
        for (const widgetInfo of widgets) {
            const entry = await this.loadOne(widgetInfo);
            if (entry) started.push(entry);
        }
        return started;
    }
    // Reads widgets/<id>/config.json (the settings-PANEL schema - tabs of
    // fields with a `default` each, distinct from metadata.json's flatter
    // "settings" array) and flattens every field's `default` into a plain
    // {fieldId: value} map, so those defaults can be merged into a
    // widget's actual persisted settings rather than only ever being used
    // as a display fallback when rendering the settings panel.
    _configJsonDefaults(widgetInfo) {
        try {
            const { config } = readWidgetConfig(widgetInfo.path);
            return config ? getConfigDefaults(config) : {};
        } catch (e) {
            this._logger.warn?.(`[widget-loader] "${widgetInfo.id}": could not read config.json defaults: ${e.message}`);
            return {};
        }
    }
    // Merges config.json defaults + metadata.json "settings" defaults +
    // the widget's own getDefaultSettings(), then applies whichever of
    // those keys are still missing from `settings` (WidgetSettings.
    // applyDefaults() only fills in keys that don't already exist - it
    // never overwrites a real saved/user value). Called both at initial
    // widget load and after WidgetSettings.reloadFromDisk(), so that a
    // Reset (which deletes the widget's settings file and lets
    // reloadFromDisk() sync the live settings object down to the now-empty
    // disk file) ends up restored to defaults rather than left with a
    // genuinely empty settings object.
    _applyDefaults(widgetInfo, instance, settings) {
        try {
            const configJsonDefaults = this._configJsonDefaults(widgetInfo);
            const schemaDefaults = getSchemaDefaults(widgetInfo.metadata.settings);
            const defaults = {
                ...configJsonDefaults,
                ...schemaDefaults,
                ...instance?.getDefaultSettings?.() ?? {}
            };
            WidgetSettings.applyDefaults(settings, defaults);
        } catch (e) {
            this._recordError(widgetInfo, `getDefaultSettings() threw: ${e.message}`);
        }
    }
    // Safety net for the "createLayeredCard() but never actually calls
    // applyLayeredCardStyle() in _render()" bug class (this is exactly
    // what happened to geek-stat-clock before it got fixed by hand). Never
    // overrides a widget that already painted its own card layer — St's
    // get_style() comes back non-empty the moment a widget's own _render()
    // has called applyLayeredCardStyle()/set_style() on layers.card.
    //
    // That paint doesn't necessarily happen synchronously inside
    // buildActor() though: the established convention for a widget's
    // _render() is to wrap its applyLayeredCardStyle() call in
    // deferUntilMapped(this._actor, ...), which - per its own contract -
    // only runs immediately if the actor is *already* mapped, and
    // otherwise waits for 'notify::mapped'. The actor is never mapped yet
    // at the point loadOne() calls this (it's called right after
    // buildActor() returns, before the caller has added the actor to any
    // container - see extension.js's loadAll().then()), so for every
    // widget using that convention this check used to run before the
    // real paint ever had a chance to fire, tripping a false-positive
    // warning and clobbering the widget's own styling (icon-accent
    // colors, etc.) with raw defaults in the process.
    //
    // Fix: piggyback on the exact same 'notify::mapped' event instead of
    // checking synchronously now. A widget's own deferUntilMapped() call
    // is wired up inside buildActor(), which already returned by the time
    // loadOne() reaches this method - so our listener is always connected
    // *after* the widget's, and GObject fires connected handlers in
    // connection order. That guarantees a well-behaved widget's real
    // paint has already run by the time our check does, so get_style()
    // is no longer empty and this is a no-op for it. Only a widget that
    // truly never calls applyLayeredCardStyle() at all still falls
    // through to the warning + default-paint fallback below.
    //
    // cardLayers.js is still imported lazily (dynamic import) because it
    // pulls in St, whose typelib only resolves inside the gnome-shell
    // process - WidgetLoader is also loaded by the standalone prefs app
    // (widget-center-prefs-app.js, run under plain `gjs -m`), which only
    // ever calls discover(), never loadOne(), but a static
    // `import St from "gi://St"` anywhere in the module graph throws at
    // import time regardless of whether it's used, crashing the whole
    // prefs process before it can open a window. deferUntilMapped() comes
    // from widgetVisualKit.js instead, which only pulls in Pango, so it's
    // safe as a static top-of-file import in both processes.
    _ensureCardPainted(widgetInfo, instance, settings) {
        const card = instance?._layers?.card;
        const actor = instance?._actor ?? instance?._layers?.root;
        if (!card || !actor) return;
        deferUntilMapped(actor, () => {
            (async () => {
                try {
                    if (card.get_style()) return;
                    const { applyLayeredCardStyle: applyLayeredCardStyle } = await import("./cardLayers.js");
                    applyLayeredCardStyle(instance._layers, settings);
                    this._logger.warn?.(`[widget-loader] "${widgetInfo.id}": never called applyLayeredCardStyle() in _render() — painted its card with defaults instead. Add the call in the widget's own _render().`);
                } catch (e) {
                    this._recordError(widgetInfo, `_ensureCardPainted() failed: ${e.message}`);
                }
            })();
        });
    }
    async loadOne(widgetInfo) {
        if (this._instances.has(widgetInfo.id)) return this._instances.get(widgetInfo.id);
        const ModuleClass = await this.loadModule(widgetInfo);
        if (!ModuleClass) return null;
        const settings = this._storageService ? WidgetSettings.load(widgetInfo.id, this._storageService) : {};
        const api = this._buildApi(widgetInfo, settings);
        let instance;
        try {
            instance = new ModuleClass(api);
        } catch (e) {
            this._recordError(widgetInfo, `constructor threw: ${e.message}`);
            return null;
        }
        if (this._storageService) this._applyDefaults(widgetInfo, instance, settings);
        let actor;
        try {
            actor = instance.buildActor();
            if (!actor) {
                this._recordError(widgetInfo, "buildActor() returned null/undefined");
                return null;
            }
        } catch (e) {
            this._recordError(widgetInfo, `buildActor() threw: ${e.message}`);
            return null;
        }
        // Not awaited: for any widget using the deferUntilMapped() paint
        // convention this now genuinely waits on 'notify::mapped', which
        // won't fire until well after loadOne() (and loadAll()) return -
        // see this method's own header comment. It's a warn-only safety
        // net, not something later steps depend on, so it runs in the
        // background instead of blocking the rest of the load pipeline.
        this._ensureCardPainted(widgetInfo, instance, settings);
        await this._enforceBlockSize(widgetInfo, actor);
        try {
            instance.enable?.();
        } catch (e) {
            this._recordError(widgetInfo, `enable() threw: ${e.message}`);
        }
        const entry = {
            ...widgetInfo,
            ModuleClass: ModuleClass,
            instance: instance,
            actor: actor,
            settings: api.settings
        };
        this._instances.set(widgetInfo.id, entry);
        this._logger.log?.(`[widget-loader] loaded "${widgetInfo.id}" from ${widgetInfo.path}`);
        this._settingsWatcher?.watch(widgetInfo.id, () => {
            const changed = WidgetSettings.reloadFromDisk(widgetInfo.id, this._storageService);
            if (!changed) return;
            const current = this._instances.get(widgetInfo.id);
            // reloadFromDisk() is a pure disk-sync - it deletes any key
            // no longer present in the file (which is every key, right
            // after a Reset deletes the file entirely) and applies no
            // defaults of its own. Re-fill anything now missing the same
            // way initial load does, or Reset leaves the widget with a
            // genuinely empty settings object. applyDefaults() only fills
            // keys that are still absent, so this never overwrites a
            // value that legitimately came from the disk sync.
            if (this._storageService) this._applyDefaults(widgetInfo, current?.instance, settings);
            try {
                current?.instance.onSettingsChanged?.(current.settings);
            } catch (e) {
                this._logger.error?.(`[widget-loader] "${widgetInfo.id}" onSettingsChanged() threw: ${e.message}`);
            }
        });
        return entry;
    }
    unloadAll() {
        WidgetSettings.flushAll();
        for (const id of Array.from(this._instances.keys())) this._unloadOneInternal(id);
        this._settingsWatcher?.unwatchAll();
    }
    unloadOne(widgetId) {
        if (!this._instances.has(widgetId)) return;
        WidgetSettings.flush(widgetId);
        this._unloadOneInternal(widgetId);
    }
    _unloadOneInternal(id) {
        const entry = this._instances.get(id);
        if (!entry) return;
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
    async reloadWidget(widgetId) {
        const oldEntry = this._instances.get(widgetId);
        if (!oldEntry) {
            this._logger.warn?.(`[widget-loader] reloadWidget("${widgetId}") — not currently loaded`);
            return null;
        }
        const widgetInfo = {
            id: oldEntry.id,
            metadata: oldEntry.metadata,
            path: oldEntry.path
        };
        let ModuleClass;
        try {
            const entryName = widgetInfo.metadata.entry ?? "widget.js";
            const entryPath = GLib.build_filenamev([ widgetInfo.path, entryName ]);
            if (!fileExists(entryPath)) throw new Error(`entry file "${entryName}" not found`);
            const module = await (import(`file://${entryPath}?t=${Date.now()}`));
            if (typeof module.default !== "function") throw new Error(`${entryName} has no default export class`);
            ModuleClass = module.default;
        } catch (e) {
            this._logger.error?.(`[widget-loader] "${widgetId}" hot-reload import failed: ${e.message} — keeping previous version running`);
            return null;
        }
        const settings = this._storageService ? WidgetSettings.load(widgetId, this._storageService) : {};
        const api = this._buildApi(widgetInfo, settings);
        let instance, actor;
        try {
            instance = new ModuleClass(api);
            if (this._storageService) this._applyDefaults(widgetInfo, instance, settings);
            actor = instance.buildActor();
            if (!actor) throw new Error("buildActor() returned null/undefined");
            await this._ensureCardPainted(widgetInfo, instance, settings);
            await this._enforceBlockSize(widgetInfo, actor);
        } catch (e) {
            this._logger.error?.(`[widget-loader] "${widgetId}" hot-reload build failed: ${e.message} — keeping previous version running`);
            return null;
        }
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
        const newEntry = {
            ...widgetInfo,
            ModuleClass: ModuleClass,
            instance: instance,
            actor: actor,
            settings: api.settings
        };
        this._instances.set(widgetId, newEntry);
        this._logger.log?.(`[widget-loader] hot-reloaded "${widgetId}"`);
        return newEntry;
    }
    _recordError(widgetInfo, reason) {
        this._errors.push({
            id: widgetInfo.id,
            path: widgetInfo.path,
            reason: reason
        });
        this._logger.warn?.(`[widget-loader] "${widgetInfo.id}": ${reason}`);
    }
    async _enforceBlockSize(widgetInfo, actor) {
        const {cols: cols, rows: rows} = BlockSizeManager.getBlockSizeFor(widgetInfo.metadata);
        try {
            const width = cols * BLOCK_CELL_SIZE;
            const height = rows * BLOCK_CELL_SIZE;
            actor.set_size(width, height);
            const margin = Math.max(0, Number(this._shadowOverflowMargin) || 0);
            if (margin === 0) {
                actor.remove_clip();
                actor.clip_to_allocation = true;
            } else {
                actor.clip_to_allocation = false;
                actor.set_clip(-margin, -margin, width + margin * 2, height + margin * 2);
            }
        } catch (e) {
            this._recordError(widgetInfo, `failed to enforce block-type size: ${e.message}`);
        }
    }
    _buildPositionApi(widgetInfo) {
        const storageService = this._storageService;
        if (!storageService) return {
            x: 0,
            y: 0,
            monitorIndex: 0,
            setPosition() {}
        };
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
            setPosition(x, y, monitorIndex = 0) {
                storageService.updateWidgetPosition(widgetInfo.id, x, y, monitorIndex);
            }
        };
    }
    _buildApi(widgetInfo, settings) {
        const hostSettings = this._hostSettings;
        
        return {
            settings: settings,
            // Every widget always manages its own card styling from its
            // own settings — there's no more "Force Settings"/"themeable"
            // system that can override a widget's background/corner-radius/
            // blur/shadow from a global switch. The one thing that's still
            // shared globally is the shadow's angle/distance (see
            // widgetVisualKit.js's shadowBoxShadowCss() and
            // lib/globalShadowHelper.js) — everything else always comes
            // straight from the widget's own config.json/settings.
            monitorInfo: null,
            position: this._buildPositionApi(widgetInfo),
            host: {
                // Best-effort: discover + load any newly-appeared widget
                // directory (e.g. one this widget just created on disk)
                // and place it in the running layer. No-op if the host
                // didn't wire a callback (older host build, or a widget
                // being loaded outside the normal extension - e.g. a
                // future test harness). Never throws into caller code.
                rescan: () => {
                    try {
                        this._onRescanRequested?.();
                    } catch (e) {
                        this._logger.error?.(`[widget-loader] "${widgetInfo.id}": api.host.rescan() callback threw`, e);
                    }
                }
            },
            bus: {
                emit() {},
                on() {},
                off() {}
            },
            get hostLanguage() {
                return hostSettings?.isReady ? hostSettings.getGlobalValue("language") || "" : "";
            },
            path: {
                me: widgetInfo.path,
                id: otherId => {
                    if (otherId === widgetInfo.id) return widgetInfo.path;
                    if (!this._pathById) this.discover();
                    return this._pathById.get(otherId) ?? null;
                }
            },
            logger: {
                // Gated behind Development Mode, same as every other
                // routine/debug-level log in the extension - a widget
                // calling `this._api.logger.info(...)` during normal
                // operation (e.g. "no Bluetooth adapter found") shouldn't
                // keep writing to the journal once Development Mode is
                // switched off. warn/error stay unconditional since those
                // indicate an actual problem the widget hit.
                info: (...args) => {
                    if (hostSettings?.isReady && hostSettings.getGlobalValue("dev-mode")) console.log(`[${widgetInfo.id}]`, ...args);
                },
                warn: (...args) => console.warn(`[${widgetInfo.id}]`, ...args),
                error: (...args) => console.error(`[${widgetInfo.id}]`, ...args)
            }
        };
    }
}