// products/extension/lib/backupService.js
//
// Task 11 (theme export/backup) — ".gwcbak" full backup: a password-
// protected archive that can recreate this exact gnome-widget-center
// setup on a fresh machine, unlike a `.gwct` theme export
// (exportService.js) which deliberately leaves out secrets and widget
// files. A `.gwcbak` is a personal "move house" file, not something to
// hand to someone else, so it includes EVERYTHING:
//
//   - `manifest.json` — the same shape as a `.gwct` document (appearance
//     + per-widget position/theme), except settings are NOT redacted
//     (secretFields.js is never consulted here on purpose).
//   - `gsettings.json` — every key from this extension's own gschema
//     (`org.gnome.shell.extensions.widget-center` — disabled-widgets,
//     dev-mode, etc; see schemas/org.gnome.shell.extensions.widget-center.gschema.xml).
//     `requested-widget-id` is intentionally skipped — it's a one-shot IPC
//     value (see the gschema's own doc comment), not real state.
//   - `widgets/<id>/...` — a full copy of every USER-installed widget's
//     folder (`~/.local/share/gnome-widget-center/widgets/<id>/`), so a
//     restore brings back third-party widgets too, not just settings for
//     ones the new machine happens to already have. Bundled widgets
//     (shipped inside the extension itself) are NOT copied — reinstalling
//     the extension already provides those.
//
// FILE FORMAT — v2 (tar+gzip+AES), replacing an earlier zip -P/unzip -P
// design:
//
//   All of the above gets tarred and gzipped with the system `tar`
//   binary (`tar czf`) — one dependency instead of two (`zip`+`unzip`),
//   and `tar` is close to universally preinstalled on Linux. The
//   resulting tar.gz bytes are then encrypted in pure JS:
//   AES-256-CTR (lib/crypto/aes256Ctr.js) for confidentiality, keyed via
//   PBKDF2-HMAC-SHA256 (lib/crypto/pbkdf2Sha256.js) over the user's
//   password with a random salt, PLUS a separate HMAC-SHA256 tag
//   (Encrypt-then-MAC) over the salt+iv+ciphertext so a wrong password
//   or a corrupted file is detected up front with a clear error instead
//   of restoring garbage silently — something the old `zip -P` design
//   didn't give us at all (a wrong `-P` password to `unzip` just fails
//   per-file with its own message; here we control that check directly).
//
//   On-disk layout (all fixed-size except the final ciphertext):
//     bytes  0- 6   magic   "GWCBAK2" (7 bytes, ASCII)
//     byte   7      version (1 byte, currently 2)
//     bytes  8-23   salt     (16 bytes, PBKDF2 input)
//     bytes 24-39   iv       (16 bytes, AES-CTR initial counter)
//     bytes 40-71   authTag  (32 bytes, HMAC-SHA256)
//     bytes 72-     ciphertext (AES-256-CTR of the plain tar.gz bytes)
//
//   This is intentionally NOT a format any generic archive tool can open
//   directly (the encrypted bytes aren't a valid zip/tar on their own) —
//   the payload INSIDE, once decrypted, is a completely standard tar.gz,
//   openable with `tar xzf` like any other, which is the whole point of
//   using tar+gzip here rather than inventing a custom container too.
//
// SECURITY NOTE, upfront rather than hidden: PBKDF2-HMAC-SHA256 and
// AES-256-CTR are both implemented from scratch in lib/crypto/ (no `gi://`
// crypto primitive exists to lean on) and each is verified against
// published test vectors / cross-checked against Node's own `crypto`
// module (see development/tests — not shipped in the runtime extension).
// That said, this has not had independent security review the way a
// vetted library (OpenSSL, libsodium, Node's `crypto`) has — treat it as
// "meaningfully better than the old zip -P/ZipCrypto scheme, with a real
// wrong-password check" rather than as audited cryptography.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {verifyWidgetDependencies} from './dependencyChecker.js';
import {randomBytes} from './crypto/randomBytes.js';
import {pbkdf2Sha256} from './crypto/pbkdf2Sha256.js';
import {aes256CtrTransform} from './crypto/aes256Ctr.js';
import {hmacSha256} from './crypto/hmacSha256.js';

export const GWCBAK_EXTENSION = '.gwcbak';
const GWCBAK_FORMAT = 'gwcbak';
const GWCBAK_VERSION = 2;
const BACKUP_GSCHEMA_KEYS = ['disabled-widgets', 'dev-mode'];

