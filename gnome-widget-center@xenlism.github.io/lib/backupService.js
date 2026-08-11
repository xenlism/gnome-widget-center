import Gio from "gi://Gio";

import GLib from "gi://GLib";

import { ensureDirectory, readTextFile, readBytesFile, writeBytesFile, writeJsonFile } from "./fsUtils.js";

import { verifyWidgetDependencies } from "./dependencyChecker.js";

import { randomBytes } from "./crypto/randomBytes.js";

import { pbkdf2Sha256 } from "./crypto/pbkdf2Sha256.js";

import { aes256CtrTransform } from "./crypto/aes256Ctr.js";

import { hmacSha256 } from "./crypto/hmacSha256.js";

export const GWCBAK_EXTENSION = ".gwcbak";

const GWCBAK_FORMAT = "gwcbak";

const GWCBAK_VERSION = 2;

const BACKUP_GSCHEMA_KEYS = [ "disabled-widgets", "dev-mode", "auto-enable-new-widgets", "known-widget-ids" ];

const MAGIC = (new TextEncoder).encode("GWCBAK2");

const SALT_LEN = 16;

const IV_LEN = 16;

const TAG_LEN = 32;

const HEADER_LEN = MAGIC.length + 1 + SALT_LEN + IV_LEN + TAG_LEN;

const PBKDF2_ITERATIONS = 12e4;

const DERIVED_KEY_LEN = 64;

export function ensureGwcbakExtension(path) {
    return path.endsWith(GWCBAK_EXTENSION) ? path : `${path}${GWCBAK_EXTENSION}`;
}

export function checkBackupToolsAvailable() {
    const missing = [ "tar" ].filter(bin => GLib.find_program_in_path(bin) === null);
    return {
        ok: missing.length === 0,
        missing: missing
    };
}

function _runSync(argv, cwd) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    });
    if (cwd) launcher.set_cwd(cwd);
    const proc = launcher.spawnv(argv);
    const [, stdout, stderr] = proc.communicate_utf8(null, null);
    const exitStatus = proc.get_exit_status();
    if (exitStatus !== 0) throw new Error(`${argv[0]} failed (exit ${exitStatus}): ${stderr || stdout || "no output"}`);
    return stdout;
}

function _validateTarEntries(tarPath) {
    const listing = _runSync([ "tar", "-tzf", tarPath ]);
    const names = listing.split("\n").map(line => line.trim()).filter(line => line.length > 0);
    for (const name of names) {
        if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(name)) {
            throw new Error(`Refusing to restore: backup contains an absolute path entry ("${name}"). ` + "This backup may be corrupted or crafted to escape the restore directory.");
        }
        const segments = name.split(/[/\\]/);
        if (segments.includes("..")) {
            throw new Error(`Refusing to restore: backup contains a path-traversal entry ("${name}"). ` + "This backup may be corrupted or crafted to escape the restore directory.");
        }
    }
}

function _copyDirRecursive(srcPath, destPath) {
    const srcDir = Gio.File.new_for_path(srcPath);
    const destDir = Gio.File.new_for_path(destPath);
    if (!destDir.query_exists(null)) destDir.make_directory_with_parents(null);
    const enumerator = srcDir.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        const childSrc = GLib.build_filenamev([ srcPath, name ]);
        const childDest = GLib.build_filenamev([ destPath, name ]);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            _copyDirRecursive(childSrc, childDest);
        } else {
            Gio.File.new_for_path(childSrc).copy(Gio.File.new_for_path(childDest), Gio.FileCreateFlags.REPLACE_DESTINATION, null, null);
        }
    }
}

function _constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

function _deriveKeys(password, salt) {
    const derived = pbkdf2Sha256((new TextEncoder).encode(password), salt, PBKDF2_ITERATIONS, DERIVED_KEY_LEN);
    return {
        encKey: derived.slice(0, 32),
        macKey: derived.slice(32, 64)
    };
}

function _concatBytes(...arrays) {
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}

