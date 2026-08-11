import GLib from "gi://GLib";

import Gio from "gi://Gio";

import { fileExists } from "./fsUtils.js";

import { WidgetSettings } from "./widgetSettings.js";

import { validateSettingsSchema, getSchemaDefaults } from "./settingsSchema.js";

import { SettingsWatcher } from "./settingsWatcher.js";

import { BlockSizeManager, BLOCK_CELL_SIZE } from "./blockSizeManager.js";

const REQUIRED_METADATA_FIELDS = [ "id", "name", "entry" ];

export class WidgetLoader {
    constructor(searchPaths, storageService = null, logger = console, shadowOverflowMargin = 0, hostSettings = null, themeService = null) {
        this._searchPaths = searchPaths;
        this._storageService = storageService;
        this._logger = logger;
        this._instances = new Map;
        this._errors = [];
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
        if (this._storageService) {
            try {
                const schemaDefaults = getSchemaDefaults(widgetInfo.metadata.settings);
                const defaults = {
                    ...schemaDefaults,
                    ...instance.getDefaultSettings?.() ?? {}
                };
                WidgetSettings.applyDefaults(settings, defaults);
            } catch (e) {
                this._recordError(widgetInfo, `getDefaultSettings() threw: ${e.message}`);
            }
        }
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
            settings: api.settings // Use the Proxy-wrapped settings from the api object
        };
        this._instances.set(widgetInfo.id, entry);
        this._logger.log?.(`[widget-loader] loaded "${widgetInfo.id}" from ${widgetInfo.path}`);
        this._settingsWatcher?.watch(widgetInfo.id, () => {
            const changed = WidgetSettings.reloadFromDisk(widgetInfo.id, this._storageService);
            if (!changed) return;
            const current = this._instances.get(widgetInfo.id);
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
            if (this._storageService) {
                const schemaDefaults = getSchemaDefaults(widgetInfo.metadata.settings);
                const defaults = {
                    ...schemaDefaults,
                    ...instance.getDefaultSettings?.() ?? {}
                };
                WidgetSettings.applyDefaults(settings, defaults);
            }
            actor = instance.buildActor();
            if (!actor) throw new Error("buildActor() returned null/undefined");
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
            settings: api.settings // Use the Proxy-wrapped settings from the api object
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
            const {StWidgetWrapper: StWidgetWrapper} = await (import("./gjskit/st/StWidget.js"));
            new StWidgetWrapper(actor).size(cols * BLOCK_CELL_SIZE, rows * BLOCK_CELL_SIZE).clip(true, this._shadowOverflowMargin);
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
        
        // Check whether this widget should be forced to ignore Force Settings
        const shouldIgnoreForce = !widgetInfo.metadata?.["themeable"] && !widgetInfo.metadata?.["forceSettingsAware"];
        
        // Wrap the settings object in a Proxy to intercept reads for the __ignoreForce flag
        const wrappedSettings = new Proxy(settings, {
            get(target, prop) {
                if (prop === "__ignoreForce") return shouldIgnoreForce;
                return target[prop];
            }
        });
        
        return {
            settings: wrappedSettings,
            // `themeable` controls regular ThemeService styling only. Force
            // Settings remain global and apply to both themeable and
            // self-styled widgets.
            themeable: !!widgetInfo.metadata?.["themeable"],
            // For themeable widgets that also need to run their own
            // periodic/content _render() (clock ticks, stat refreshes,
            // settings changes) on the SAME actor ThemeService styles:
            // St's set_style() replaces the whole inline style rather than
            // merging, so the widget must fold ThemeService's resolved CSS
            // into its own set_style() call instead of calling cardStyleCss()
            // independently — otherwise whichever call runs last wins and
            // silently drops the other (Force Settings reverting, the
            // box-sizing fix disappearing, or the two configs flapping).
            // Returns null (not "") when there's no ThemeService yet, or
            // when the widget isn't themeable, so callers can tell "no CSS"
            // apart from "empty CSS".
            resolveCardCss: () => this._themeService && widgetInfo.metadata?.["themeable"] ? this._themeService.computeWidgetStyleCss(widgetInfo.id) : null,
            monitorInfo: null,
            position: this._buildPositionApi(widgetInfo),
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