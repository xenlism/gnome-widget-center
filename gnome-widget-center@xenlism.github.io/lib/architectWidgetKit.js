// lib/architectWidgetKit.js
//
// Generic support code for the "Architect Widget" pattern (see
// development docs: XTile Architecture). This is core Widget
// Architecture-level plumbing, not an XTile-specific runtime — any
// widget author can build their OWN Architect Widget (a normal widget
// that spawns Child Widgets from its own `child/` template) by
// importing this file, the same way widgets already import
// lib/cardLayers.js or lib/widgetTooltip.js.
//
// What this file deliberately does NOT do:
//   - It does not define any Child-side runtime. A generated Child's
//     widget.js only ever imports the Parent's OWN widget.js (a normal
//     widget file) — never this kit. That keeps "no separate XTile
//     library required by Child Widgets" true for every Architect, not
//     just XTile.
//   - It does not hardcode XTile's business logic (launching an app,
//     etc.). That belongs in the Architect's own widget.js/child's
//     widget.js — this kit only handles the mechanical parts every
//     Architect Widget needs regardless of what its Children actually
//     do: ID generation, copying the template, and wiring metadata.
//
// Two ways an Architect's generated child/widget.js can relate to the
// Parent's widget.js — both are supported by resolveParentEntryUri()
// below, since both just need an absolute import path to the Parent:
//
//   1. Config-only (recommended default — see _architect_template_/
//      child/widget.js): the Child re-exports the Parent's class
//      verbatim. All per-Child difference lives in the Child's own
//      config.json. No new code per Child, ever — like `new Car();
//      car.color = "#xxxxxx"`, not a new class.
//   2. Override: the Child's widget.js imports the Parent class and
//      extends it with Child-specific behavior. Same resolved import
//      path, just a real subclass instead of a re-export.

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { ensureDirectory, fileExists, readTextFile, writeTextFile, writeJsonFile } from "./fsUtils.js";

