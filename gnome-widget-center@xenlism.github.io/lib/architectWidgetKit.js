import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { ensureDirectory, fileExists, readTextFileAsync, writeJsonFile } from "./fsUtils.js";

function _sanitizeIdPart(value) {
    return String(value ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function _timestamp() {
    const now = GLib.DateTime.new_now_local();
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.get_year()}${pad(now.get_month())}${pad(now.get_day_of_month())}${pad(now.get_hour())}${pad(now.get_minute())}${pad(now.get_second())}`;
}

export function generateChildId(parentWidgetId, childName) {
    const parent = _sanitizeIdPart(parentWidgetId);
    const name = _sanitizeIdPart(childName) || "child";
    return `${parent}-${name}-${_timestamp()}`;
}

function _copyDirRecursive(srcPath, destPath) {
    const srcDir = Gio.File.new_for_path(srcPath);
    ensureDirectory(destPath);
    const enumerator = srcDir.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        const childSrc = GLib.build_filenamev([srcPath, name]);
        const childDest = GLib.build_filenamev([destPath, name]);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            _copyDirRecursive(childSrc, childDest);
        } else {
            Gio.File.new_for_path(childSrc).copy(Gio.File.new_for_path(childDest), Gio.FileCreateFlags.REPLACE_DESTINATION, null, null);
        }
    }
}

// Child widgets no longer need a resolved parent URI baked into a file -
// lib/shell/widgetRuntimeLoader.js's loadModule() resolves metadata.parent
// (a stable widget ID) to the parent's *current* install path at load time
// instead, via its own live discover() results. See child/widget.js's
// comment for what this replaced and why.
export function childTemplateDir(api) {
    return GLib.build_filenamev([api.path.me, "child"]);
}

export function userWidgetsRoot() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), "gnome-widget-center", "widgets"]);
}

export async function createChildWidgetFromParent(api, parentMetadata, childName, options = {}) {
    const srcDir = childTemplateDir(api);
    if (!fileExists(GLib.build_filenamev([srcDir, "metadata.json"]))) {
        throw new Error(`Architect Widget "${parentMetadata?.id}" has no child/ template (expected at ${srcDir})`);
    }

    const childId = generateChildId(parentMetadata.id, childName);
    const destDir = GLib.build_filenamev([userWidgetsRoot(), childId]);
    if (fileExists(destDir)) {
        throw new Error(`Child widget directory already exists: ${destDir}`);
    }

    _copyDirRecursive(srcDir, destDir);

    const metadataPath = GLib.build_filenamev([destDir, "metadata.json"]);
    const metadata = JSON.parse(await readTextFileAsync(metadataPath));
    metadata.id = childId;
    metadata.parent = parentMetadata.id;
    if (options.name ?? childName) metadata.name = options.name ?? childName;
    writeJsonFile(metadataPath, metadata);

    if (options.configOverrides && Object.keys(options.configOverrides).length > 0) {
        const configPath = GLib.build_filenamev([destDir, "config.json"]);
        if (fileExists(configPath)) {
            const config = JSON.parse(await readTextFileAsync(configPath));
            _applyFieldDefaultOverrides(config, options.configOverrides);
            writeJsonFile(configPath, config);
        }
    }

    api?.logger?.info?.(`architect: created child "${childId}" at ${destDir}`);
    if (options.rescan !== false) api?.host?.rescan?.();
    return { id: childId, path: destDir };
}

function _applyFieldDefaultOverrides(config, overrides) {
    for (const tab of config.tabs ?? []) {
        for (const group of tab.groups ?? []) {
            for (const field of group.fields ?? []) {
                if (Object.prototype.hasOwnProperty.call(overrides, field.id)) {
                    field.default = overrides[field.id];
                }
            }
        }
    }
}
