#!/usr/bin/gjs -m
import Adw from "gi://Adw";

import Gio from "gi://Gio";

import GLib from "gi://GLib";

import Gtk from "gi://Gtk";

import Gdk from "gi://Gdk";

import System from "system";

import { PrefsWindowControllerV2 } from "./lib/prefsWindowController.js";

import { WidgetSettings } from "./lib/widgetSettings.js";

const APPLICATION_ID = "io.github.xenlism.WidgetCenterPrefs";

const EXTENSION_PATH = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

const app = new Adw.Application({
    application_id: APPLICATION_ID,
    flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE
});

// Make our own assets/ directory available as an icon lookup location so we
// can reference our bundled icon.svg / icon.png by name ("icon") instead of
// relying on the icon being installed into the system's hicolor theme.
function registerAppIconSearchPath() {
    try {
        const display = Gdk.Display.get_default();
        if (!display) return;
        const iconTheme = Gtk.IconTheme.get_for_display(display);
        iconTheme.add_search_path(GLib.build_filenamev([ EXTENSION_PATH, "assets" ]));
    } catch (e) {
        logError(e, "[widget-center] widget-center-prefs-app: could not register icon search path");
    }
}

app.connect("startup", () => {
    registerAppIconSearchPath();
});

// Safety net alongside the close-request flush above, in case the process
// ever exits some other way (e.g. the compositor/session closing the
// window without a normal close-request, like on logout).
app.connect("shutdown", () => {
    WidgetSettings.flushAll();
});

let window = null;

let controller = null;

let buildPromise = null;

async function presentWindow(requestedWidgetId, focusTarget = null, exportThemeId = null, exportThemeNew = false, attachScreenshotPath = null) {
    if (!controller) {
        window = new Adw.PreferencesWindow({
            application: app,
            icon_name: "icon"
        });
        controller = new PrefsWindowControllerV2(EXTENSION_PATH);
        buildPromise = controller.build(window).catch(e => {
            logError(e, "[widget-center] widget-center-prefs-app: build() failed");
        });
        window.connect("close-request", () => {
            // Field edits in a widget's settings page are saved through a
            // 300ms-debounced Proxy (see WidgetSettings.load() in
            // lib/widgetSettings.js) so rapid edits don't hit disk on every
            // keystroke. But nothing was flushing that pending write before
            // this window (and, since it's usually the app's only window,
            // the whole gjs process) closed - so an edit made and then
            // closed within that 300ms window was silently lost, never
            // written to the widget's settings.json at all. Flush any
            // pending debounced saves synchronously here, before the window
            // (and the process behind it) actually goes away.
            WidgetSettings.flushAll();
            window = null;
            controller = null;
            buildPromise = null;
            return false;
        });
        const escController = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.BUBBLE
        });
        escController.connect("key-pressed", (_ctrl, keyval) => {
            if (keyval === Gdk.KEY_Escape) {
                window.close();
                return true;
            }
            return false;
        });
        window.add_controller(escController);
    }
    await buildPromise;
    if (!window) return;
    if (requestedWidgetId) controller.jumpToWidget(window, requestedWidgetId); else if (focusTarget === "backup") controller.showBackupPage(window); else if (focusTarget === "preferences") controller.showPreferencesPage(window);
    window.present();
    if (exportThemeId) await controller.openExportThemeDialogForPack(window, exportThemeId); else if (exportThemeNew) controller.openExportThemeDialog(window, attachScreenshotPath ? {
        screenshotPath: attachScreenshotPath
    } : {});
}

app.connect("activate", () => {
    presentWindow(null).catch(e => logError(e, "[widget-center] widget-center-prefs-app: activate failed"));
});

app.connect("command-line", (application, commandLine) => {
    const argv = commandLine.get_arguments();
    let requestedWidgetId = null;
    let focusTarget = null;
    let exportThemeId = null;
    let exportThemeNew = false;
    let attachScreenshotPath = null;
    for (const arg of argv) {
        if (arg.startsWith("--widget-id=")) requestedWidgetId = arg.slice("--widget-id=".length); else if (arg.startsWith("--focus=")) focusTarget = arg.slice("--focus=".length); else if (arg.startsWith("--export-theme-id=")) exportThemeId = arg.slice("--export-theme-id=".length); else if (arg === "--export-theme-new") exportThemeNew = true; else if (arg.startsWith("--attach-screenshot=")) attachScreenshotPath = arg.slice("--attach-screenshot=".length);
    }
    presentWindow(requestedWidgetId, focusTarget, exportThemeId, exportThemeNew, attachScreenshotPath).catch(e => logError(e, "[widget-center] widget-center-prefs-app: command-line handling failed"));
    return 0;
});

app.run([ System.programInvocationName, ...ARGV ]);