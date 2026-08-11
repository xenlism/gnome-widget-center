import Gio from "gi://Gio";

const MANIFEST_FILENAME = "theme.json";

const REQUIRED_FIELDS = [ "id", "name", "widgets" ];

const FLAT_FILE_EXTENSION = ".gwct";

const ENUM_ATTRS = "standard::name,standard::type,time::modified";

export class ThemePackRegistry {
    constructor(searchPaths) {
        this._searchPaths = (searchPaths ?? []).map(entry => typeof entry === "string" ? {
            path: entry,
            source: "bundled"
        } : {
            path: entry.path,
            source: entry.source ?? "bundled"
        });
        this._lastErrors = [];
    }
    get lastErrors() {
        return this._lastErrors;
    }
    discover() {
        const found = new Map;
        this._lastErrors = [];
        for (const {path: searchPath, source: source} of this._searchPaths) {
            const dir = Gio.File.new_for_path(searchPath);
            if (!dir.query_exists(null)) continue;
            let enumerator;
            try {
                enumerator = dir.enumerate_children(ENUM_ATTRS, Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                this._recordError({
                    id: "(unknown)",
                    path: searchPath
                }, `could not enumerate: ${e.message}`);
                continue;
            }
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.startsWith("_")) continue;
                if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                    this._discoverFolderPack(dir, name, info, source, found);
                } else if (info.get_file_type() === Gio.FileType.REGULAR && name.endsWith(FLAT_FILE_EXTENSION)) {
                    this._discoverFlatPack(dir, name, info, source, found);
                }
            }
        }
        return [ ...found.values() ];
    }
    _discoverFolderPack(dir, folderName, info, source, found) {
        const packDir = dir.get_child(folderName);
        const packPath = packDir.get_path();
        const manifestFile = packDir.get_child(MANIFEST_FILENAME);
        let manifest;
        try {
            manifest = this._readJson(manifestFile);
        } catch (e) {
            this._recordError({
                id: folderName,
                path: packPath
            }, `invalid ${MANIFEST_FILENAME}: ${e.message}`);
            return;
        }
        const missing = REQUIRED_FIELDS.filter(field => !(field in manifest));
        if (missing.length > 0) {
            this._recordError({
                id: manifest.id ?? folderName,
                path: packPath
            }, `${MANIFEST_FILENAME} missing required field(s): ${missing.join(", ")}`);
            return;
        }
        this._addFound(found, {
            id: manifest.id,
            path: packPath,
            manifest: manifest,
            source: source,
            mtimeUnix: this._mtimeUnix(info),
            widgetCount: Array.isArray(manifest.widgets) ? manifest.widgets.length : 0
        });
    }
    _discoverFlatPack(dir, fileName, info, source, found) {
        const file = dir.get_child(fileName);
        const filePath = file.get_path();
        const baseName = fileName.slice(0, -FLAT_FILE_EXTENSION.length);
        let raw;
        try {
            raw = this._readJson(file);
        } catch (e) {
            this._recordError({
                id: baseName,
                path: filePath
            }, `invalid ${FLAT_FILE_EXTENSION}: ${e.message}`);
            return;
        }
        if (raw.format !== "gwct") {
            this._recordError({
                id: baseName,
                path: filePath
            }, `not a recognized ${FLAT_FILE_EXTENSION} file (unexpected format)`);
            return;
        }
        const widgetIds = Array.isArray(raw.widgets) ? raw.widgets.map(w => typeof w === "string" ? w : w?.id).filter(Boolean) : [];
        const packMeta = raw.packMeta ?? {};
        const id = packMeta.id || baseName;
        const manifest = {
            id: id,
            name: packMeta.name || baseName,
            description: packMeta.description ?? "",
            author: packMeta.author ?? "",
            email: packMeta.email ?? "",
            url: packMeta.url ?? "",
            screenshotBase64: raw.screenshot?.base64 ?? null,
            screenshotMime: raw.screenshot?.mimeType ?? null,
            widgets: widgetIds
        };
        this._addFound(found, {
            id: id,
            path: filePath,
            manifest: manifest,
            source: source,
            document: raw,
            mtimeUnix: this._mtimeUnix(info),
            widgetCount: widgetIds.length
        });
    }
    _addFound(found, entry) {
        if (found.has(entry.id)) {
            this._recordError({
                id: entry.id,
                path: entry.path
            }, `duplicate theme pack id, already loaded from ${found.get(entry.id).path}`);
            return;
        }
        found.set(entry.id, entry);
    }
    _mtimeUnix(info) {
        try {
            const dt = info.get_modification_date_time?.();
            if (dt) return dt.to_unix();
        } catch (e) {}
        try {
            return Number(info.get_attribute_uint64("time::modified")) || 0;
        } catch (e) {
            return 0;
        }
    }
    _readJson(file) {
        if (!file.query_exists(null)) throw new Error("file not found");
        const [ok, contents] = file.load_contents(null);
        if (!ok) throw new Error("could not read file");
        const text = new TextDecoder("utf-8").decode(contents);
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error(`malformed JSON: ${e.message}`);
        }
    }
    _recordError(context, message) {
        const entry = {
            ...context,
            message: message
        };
        this._lastErrors.push(entry);
        console.error(`[widget-center] theme pack discovery: ${context.id} (${context.path}) - ${message}`);
    }
}