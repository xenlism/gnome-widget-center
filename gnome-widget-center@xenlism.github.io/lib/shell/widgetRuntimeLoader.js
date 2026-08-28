import GLib from "gi://GLib";

import { fileExists } from "../fsUtils.js";

import { deferUntilMapped } from "../widgetVisualKit.js";

import { WidgetSettings } from "../widgetSettings.js";

import { getSchemaDefaults } from "../settingsSchema.js";

import { readWidgetConfig, invalidateWidgetConfigCache } from "../widgetConfigReader.js";

import { getConfigDefaults } from "../widgetConfigValidator.js";

import { SettingsWatcher } from "../settingsWatcher.js";

import { BlockSizeManager, BLOCK_CELL_SIZE } from "../blockSizeManager.js";

import { WidgetLoader } from "../widgetLoader.js";

// Shell-only widget runtime: instantiates widget.js modules into live actors.
// This is the ONLY place allowed to (dynamically) import ./cardLayers.js,
// since that pulls in St/Clutter/Shell. Keep it out of lib/widgetLoader.js so
// the prefs process (which only needs WidgetLoader.discover()) never reaches it.
export class WidgetRuntimeLoader extends WidgetLoader {
    constructor(searchPaths, storageService = null, logger = console, shadowOverflowMargin = 0, hostSettings = null, themeService = null, onRescanRequested = null) {
        super(searchPaths);
        this._storageService = storageService;
        this._logger = logger;
        this._instances = new Map;
        this._onRescanRequested = onRescanRequested;
        this._shadowOverflowMargin = Math.max(0, Number(shadowOverflowMargin) || 0);
        this._hostSettings = hostSettings;
        this._themeService = themeService;
        this._settingsWatcher = storageService ? new SettingsWatcher(storageService) : null;
    }
    _recordError(widgetInfo, reason) {
        super._recordError(widgetInfo, reason);
        this._logger.warn?.(`[widget-loader] "${widgetInfo.id}": ${reason}`);
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
    get instances() {
        return Array.from(this._instances.values());
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
        const widgets = (await this.discover()).filter(w => !disabledIds.has(w.id));
        const started = [];
        for (const widgetInfo of widgets) {
            const entry = await this.loadOne(widgetInfo);
            if (entry) started.push(entry);
        }
        return started;
    }
    _configJsonDefaults(widgetInfo) {
        try {
            const { config } = readWidgetConfig(widgetInfo.path);
            return config ? getConfigDefaults(config) : {};
        } catch (e) {
            this._logger.warn?.(`[widget-loader] "${widgetInfo.id}": could not read config.json defaults: ${e.message}`);
            return {};
        }
    }
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
            // Opt-in async construction (EGO-X-004): widgets that need to
            // read something async before their constructor body runs
            // (currently xtile/geek-architect, reading their own
            // metadata.json) expose a static createInstance(); every other
            // widget has no such method and is built exactly as before.
            instance = typeof ModuleClass.createInstance === "function" ? await ModuleClass.createInstance(api) : new ModuleClass(api);
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
        // Hot-reload's whole point is picking up on-disk edits, and that
        // now includes config.json (readWidgetConfig() caches by path since
        // this round's EGO-X-004 pass — see widgetConfigReader.js), not
        // just the widget.js re-import a few lines down.
        invalidateWidgetConfigCache(oldEntry.path);
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
            // Same opt-in async construction as loadOne() above (EGO-X-004).
            instance = typeof ModuleClass.createInstance === "function" ? await ModuleClass.createInstance(api) : new ModuleClass(api);
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
            monitorInfo: null,
            position: this._buildPositionApi(widgetInfo),
            host: {
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
                    if (!this._pathById) {
                        // discover() is async now (EGO-X-004); by the time widgets
                        // are actually running, loadAll()/loadOne() has already
                        // awaited discover() at least once and populated
                        // _pathById. This is only a defensive fallback for a
                        // widget calling api.path.id() unusually early - it can't
                        // block synchronously, so it kicks off a background
                        // discover() (for next time) and returns null for now.
                        this.discover().catch(e => this._logger?.error?.("widgetRuntimeLoader: background discover() failed", e));
                        return null;
                    }
                    return this._pathById.get(otherId) ?? null;
                }
            },
            logger: {
                info: (...args) => {
                    if (hostSettings?.isReady && hostSettings.getGlobalValue("dev-mode")) console.log(`[${widgetInfo.id}]`, ...args);
                },
                warn: (...args) => console.warn(`[${widgetInfo.id}]`, ...args),
                error: (...args) => console.error(`[${widgetInfo.id}]`, ...args)
            }
        };
    }
}