// Same widget-id character set the host already enforces elsewhere
// (see lib/storageService.js's _sanitizeWidgetId) — keeps generated
// Child ids valid as both a widget id and a directory name.
function _sanitizeIdPart(value) {
    return String(value ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function _timestamp() {
    // YYYYMMDDHHMMSS, per XTile Architecture §8.
    const now = GLib.DateTime.new_now_local();
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.get_year()}${pad(now.get_month())}${pad(now.get_day_of_month())}${pad(now.get_hour())}${pad(now.get_minute())}${pad(now.get_second())}`;
}

/**
 * Generates a Child Widget id: <parent_widget_id>-<child_name>-<YYYYMMDDHHMMSS>
 * (XTile Architecture §8). `childName` is whatever the user typed when
 * creating the Child — sanitized down to a safe id fragment.
 */
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

/**
 * Builds an absolute file:// URI to a file inside the Parent Architect
 * Widget's OWN (bundled or user-installed) directory — e.g. its
 * widget.js — using `api.path.me` (already provided by the widget
 * loader, see lib/widgetLoader.js's _buildApi()). This is what lets a
 * generated Child import the Parent from an entirely different
 * directory (extension/widgets/<id>/ vs
 * ~/.local/share/gnome-widget-center/widgets/<child-id>/) without any
 * new loader mechanism.
 */
export function resolveParentEntryUri(api, entryFile = "widget.js") {
    const path = GLib.build_filenamev([api.path.me, entryFile]);
    return GLib.filename_to_uri(path, null);
}

/**
 * Returns the absolute path to <parentDir>/child — the Child template
 * every Architect Widget ships alongside its own widget.js (XTile
 * Architecture §2). The directory name MUST be "child".
 */
export function childTemplateDir(api) {
    return GLib.build_filenamev([api.path.me, "child"]);
}

/**
 * Returns the user widgets root every Child gets copied into:
 * ~/.local/share/gnome-widget-center/widgets/ (XTile Architecture §5).
 */
export function userWidgetsRoot() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), "gnome-widget-center", "widgets"]);
}

/**
 * Creates one Child Widget from the Parent's `child/` template.
 *
 * @param {object} api - the Architect Widget's own `api` object (as
 *   passed to its constructor) — used only for `api.path.me` and
 *   `api.logger`.
 * @param {object} parentMetadata - the Architect Widget's own parsed
 *   metadata.json — needed for `id` (stamped into the Child's own
 *   metadata "parent" field, §7).
 * @param {string} childName - user-supplied name (becomes part of the
 *   generated id, XTile Architecture §8).
 * @param {object} [options]
 * @param {object} [options.configOverrides] - shallow-merged on top of
 *   the copied child/config.json's contents. This is the normal way to
 *   hand the new Child its per-instance data (XTile Architecture §5) —
 *   e.g. { metric: "mem", label: "MEM" } — without writing any new code.
 * @param {string} [options.name] - display name for the Child's own
 *   metadata.json "name" field. Defaults to `childName`.
 * @param {string} [options.parentEntryFile] - defaults to "widget.js".
 * @param {boolean} [options.rescan] - defaults to true. Calls
 *   `api.host.rescan()` (see lib/widgetLoader.js's _buildApi()) right
 *   after the Child's files are written, so it's discovered and placed
 *   in the running layer immediately instead of waiting for the next
 *   manual "Rescan widgets". Pass false when creating several Children
 *   in a row and you'd rather rescan once yourself at the end.
 * @returns {{id: string, path: string}} the created Child's id and
 *   on-disk path.
 */
export function createChildWidgetFromParent(api, parentMetadata, childName, options = {}) {
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

    // metadata.json: stamp the generated id + required "parent" link
    // (XTile Architecture §7). Everything else in the template's
    // metadata.json is left as the Architect author wrote it.
    const metadataPath = GLib.build_filenamev([destDir, "metadata.json"]);
    const metadata = JSON.parse(readTextFile(metadataPath));
    metadata.id = childId;
    metadata.parent = parentMetadata.id;
    if (options.name ?? childName) metadata.name = options.name ?? childName;
    writeJsonFile(metadataPath, metadata);

    // config.json: shallow-merge configOverrides into whatever
    // defaults the template shipped, so field-level UI (icons,
    // descriptions, field types) stays defined once in the template,
    // not duplicated per Child.
    if (options.configOverrides && Object.keys(options.configOverrides).length > 0) {
        const configPath = GLib.build_filenamev([destDir, "config.json"]);
        if (fileExists(configPath)) {
            const config = JSON.parse(readTextFile(configPath));
            _applyFieldDefaultOverrides(config, options.configOverrides);
            writeJsonFile(configPath, config);
        }
    }

    // widget.js: replace the {{PARENT_ENTRY_URI}} placeholder the
    // template ships with the real resolved absolute URI to THIS
    // Parent's widget.js (see resolveParentEntryUri() above). This is
    // the one generated/mechanical edit to an otherwise-static file —
    // everything else about how the Child behaves comes from
    // config.json, not from rewriting code.
    const widgetJsPath = GLib.build_filenamev([destDir, options.parentEntryFile ?? "widget.js"]);
    if (fileExists(widgetJsPath)) {
        const parentUri = resolveParentEntryUri(api, options.parentEntryFile ?? "widget.js");
        const source = readTextFile(widgetJsPath).replaceAll("{{PARENT_ENTRY_URI}}", parentUri);
        writeTextFile(widgetJsPath, source);
    }

    api?.logger?.info?.(`architect: created child "${childId}" at ${destDir}`);
    if (options.rescan !== false) api?.host?.rescan?.();
    return { id: childId, path: destDir };
}

// config.json's shape is { tabs: [ { groups: [ { fields: [ {id, default, ...} ] } ] } ] }
// (see lib/widgetConfigValidator.js / WIDGET_API.md §2 for the full
// schema). Overrides are keyed by field id, same as the flat
// {fieldId: value} map the loader itself produces via
// getConfigDefaults() — this just writes new `default`s back into that
// same shape so the generated Child's Preferences page shows the
// per-instance value from the moment it's created.
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
