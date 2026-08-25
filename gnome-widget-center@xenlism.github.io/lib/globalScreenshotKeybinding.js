import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Meta from "gi://Meta";

import Shell from "gi://Shell";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { captureDesktopScreenshotViaPortal } from "./screenshotPortal.js";

// How long to give Mutter's minimize animation to finish before the
// portal call actually captures the screen. There's no single, reliable
// "animation finished" signal to await here - the window manager's own
// 'minimize' completion signal only fires for the compositor's genie/
// scale effect, which reduced-motion setups skip entirely - so a short
// fixed delay is the simplest thing that covers both cases; being off by
// a frame or two doesn't matter for a screenshot.
const MINIMIZE_SETTLE_MS = 300;

function _sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

// A *real* system-wide keybinding for "capture the desktop for a theme
// pack export", registered via Main.wm.addKeybinding (Mutter/Shell-level
// grab) rather than a Gtk.ShortcutController on the export dialog's own
// window.
//
// Why this exists: Gtk.ShortcutController - even with
// Gtk.ShortcutScope.GLOBAL - only ever sees key events GTK itself
// receives, and only while that specific window exists. It's "global to
// the window", not "global to the desktop". Worse, the default
// accelerator is Super-modified (see theme-screenshot-keybinding in the
// gschema), and Super+<key> combos are grabbed by Mutter for the Shell's
// own use (overview, workspace switching, etc.) before a client
// application ever sees the event - so the GTK-side shortcut in
// lib/themePackExportDialog.js could never fire for that default no
// matter how it was wired. Only Main.wm.addKeybinding (this file) can
// claim a Super+<key> combination, because it registers the grab with
// Mutter directly instead of asking to be delivered a client-side event.
//
// This class owns the whole capture flow: minimize every normal window on
// the current workspace (so the theme-pack screenshot shows the bare
// desktop/panel rather than whatever happened to be open), screenshot
// (via the portal), restore those same windows, then hand the result to
// the prefs app as a freshly-launched (or focused, via GApplication's
// single-instance D-Bus activation) process, since the Shell process
// itself has no UI for the export dialog.
const KEYBINDING_KEY = "theme-screenshot-keybinding";

export class GlobalScreenshotKeybinding {
    constructor(extensionObject, gsettings, logger = null) {
        this._extension = extensionObject;
        this._gsettings = gsettings;
        this._logger = logger;
        this._added = false;
        this._busy = false;
    }
    enable() {
        this._addKeybinding();
    }
    disable() {
        this._removeKeybinding();
    }
    _addKeybinding() {
        try {
            Main.wm.addKeybinding(KEYBINDING_KEY, this._gsettings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.ALL, () => this._onTriggered());
            this._added = true;
        } catch (e) {
            console.error("[widget-center] global-screenshot: addKeybinding failed", e);
        }
    }
    _removeKeybinding() {
        if (!this._added) return;
        try {
            Main.wm.removeKeybinding(KEYBINDING_KEY);
        } catch (e) {
            console.error("[widget-center] global-screenshot: removeKeybinding failed", e);
        }
        this._added = false;
    }
    // Only ordinary app windows that are actually visible right now -
    // already-minimized windows are left alone (so they don't get
    // unminimized by _restoreWindows() afterward), and taskbar-skipping
    // windows (docks, the overview's own actors, etc.) are left alone too
    // since they're not the kind of clutter this feature exists to hide.
    // Scoped to the active workspace only: windows on other workspaces
    // aren't rendered on screen regardless, so minimizing them would be
    // pure churn with no effect on the screenshot.
    _minimizableWindows() {
        try {
            return global.workspace_manager.get_active_workspace().list_windows().filter(w => !w.minimized && !w.is_skip_taskbar() && w.get_window_type() === Meta.WindowType.NORMAL);
        } catch (e) {
            console.error("[widget-center] global-screenshot: could not list windows to minimize", e);
            return [];
        }
    }
    _minimizeAllWindows() {
        const windows = this._minimizableWindows();
        for (const w of windows) {
            try {
                w.minimize();
            } catch (e) {
                console.error("[widget-center] global-screenshot: failed to minimize a window", e);
            }
        }
        return windows;
    }
    _restoreWindows(windows) {
        for (const w of windows) {
            try {
                w.unminimize();
            } catch (e) {
                console.error("[widget-center] global-screenshot: failed to restore a window", e);
            }
        }
    }
    async _onTriggered() {
        if (this._busy) return;
        this._busy = true;
        this._logger?.debug("global-screenshot", "triggered");
        const minimized = this._minimizeAllWindows();
        try {
            if (minimized.length > 0) await _sleep(MINIMIZE_SETTLE_MS);
            const path = await this._capture();
            this._launchExportDialog(path);
        } catch (e) {
            console.error("[widget-center] global-screenshot: capture flow failed", e);
            // Still open the dialog even without a screenshot attached, so
            // the user isn't left with a silently-swallowed shortcut press.
            this._launchExportDialog(null);
        } finally {
            // Always put windows back, even if the capture itself failed -
            // this feature should never be the reason someone's open
            // windows stay minimized.
            this._restoreWindows(minimized);
            this._busy = false;
        }
    }
    _capture() {
        // Goes through the xdg-desktop-portal Screenshot portal rather
        // than calling org.gnome.Shell.Screenshot directly - recent
        // GNOME Shell rejects that private interface for callers outside
        // its own trusted set ("AccessDenied: Screenshot is not
        // allowed"), even from this extension's own process. The portal
        // works the same from here as it does from the separate prefs
        // app process (see lib/screenshotPortal.js).
        return captureDesktopScreenshotViaPortal();
    }
    _launchExportDialog(screenshotPath) {
        const scriptPath = GLib.build_filenamev([ this._extension.path, "widget-center-prefs-app.js" ]);
        const args = [ "gjs", "-m", scriptPath, "--export-theme-new" ];
        if (screenshotPath) args.push(`--attach-screenshot=${screenshotPath}`);
        try {
            // GApplication (HANDLES_COMMAND_LINE) means: if the prefs app is
            // already running, this forwards the command line to that
            // existing instance over D-Bus and focuses its window instead of
            // starting a second process - so this works whether the export
            // dialog/prefs window was already open or not, matching the
            // "shortcut works even with nothing open" requirement.
            Gio.Subprocess.new(args, Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error("[widget-center] global-screenshot: could not launch the prefs app", e);
        }
    }
}