export function createBackup(destPath, password, userWidgets, {storage: storage, theme: theme, settings: settings}) {
    if (!password) throw new Error("A password is required to create a .gwcbak backup.");
    const {ok: ok, missing: missing} = checkBackupToolsAvailable();
    if (!ok) throw new Error(`Missing required tool(s) for backup: ${missing.join(", ")}. Install them first.`);
    const finalPath = ensureGwcbakExtension(destPath);
    const stagingPath = GLib.build_filenamev([ GLib.get_tmp_dir(), `gwc-backup-${GLib.uuid_string_random()}` ]);
    const tarPath = `${stagingPath}.tar.gz`;
    ensureDirectory(stagingPath);
    try {
        const globalTheme = theme.getGlobalTheme();
        const widgetEntries = userWidgets.map(widget => ({
            id: widget.id,
            name: widget.metadata?.name ?? widget.id,
            position: storage.getWidgetPosition(widget.id),
            settings: storage.getWidgetSettings(widget.id),
            theme: theme.getWidgetTheme(widget.id),
            dependencies: Array.isArray(widget.metadata?.dependencies?.system) ? widget.metadata.dependencies.system : []
        }));
        const manifest = {
            format: GWCBAK_FORMAT,
            version: GWCBAK_VERSION,
            createdAt: (new Date).toISOString(),
            appearance: {
                background: {
                    ...globalTheme.background
                },
                cornerRadius: {
                    ...globalTheme.cornerRadius
                },
                dropShadow: {
                    ...globalTheme.dropShadow
                }
            },
            widgets: widgetEntries
        };
        writeJsonFile(GLib.build_filenamev([ stagingPath, "manifest.json" ]), manifest, 2);
        const gsettingsDump = {};
        if (settings?.isReady) {
            for (const key of BACKUP_GSCHEMA_KEYS) gsettingsDump[key] = settings.getGlobalValue(key);
        }
        writeJsonFile(GLib.build_filenamev([ stagingPath, "gsettings.json" ]), gsettingsDump, 2);
        const widgetsStagingDir = GLib.build_filenamev([ stagingPath, "widgets" ]);
        ensureDirectory(widgetsStagingDir);
        for (const widget of userWidgets) _copyDirRecursive(widget.path, GLib.build_filenamev([ widgetsStagingDir, widget.id ]));
        _runSync([ "tar", "-czf", tarPath, "-C", stagingPath, "." ]);
        const tarBytes = readBytesFile(tarPath);
        const salt = randomBytes(SALT_LEN);
        const iv = randomBytes(IV_LEN);
        const {encKey: encKey, macKey: macKey} = _deriveKeys(password, salt);
        const ciphertext = aes256CtrTransform(tarBytes, encKey, iv);
        const authTag = hmacSha256(macKey, _concatBytes(salt, iv, ciphertext));
        const fileBytes = _concatBytes(MAGIC, new Uint8Array([ GWCBAK_VERSION ]), salt, iv, authTag, ciphertext);
        writeBytesFile(finalPath, fileBytes);
        return finalPath;
    } finally {
        _runSync([ "rm", "-rf", stagingPath, tarPath ]);
    }
}

