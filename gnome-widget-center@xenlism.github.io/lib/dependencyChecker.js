// products/extension/lib/dependencyChecker.js
//
// Task 11 (theme export/backup) — reads a widget's `metadata.json`
// "dependencies" field (new, documented in development/docs/WIDGET_API.md
// §2) and checks whether each declared system binary is actually present,
// so both `.gwct` theme import and normal "install this widget" flows can
// warn BEFORE the widget's `widget.js` runs and fails confusingly (e.g. a
// `Gio.Subprocess` spawn of a missing binary throwing deep inside a
// widget's `enable()`).
//
// `metadata.json` shape this reads:
//
//   "dependencies": {
//     "system": [
//       {
//         "bin": "playerctl",
//         "reason": "Needed to control playback for non-MPRIS players.",
//         "package": { "apt": "playerctl", "dnf": "playerctl", "pacman": "playerctl" }
//       }
//     ]
//   }
//
// `bin` is the only required field (checked via
// `GLib.find_program_in_path()` — same mechanism the shell's own `which`
// uses, no subprocess spawn needed just to check). `package` is a hint
// map keyed by package-manager name, used only to build a human-readable
// "install with: ..." suggestion — never executed automatically; this
// module never installs anything itself, it only reports.
//
// Pure JS + GLib only (no Gio.Subprocess spawning) — safe to import from
// both the Shell process and the Prefs process, same rule every other
// lib/ file not touching St/Clutter follows.

import GLib from 'gi://GLib';

/** Package managers we know how to suggest a command for, in the order
 * we prefer to check for their presence (apt/dnf/pacman cover the
 * overwhelming majority of desktop Linux installs this extension targets;
 * see development/docs/WIDGET_API.md's supported-distros note). */
const PACKAGE_MANAGERS = [
    {key: 'apt', command: name => `sudo apt install ${name}`},
    {key: 'dnf', command: name => `sudo dnf install ${name}`},
    {key: 'pacman', command: name => `sudo pacman -S ${name}`},
    {key: 'zypper', command: name => `sudo zypper install ${name}`},
];

/**
 * @param {string} bin
 * @returns {boolean} whether `bin` resolves on $PATH right now.
 */
export function isBinaryAvailable(bin) {
    if (typeof bin !== 'string' || !bin)
        return false;
    return GLib.find_program_in_path(bin) !== null;
}

/**
 * @param {object} packageHints - `dependency.package`, e.g.
 *   `{apt: "playerctl", dnf: "playerctl"}`.
 * @returns {string|null} a ready-to-copy install command for whichever
 *   supported package manager is present on THIS machine, or null if none
 *   of the hinted package managers are installed here (or no hints given
 *   at all) — caller falls back to just naming the missing binary.
 */
export function suggestInstallCommand(packageHints) {
    if (!packageHints || typeof packageHints !== 'object')
        return null;

    for (const {key, command} of PACKAGE_MANAGERS) {
        const packageName = packageHints[key];
        if (typeof packageName === 'string' && packageName && isBinaryAvailable(key))
            return command(packageName);
    }
    return null;
}

/**
 * @param {object} metadata - a widget's parsed metadata.json.
 * @returns {Array<{bin: string, reason: string, installed: boolean, suggestedCommand: string|null}>}
 *   one entry per declared `dependencies.system[]` item; empty array for
 *   a widget that declares none (the overwhelmingly common case — pure
 *   GJS/DBus widgets like media-player need nothing system-side).
 */
export function checkWidgetDependencies(metadata) {
    const declared = metadata?.dependencies?.system;
    if (!Array.isArray(declared))
        return [];

    return declared
        .filter(dep => dep && typeof dep.bin === 'string' && dep.bin)
        .map(dep => ({
            bin: dep.bin,
            reason: typeof dep.reason === 'string' ? dep.reason : '',
            installed: isBinaryAvailable(dep.bin),
            suggestedCommand: suggestInstallCommand(dep.package),
        }));
}

/**
 * Convenience over checkWidgetDependencies() for callers (exportService's
 * import flow, a future "install widget" action) that only care whether
 * everything is satisfied.
 * @param {object} metadata
 * @returns {{ok: boolean, missing: Array<{bin: string, reason: string, suggestedCommand: string|null}>}}
 */
export function verifyWidgetDependencies(metadata) {
    const checked = checkWidgetDependencies(metadata);
    const missing = checked.filter(dep => !dep.installed);
    return {ok: missing.length === 0, missing};
}