const MAGIC = new TextEncoder().encode('GWCBAK2'); // 7 bytes
const SALT_LEN = 16;
const IV_LEN = 16;
const TAG_LEN = 32;
const HEADER_LEN = MAGIC.length + 1 + SALT_LEN + IV_LEN + TAG_LEN; // = 72
// PBKDF2 iteration count: a deliberate cost/UI-blocking trade-off. This
// runs synchronously on the prefs process's main thread (no worker
// threads in GJS), so it directly stalls the Preferences window for
// however long it takes — chosen low enough to stay well under a second
// even on modest hardware with a pure-JS SHA-256, while still being
// meaningfully more iterations than "none" for a password most people
// will pick unassisted.
const PBKDF2_ITERATIONS = 120000;
const DERIVED_KEY_LEN = 64; // 32 (AES key) + 32 (HMAC key)

/** @param {string} path */
export function ensureGwcbakExtension(path) {
    return path.endsWith(GWCBAK_EXTENSION) ? path : `${path}${GWCBAK_EXTENSION}`;
}

/**
 * @returns {{ok: boolean, missing: string[]}} whether `tar` is on
 *   $PATH — this feature's only system dependency, checked with the
 *   same `GLib.find_program_in_path()` mechanism dependencyChecker.js
 *   uses for widget-declared dependencies.
 */
export function checkBackupToolsAvailable() {
    const missing = ['tar'].filter(bin => GLib.find_program_in_path(bin) === null);
    return {ok: missing.length === 0, missing};
}

/** @private runs a command to completion, throwing with its stderr on a
 * non-zero exit. */
function _runSync(argv, cwd) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    if (cwd)
        launcher.set_cwd(cwd);

    const proc = launcher.spawnv(argv);
    const [, stdout, stderr] = proc.communicate_utf8(null, null);
    const exitStatus = proc.get_exit_status();

    if (exitStatus !== 0)
        throw new Error(`${argv[0]} failed (exit ${exitStatus}): ${stderr || stdout || 'no output'}`);

    return stdout;
}

/**
 * @private Security check (2026-07-28), MUST run before any
 * `tar -xzf ... -C stagingPath` call in this file. Lists a tar.gz's
 * entries (`tar -tzf`, which only reads the archive and never writes
 * anything to disk) and throws if any entry name would let extraction
 * escape `stagingPath` — an absolute path, a Windows drive-letter path,
 * or a `..` path segment anywhere in the name (the classic "tar slip" /
 * "zip slip" path-traversal class of bug).
 *
 * Why this matters even though restore already verifies an HMAC tag
 * over the whole file before this point: that check only proves the
 * `.gwcbak` wasn't tampered with by someone who does NOT know the
 * backup's password. It says nothing about what someone who DOES know
 * the password chose to put inside the tar — e.g. a `.gwcbak` handed to
 * a victim together with its own password ("here's your backup, the
 * password is X"), which is a realistic distribution path for this file
 * format (see this file's header — a `.gwcbak` is meant to be portable
 * between machines). Without this check, a single crafted entry named
 * e.g. `../../../.bashrc` would let `tar -xzf` overwrite an arbitrary
 * file outside stagingPath, entirely bypassing the encryption/HMAC.
 *
 * KNOWN LIMITATION: this validates entry NAMES only. A plain `tar -tzf`
 * listing doesn't show a symlink entry's target, so a symlink created by
 * one entry that a later entry then writes through isn't caught here.
 * Every bundled/user-facing `.gwcbak` this codebase ever produces only
 * contains plain files and directories (see createBackup() below), so
 * this is a defense against a hand-crafted malicious archive, not a
 * gap this project's own output can trigger.
 * @param {string} tarPath
 */
function _validateTarEntries(tarPath) {
    const listing = _runSync(['tar', '-tzf', tarPath]);
    const names = listing.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    for (const name of names) {
        if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(name)) {
            throw new Error(
                `Refusing to restore: backup contains an absolute path entry ("${name}"). ` +
                'This backup may be corrupted or crafted to escape the restore directory.');
        }
        const segments = name.split(/[/\\]/);
        if (segments.includes('..')) {
            throw new Error(
                `Refusing to restore: backup contains a path-traversal entry ("${name}"). ` +
                'This backup may be corrupted or crafted to escape the restore directory.');
        }
    }
}

/** @private recursively copies a whole directory tree (Gio has no
 * built-in recursive copy). Used to stage user-widget folders into the
 * backup, and to un-stage them back out on restore. */
