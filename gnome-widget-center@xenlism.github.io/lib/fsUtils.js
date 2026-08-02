// products/extension/lib/fsUtils.js
//
// Small shared helpers around Gio.File for the handful of things nearly
// every storage-ish module in lib/ was independently re-implementing
// (ensure-directory-exists, read-file-as-text, write-file-atomically).
// Extracted during the 2026-08-01 lib/ cleanup pass — storageService.js,
// settingsStore.js, themeService.js, and widgetConfigReader.js each had
// their own copy of this exact Gio.File.new_for_path(...) /
// query_exists(null) / load_contents(null) / replace_contents(...)
// boilerplate; this module is the single place that logic lives now.
//
// Deliberately thin: no JSON parsing here. Callers that need JSON keep
// their own JSON.parse/try-catch around readTextFile(), because several
// of them return different fallback values (null vs {} vs a
// {config, errors} shape) and distinguish "read failed" from "parse
// failed" in their own error messages — collapsing that into one
// readJsonFile() would either lose those distinctions or need enough
// options to defeat the point of sharing the code.
//
// Every function here follows Gio's own convention: a missing file is
// reported through the return value (null / false), not an exception.
// An actual I/O error (e.g. permission denied) still throws, same as
// calling the Gio.File methods directly — wrap call sites in try/catch
// exactly like they already did before this module existed.

import Gio from 'gi://Gio';

/**
 * @param {string} path
 * @returns {boolean} whether a file/directory exists at `path`.
 */
export function fileExists(path) {
    return Gio.File.new_for_path(path).query_exists(null);
}

/**
 * Creates `dirPath` (and any missing parents) if it doesn't already
 * exist. Safe to call every time a caller needs the directory — it's a
 * no-op once the directory is there.
 * @param {string} dirPath
 * @returns {Gio.File} the directory, guaranteed to exist on return.
 */
export function ensureDirectory(dirPath) {
    const dir = Gio.File.new_for_path(dirPath);
    if (!dir.query_exists(null))
        dir.make_directory_with_parents(null);
    return dir;
}

/**
 * Reads a file's full contents as UTF-8 text.
 * @param {string} path
 * @returns {string|null} the file's contents, or null if it doesn't
 *   exist / GIO reported the load as unsuccessful. A real read error
 *   (permissions, etc.) throws — callers should keep their existing
 *   try/catch around this, same as the raw Gio.File calls it replaces.
 */
export function readTextFile(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return null;

    const [success, contents] = file.load_contents(null);
    if (!success)
        return null;

    return new TextDecoder('utf-8').decode(contents);
}

/**
 * Writes `text` to `path`, atomically replacing any existing file
 * (`Gio.FileCreateFlags.REPLACE_DESTINATION`) — same safe-write pattern
 * every JSON-writing method in this codebase already used.
 * @param {string} path
 * @param {string} text
 */
export function writeTextFile(path, text) {
    const file = Gio.File.new_for_path(path);
    const bytes = new TextEncoder().encode(text);
    file.replace_contents(
        bytes,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
}

/**
 * Reads a file's full contents as raw bytes.
 * @param {string} path
 * @returns {Uint8Array|null} null if the file doesn't exist / load was
 *   unsuccessful (same semantics as readTextFile()).
 */
export function readBytesFile(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return null;

    const [success, contents] = file.load_contents(null);
    if (!success)
        return null;

    return new Uint8Array(contents);
}

/**
 * Writes raw bytes to `path`, atomically replacing any existing file —
 * same REPLACE_DESTINATION pattern as writeTextFile(), for binary
 * payloads (e.g. backupService.js's encrypted .gwcbak bytes) that
 * aren't UTF-8 text.
 * @param {string} path
 * @param {Uint8Array} bytes
 */
export function writeBytesFile(path, bytes) {
    const file = Gio.File.new_for_path(path);
    file.replace_contents(
        bytes,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
}

/**
 * JSON.stringify + writeTextFile in one call, for the common case where
 * there's no per-callsite reason to keep them separate.
 * @param {string} path
 * @param {*} data
 * @param {number} [indent=4]
 */
export function writeJsonFile(path, data, indent = 4) {
    writeTextFile(path, JSON.stringify(data, null, indent));
}
