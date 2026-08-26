import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Meta from "gi://Meta";

import Shell from "gi://Shell";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { captureDesktopScreenshotViaPortal } from "../screenshotPortal.js";

const MINIMIZE_SETTLE_MS = 300;

function _sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

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
            this._logger?.error("global-screenshot: addKeybinding failed", e);
        }
    }
    _removeKeybinding() {
        if (!this._added) return;
        try {
            Main.wm.removeKeybinding(KEYBINDING_KEY);
        } catch (e) {
            this._logger?.error("global-screenshot: removeKeybinding failed", e);
        }
        this._added = false;
    }
    _minimizableWindows() {
        try {
            return global.workspace_manager.get_active_workspace().list_windows().filter(w => !w.minimized && !w.is_skip_taskbar() && w.get_window_type() === Meta.WindowType.NORMAL);
        } catch (e) {
            this._logger?.error("global-screenshot: could not list windows to minimize", e);
            return [];
        }
    }
    _minimizeAllWindows() {
        const windows = this._minimizableWindows();
        for (const w of windows) {
            try {
                w.minimize();
            } catch (e) {
                this._logger?.error("global-screenshot: failed to minimize a window", e);
            }
        }
        return windows;
    }
    _restoreWindows(windows) {
        for (const w of windows) {
            try {
                w.unminimize();
            } catch (e) {
                this._logger?.error("global-screenshot: failed to restore a window", e);
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
            this._logger?.error("global-screenshot: capture flow failed", e);
            this._launchExportDialog(null);
        } finally {
            this._restoreWindows(minimized);
            this._busy = false;
        }
    }
    _capture() {
        return captureDesktopScreenshotViaPortal();
    }
    _launchExportDialog(screenshotPath) {
        const scriptPath = GLib.build_filenamev([ this._extension.path, "widget-center-prefs-app.js" ]);
        const args = [ "gjs", "-m", scriptPath, "--export-theme-new" ];
        if (screenshotPath) args.push(`--attach-screenshot=${screenshotPath}`);
        try {
            Gio.Subprocess.new(args, Gio.SubprocessFlags.NONE);
        } catch (e) {
            this._logger?.error("global-screenshot: could not launch the prefs app", e);
        }
    }
}