export function restoreBackup(srcPath, password, {storage: storage, theme: theme, settings: settings, userWidgetsDir: userWidgetsDir}) {
    if (!password) throw new Error("A password is required to restore a .gwcbak backup.");
    const {ok: ok, missing: missing} = checkBackupToolsAvailable();
    if (!ok) throw new Error(`Missing required tool(s) for restore: ${missing.join(", ")}. Install them first.`);
    const fileBytes = readBytesFile(srcPath);
    if (fileBytes === null) throw new Error(`File not found: ${srcPath}`);
    if (fileBytes.length < HEADER_LEN) throw new Error("Not a valid GNOME Widget Center backup (.gwcbak) — file is too short.");
    const magic = fileBytes.slice(0, MAGIC.length);
    if (!_constantTimeEqual(magic, MAGIC)) throw new Error("Not a GNOME Widget Center backup file (.gwcbak).");
    const version = fileBytes[MAGIC.length];
    if (version !== GWCBAK_VERSION) throw new Error(`This backup was made with a different .gwcbak version (${version}) than this build supports (${GWCBAK_VERSION}).`);
    let offset = MAGIC.length + 1;
    const salt = fileBytes.slice(offset, offset + SALT_LEN);
    offset += SALT_LEN;
    const iv = fileBytes.slice(offset, offset + IV_LEN);
    offset += IV_LEN;
    const storedTag = fileBytes.slice(offset, offset + TAG_LEN);
    offset += TAG_LEN;
    const ciphertext = fileBytes.slice(offset);
    const {encKey: encKey, macKey: macKey} = _deriveKeys(password, salt);
    const expectedTag = hmacSha256(macKey, _concatBytes(salt, iv, ciphertext));
    if (!_constantTimeEqual(storedTag, expectedTag)) throw new Error("Incorrect password, or this backup file is corrupted.");
    const tarBytes = aes256CtrTransform(ciphertext, encKey, iv);
    const stagingPath = GLib.build_filenamev([ GLib.get_tmp_dir(), `gwc-restore-${GLib.uuid_string_random()}` ]);
    const tarPath = `${stagingPath}.tar.gz`;
    ensureDirectory(stagingPath);
    try {
        writeBytesFile(tarPath, tarBytes);
        _validateTarEntries(tarPath);
        _runSync([ "tar", "-xzf", tarPath, "-C", stagingPath ]);
        const manifestText = readTextFile(GLib.build_filenamev([ stagingPath, "manifest.json" ]));
        if (manifestText === null) throw new Error("Not a valid GNOME Widget Center backup (.gwcbak) — missing manifest.json.");
        const manifest = JSON.parse(manifestText);
        if (manifest.format !== GWCBAK_FORMAT) throw new Error("Not a GNOME Widget Center backup file (.gwcbak).");
        const gsettingsText = settings?.isReady ? readTextFile(GLib.build_filenamev([ stagingPath, "gsettings.json" ])) : null;
        if (gsettingsText !== null) {
            const gsDump = JSON.parse(gsettingsText);
            for (const key of BACKUP_GSCHEMA_KEYS) {
                if (key in gsDump) settings.setGlobalValue(key, gsDump[key]);
            }
        }
        const restoredWidgetFileIds = [];
        const widgetsStagingDir = GLib.build_filenamev([ stagingPath, "widgets" ]);
        const widgetsStagingDirFile = Gio.File.new_for_path(widgetsStagingDir);
        if (widgetsStagingDirFile.query_exists(null)) {
            const enumerator = widgetsStagingDirFile.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue;
                const id = info.get_name();
                _copyDirRecursive(GLib.build_filenamev([ widgetsStagingDir, id ]), GLib.build_filenamev([ userWidgetsDir, id ]));
                restoredWidgetFileIds.push(id);
            }
        }
        const restoredWidgetIds = [];
        const dependencyWarnings = [];
        theme.setGlobalTheme({
            background: manifest.appearance?.background ?? {},
            cornerRadius: manifest.appearance?.cornerRadius ?? {},
            dropShadow: manifest.appearance?.dropShadow ?? {}
        });
        for (const entry of manifest.widgets ?? []) {
            if (typeof entry.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(entry.id) || entry.id === "." || entry.id === "..") {
                dependencyWarnings.push({
                    widgetId: String(entry.id ?? "(missing)"),
                    bin: "",
                    reason: "Skipped: invalid widget id in backup manifest.json",
                    suggestedCommand: null
                });
                continue;
            }
            storage.saveWidgetSettings(entry.id, entry.settings ?? {});
            if (entry.position) storage.updateWidgetPosition(entry.id, entry.position.x, entry.position.y, entry.position.monitorIndex ?? 0);
            theme.setWidgetTheme(entry.id, {
                theme: entry.theme?.theme ?? undefined,
                config: entry.theme?.config ?? {}
            });
            restoredWidgetIds.push(entry.id);
            const widgetPath = GLib.build_filenamev([ userWidgetsDir, entry.id ]);
            const metadataText = readTextFile(GLib.build_filenamev([ widgetPath, "metadata.json" ]));
            if (metadataText !== null) {
                const metadata = JSON.parse(metadataText);
                const {missing: missingDeps} = verifyWidgetDependencies(metadata);
                for (const dep of missingDeps) {
                    dependencyWarnings.push({
                        widgetId: entry.id,
                        bin: dep.bin,
                        reason: dep.reason,
                        suggestedCommand: dep.suggestedCommand
                    });
                }
            }
        }
        return {
            restoredWidgetIds: restoredWidgetIds,
            restoredWidgetFileIds: restoredWidgetFileIds,
            dependencyWarnings: dependencyWarnings
        };
    } finally {
        _runSync([ "rm", "-rf", stagingPath, tarPath ]);
    }
}