function _copyDirRecursive(srcPath, destPath) {
    const srcDir = Gio.File.new_for_path(srcPath);
    const destDir = Gio.File.new_for_path(destPath);
    if (!destDir.query_exists(null))
        destDir.make_directory_with_parents(null);

    const enumerator = srcDir.enumerate_children(
        'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);

    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        const childSrc = GLib.build_filenamev([srcPath, name]);
        const childDest = GLib.build_filenamev([destPath, name]);

        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            _copyDirRecursive(childSrc, childDest);
        } else {
            Gio.File.new_for_path(childSrc).copy(
                Gio.File.new_for_path(childDest), Gio.FileCreateFlags.REPLACE_DESTINATION, null, null);
        }
    }
}

/** @private constant-time byte comparison — guards the authTag check so
 * a mistyped password can't be distinguished from a corrupted file (or,
 * in principle, timed) by how quickly the comparison fails. Both inputs
 * are fixed-length (TAG_LEN) in every call site here. */
function _constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a[i] ^ b[i];
    return diff === 0;
}

/** @private password (string) + salt -> {encKey, macKey}, both 32 bytes. */
function _deriveKeys(password, salt) {
    const derived = pbkdf2Sha256(new TextEncoder().encode(password), salt, PBKDF2_ITERATIONS, DERIVED_KEY_LEN);
    return {encKey: derived.slice(0, 32), macKey: derived.slice(32, 64)};
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

/**
 * @typedef {object} DiscoveredWidget
 * @property {string} id
 * @property {string} path
 * @property {object} metadata
 */

/**
 * Creates a password-protected `.gwcbak` at `destPath`.
 * @param {string} destPath - `.gwcbak` appended if missing.
 * @param {string} password - must be non-empty; the caller (prefs.js UI)
 *   is responsible for prompting for and confirming this.
 * @param {DiscoveredWidget[]} userWidgets - only the USER-installed
 *   widgets (i.e. NOT the ones bundled inside the extension folder).
 * @param {{storage: import('./storageService.js').StorageService,
 *           theme: import('./themeService.js').ThemeService,
 *           settings: import('./settingsService.js').SettingsService}} services
 * @returns {string} the path actually written to.
 */
export function createBackup(destPath, password, userWidgets, {storage, theme, settings}) {
    if (!password)
        throw new Error('A password is required to create a .gwcbak backup.');

    const {ok, missing} = checkBackupToolsAvailable();
    if (!ok)
        throw new Error(`Missing required tool(s) for backup: ${missing.join(', ')}. Install them first.`);

    const finalPath = ensureGwcbakExtension(destPath);
    const stagingPath = GLib.build_filenamev([GLib.get_tmp_dir(), `gwc-backup-${GLib.uuid_string_random()}`]);
    const tarPath = `${stagingPath}.tar.gz`;
    Gio.File.new_for_path(stagingPath).make_directory_with_parents(null);

    try {
        // --- manifest.json: appearance + every widget's position/theme/
        // settings, UNREDACTED (see file header for why, unlike .gwct). ---
        const globalTheme = theme.getGlobalTheme();
        const widgetEntries = userWidgets.map(widget => ({
            id: widget.id,
            name: widget.metadata?.name ?? widget.id,
            position: storage.getWidgetPosition(widget.id),
            settings: storage.getWidgetSettings(widget.id),
            theme: theme.getWidgetTheme(widget.id),
            dependencies: Array.isArray(widget.metadata?.dependencies?.system)
                ? widget.metadata.dependencies.system : [],
        }));

        const manifest = {
            format: GWCBAK_FORMAT,
            version: GWCBAK_VERSION,
            createdAt: new Date().toISOString(),
            appearance: {
                background: {...globalTheme.background},
                cornerRadius: {...globalTheme.cornerRadius},
                dropShadow: {...globalTheme.dropShadow},
            },
            widgets: widgetEntries,
        };
        Gio.File.new_for_path(GLib.build_filenamev([stagingPath, 'manifest.json'])).replace_contents(
            new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

        // --- gsettings.json: every host-level key from our own gschema. ---
        const gsettingsDump = {};
        if (settings?.isReady) {
            for (const key of BACKUP_GSCHEMA_KEYS)
                gsettingsDump[key] = settings.getGlobalValue(key);
        }
        Gio.File.new_for_path(GLib.build_filenamev([stagingPath, 'gsettings.json'])).replace_contents(
            new TextEncoder().encode(JSON.stringify(gsettingsDump, null, 2)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

        // --- widgets/<id>/ — full copy of each user-installed widget's
        // own folder (code + assets). ---
        const widgetsStagingDir = GLib.build_filenamev([stagingPath, 'widgets']);
        Gio.File.new_for_path(widgetsStagingDir).make_directory_with_parents(null);
        for (const widget of userWidgets)
            _copyDirRecursive(widget.path, GLib.build_filenamev([widgetsStagingDir, widget.id]));

        // --- tar + gzip everything staged above into one plain archive. ---
        _runSync(['tar', '-czf', tarPath, '-C', stagingPath, '.']);
        const [, tarBytes] = Gio.File.new_for_path(tarPath).load_contents(null);

        // --- encrypt: PBKDF2 -> {encKey, macKey}, AES-256-CTR, then an
        // HMAC-SHA256 tag over salt+iv+ciphertext (Encrypt-then-MAC) so
        // restore can detect a wrong password / corrupt file up front. ---
        const salt = randomBytes(SALT_LEN);
        const iv = randomBytes(IV_LEN);
        const {encKey, macKey} = _deriveKeys(password, salt);
        const ciphertext = aes256CtrTransform(new Uint8Array(tarBytes), encKey, iv);
        const authTag = hmacSha256(macKey, _concatBytes(salt, iv, ciphertext));

        const fileBytes = _concatBytes(MAGIC, new Uint8Array([GWCBAK_VERSION]), salt, iv, authTag, ciphertext);

        const destFile = Gio.File.new_for_path(finalPath);
        if (destFile.query_exists(null))
            destFile.delete(null);
        destFile.replace_contents(fileBytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

        return finalPath;
    } finally {
        _runSync(['rm', '-rf', stagingPath, tarPath]);
    }
}

/**
 * Restores a `.gwcbak` created by createBackup() above.
 * @param {string} srcPath
 * @param {string} password
 * @param {{storage: import('./storageService.js').StorageService,
 *           theme: import('./themeService.js').ThemeService,
 *           settings: import('./settingsService.js').SettingsService,
 *           userWidgetsDir: string}} services - `userWidgetsDir` is
 *   where restored widget folders get written.
 * @returns {{
 *   restoredWidgetIds: string[],
 *   restoredWidgetFileIds: string[],
 *   dependencyWarnings: Array<{widgetId: string, bin: string, reason: string, suggestedCommand: string|null}>
 * }}
 */
export function restoreBackup(srcPath, password, {storage, theme, settings, userWidgetsDir}) {
    if (!password)
        throw new Error('A password is required to restore a .gwcbak backup.');

    const {ok, missing} = checkBackupToolsAvailable();
    if (!ok)
        throw new Error(`Missing required tool(s) for restore: ${missing.join(', ')}. Install them first.`);

    const srcFile = Gio.File.new_for_path(srcPath);
    if (!srcFile.query_exists(null))
        throw new Error(`File not found: ${srcPath}`);

    const [, fileBytesRaw] = srcFile.load_contents(null);
    const fileBytes = new Uint8Array(fileBytesRaw);

    if (fileBytes.length < HEADER_LEN)
        throw new Error('Not a valid GNOME Widget Center backup (.gwcbak) — file is too short.');

    const magic = fileBytes.slice(0, MAGIC.length);
    if (!_constantTimeEqual(magic, MAGIC))
        throw new Error('Not a GNOME Widget Center backup file (.gwcbak).');

    const version = fileBytes[MAGIC.length];
    if (version !== GWCBAK_VERSION)
        throw new Error(`This backup was made with a different .gwcbak version (${version}) than this build supports (${GWCBAK_VERSION}).`);

    let offset = MAGIC.length + 1;
    const salt = fileBytes.slice(offset, offset + SALT_LEN); offset += SALT_LEN;
    const iv = fileBytes.slice(offset, offset + IV_LEN); offset += IV_LEN;
    const storedTag = fileBytes.slice(offset, offset + TAG_LEN); offset += TAG_LEN;
    const ciphertext = fileBytes.slice(offset);

    const {encKey, macKey} = _deriveKeys(password, salt);
    const expectedTag = hmacSha256(macKey, _concatBytes(salt, iv, ciphertext));
    if (!_constantTimeEqual(storedTag, expectedTag))
        throw new Error('Incorrect password, or this backup file is corrupted.');

    const tarBytes = aes256CtrTransform(ciphertext, encKey, iv);

    const stagingPath = GLib.build_filenamev([GLib.get_tmp_dir(), `gwc-restore-${GLib.uuid_string_random()}`]);
    const tarPath = `${stagingPath}.tar.gz`;
    Gio.File.new_for_path(stagingPath).make_directory_with_parents(null);

    try {
        Gio.File.new_for_path(tarPath).replace_contents(
            tarBytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

        // Must run BEFORE extraction — see _validateTarEntries()'s doc
        // comment for why the HMAC check above doesn't already cover this.
        _validateTarEntries(tarPath);

        _runSync(['tar', '-xzf', tarPath, '-C', stagingPath]);

        const manifestFile = Gio.File.new_for_path(GLib.build_filenamev([stagingPath, 'manifest.json']));
        if (!manifestFile.query_exists(null))
            throw new Error('Not a valid GNOME Widget Center backup (.gwcbak) — missing manifest.json.');

        const [, manifestBytes] = manifestFile.load_contents(null);
        const manifest = JSON.parse(new TextDecoder('utf-8').decode(manifestBytes));
        if (manifest.format !== GWCBAK_FORMAT)
            throw new Error('Not a GNOME Widget Center backup file (.gwcbak).');

        // --- gsettings.json first, so a widget that got just restored
        // isn't immediately hidden by a stale disabled-widgets entry. ---
        const gsettingsFile = Gio.File.new_for_path(GLib.build_filenamev([stagingPath, 'gsettings.json']));
        if (gsettingsFile.query_exists(null) && settings?.isReady) {
            const [, gsBytes] = gsettingsFile.load_contents(null);
            const gsDump = JSON.parse(new TextDecoder('utf-8').decode(gsBytes));
            for (const key of BACKUP_GSCHEMA_KEYS) {
                if (key in gsDump)
                    settings.setGlobalValue(key, gsDump[key]);
            }
        }

        // --- widget folders: copy each `widgets/<id>/` back out onto
        // disk BEFORE applying settings, so dependency-checking below can
        // read the just-restored metadata.json. ---
        const restoredWidgetFileIds = [];
        const widgetsStagingDir = GLib.build_filenamev([stagingPath, 'widgets']);
        const widgetsStagingDirFile = Gio.File.new_for_path(widgetsStagingDir);
        if (widgetsStagingDirFile.query_exists(null)) {
            const enumerator = widgetsStagingDirFile.enumerate_children(
                'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                    continue;
                const id = info.get_name();
                _copyDirRecursive(
                    GLib.build_filenamev([widgetsStagingDir, id]),
                    GLib.build_filenamev([userWidgetsDir, id]));
                restoredWidgetFileIds.push(id);
            }
        }

        // --- manifest.json: appearance + every widget's position/theme/
        // settings. ---
        const restoredWidgetIds = [];
        const dependencyWarnings = [];

        theme.setGlobalTheme({
            background: manifest.appearance?.background ?? {},
            cornerRadius: manifest.appearance?.cornerRadius ?? {},
            dropShadow: manifest.appearance?.dropShadow ?? {},
        });

        for (const entry of manifest.widgets ?? []) {
            // Defense-in-depth (2026-07-28): manifest.json is JSON content
            // from inside the tar, not a tar entry name — _validateTarEntries()
            // above protects tar entry NAMES, but entry.id here is a separate
            // string an attacker who knows the backup's password (see
            // _validateTarEntries()'s doc comment) could set independently of
            // any real extracted folder. storage.saveWidgetSettings()/
            // updateWidgetPosition() already sanitize their own widgetId
            // argument internally, but `widgetPath` below is built directly
            // from entry.id without going through that, so skip anything
            // that isn't a plain, single-segment identifier before it's used
            // to build a filesystem path.
            if (typeof entry.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(entry.id) || entry.id === '.' || entry.id === '..') {
                dependencyWarnings.push({
                    widgetId: String(entry.id ?? '(missing)'), bin: '', reason: 'Skipped: invalid widget id in backup manifest.json', suggestedCommand: null,
                });
                continue;
            }

            storage.saveWidgetSettings(entry.id, entry.settings ?? {});
            if (entry.position)
                storage.updateWidgetPosition(entry.id, entry.position.x, entry.position.y, entry.position.monitorIndex ?? 0);
            theme.setWidgetTheme(entry.id, {
                theme: entry.theme?.theme ?? undefined,
                config: entry.theme?.config ?? {},
            });
            restoredWidgetIds.push(entry.id);

            const widgetPath = GLib.build_filenamev([userWidgetsDir, entry.id]);
            const metadataFile = Gio.File.new_for_path(GLib.build_filenamev([widgetPath, 'metadata.json']));
            if (metadataFile.query_exists(null)) {
                const [, metaBytes] = metadataFile.load_contents(null);
                const metadata = JSON.parse(new TextDecoder('utf-8').decode(metaBytes));
                const {missing: missingDeps} = verifyWidgetDependencies(metadata);
                for (const dep of missingDeps) {
                    dependencyWarnings.push({
                        widgetId: entry.id, bin: dep.bin, reason: dep.reason,
                        suggestedCommand: dep.suggestedCommand,
                    });
                }
            }
        }

        return {restoredWidgetIds, restoredWidgetFileIds, dependencyWarnings};
    } finally {
        _runSync(['rm', '-rf', stagingPath, tarPath]);
    }
}
