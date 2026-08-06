#!/usr/bin/gjs -m
// products/extension/widget-center-prefs-app.js
//
// 2026-07-30 addition ("แยกหน้าต่าง widget preference ออกมาอิสระจาก
// extension preference เลย ไม่ต้องเรียกผ่าน extension preference" — split
// the widget Settings window out to be fully independent of the
// extension-preferences flow, not routed through it at all):
//
// prefs.js's fillPreferencesWindow() is the officially-required GNOME
// entry point, but GNOME Shell — not us — decides when to actually call
// it: `Main.extensionManager.openExtensionPrefs()` either spawns a new
// prefs process or, if one is already running for this extension, does
// *something else* (re-focus, or its promise just rejects) that we have
// no control over. That indirection is the root of the whole
// "Preferences already open -> Settings click does nothing" bug this
// project kept chasing (see prefs.js's and extension.js's own 2026-07-30
// comments for that history) — every fix so far was a workaround bolted
// onto someone else's activation flow, not a fix of the flow itself.
//
// This file sidesteps that flow entirely. It's a plain `Adw.Application`
// with its own unique application-id, runnable directly (via `gjs -m
// widget-center-prefs-app.js`, a .desktop launcher, or a subprocess
// extension.js spawns — see that file's _openWidgetSettings()) with NO
// dependency on GNOME's extension-prefs machinery, `Main`,
// `ExtensionPreferences`, or even the extension being enabled. Single-
// instance activation is handled by GLib/GIO itself, the same mechanism
// every other GNOME app relies on: launching this a second time while
// the first is still running doesn't start a second process at all — it
// hands the new argv off to the *existing* primary instance over D-Bus,
// which is exactly the "jump to a different widget's page while the
// window is already open" behavior this project was previously trying to
// reconstruct by hand via a `requested-widget-id` GSettings key polled/
// subscribed-to across two independent processes.
//
// All the actual window content is unchanged — this file and prefs.js
// both just call the SAME lib/prefsWindowController.js, so there is
// exactly one implementation of "what the Settings window looks like",
// not two to keep in sync. This checkpoint's PrefsWindowController.build()
// is `async` (it awaits i18n strings before building anything - see that
// method's own doc comment), so presentWindow() below awaits it too,
// unlike the smaller/earlier checkpoint this file was first written
// against.
//
// NOT verified end-to-end on real GNOME Shell hardware yet — argv
// handling in a `gjs -m` (ES module) entry point is newer/less
// battle-tested in this codebase than anything else here (everything
// else runs as a Shell extension or a GNOME-invoked prefs process, never
// as a bare `gjs` command line) — treat the exact `ARGV`/command-line
// plumbing below as the first thing to check against a real log if
// launching this ever silently does nothing.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {PrefsWindowController} from './lib/prefsWindowController.js';

// Reverse-DNS'd from this extension's own uuid (metadata.json) rather
// than picked arbitrarily, so it's obviously "the same project" to
// anyone reading a D-Bus name list or `.desktop` file, and so it can
// never collide with an unrelated app's single-instance registration.
const APPLICATION_ID = 'io.github.xenlism.WidgetCenterPrefs';

// This script's own directory = the extension's install directory (this
// file lives at the extension root, right next to extension.js/
// metadata.json/schemas/) — resolved from the script's own URL rather
// than assumed from argv[0] or cwd, so it keeps working regardless of how
// or from where this was launched (an absolute-path .desktop Exec=, a
// relative `gjs -m` invocation from any cwd, or extension.js's own
// Gio.Subprocess call).
const EXTENSION_PATH = GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0]
);

const app = new Adw.Application({
    application_id: APPLICATION_ID,
    flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE,
});

/** @type {Adw.PreferencesWindow|null} the single window this app ever shows. */
let window = null;
/** @type {PrefsWindowController|null} */
let controller = null;
/** @type {Promise|null} guards against build() being kicked off twice by overlapping calls (see presentWindow()). */
let buildPromise = null;

/**
 * Shows the (single, shared) Preferences window, creating it on first
 * call. Safe to call repeatedly — every subsequent call (including ones
 * arriving via the primary-instance 'command-line' handoff below, from a
 * completely separate `gjs` process that already exited) just re-presents
 * the same window and, if a widget id was requested, jumps to that
 * widget's page on top of whatever was already showing.
 *
 * `await`s PrefsWindowController.build() — this checkpoint's version is
 * `async` (it loads i18n strings first) — so a second invocation arriving
 * while the first build() is still in flight (e.g. two command-line
 * activations landing back to back before GTK has even mapped a window
 * yet) waits on the SAME build rather than kicking off a second one.
 * @param {string|null} requestedWidgetId
 * @param {string|null} focusTarget - 'preferences' jumps straight to the
 *   Preferences top-level tab instead of leaving Overview showing (added
 *   for lib/widgetCenterOverlay.js's Settings tab, which already has its
 *   own native widget list and only wants Store/Preferences from this
 *   window — see PrefsWindowController.showPreferencesPage()'s own doc
 *   comment for why this can't just remove the Overview tab outright:
 *   this app is a shared single-instance window, and a plain `gjs -m
 *   widget-center-prefs-app.js` or gear-icon launch still needs Overview
 *   to be there). 'backup' (`--focus=backup`) goes one step further and
 *   also selects the Backup & Restore category within Preferences — see
 *   PrefsWindowController.showBackupPage(); added for the overlay's own
 *   Backup button.
 * @param {string|null} exportThemeId - `--export-theme-id=<id>`: opens
 *   the Export Theme dialog prefilled from that already-discovered theme
 *   pack, for the overlay's per-card Export button (see
 *   PrefsWindowController.openExportThemeDialogForPack()).
 * @param {boolean} exportThemeNew - `--export-theme-new`: opens the same
 *   dialog blank (current live-desktop widget selection), for the
 *   overlay's Themes-tab "Export current desktop…" action.
 */
async function presentWindow(requestedWidgetId, focusTarget = null, exportThemeId = null, exportThemeNew = false) {
    if (!controller) {
        window = new Adw.PreferencesWindow({application: app});
        controller = new PrefsWindowController(EXTENSION_PATH);
        buildPromise = controller.build(window).catch(e => {
            logError(e, '[widget-center] widget-center-prefs-app: build() failed');
        });
        window.connect('close-request', () => {
            window = null;
            controller = null;
            buildPromise = null;
            return false;
        });
    }

    await buildPromise;
    if (!window)
        return; // closed again already while build() was still resolving.

    if (requestedWidgetId)
        controller.jumpToWidget(window, requestedWidgetId);
    else if (focusTarget === 'backup')
        controller.showBackupPage(window);
    else if (focusTarget === 'preferences')
        controller.showPreferencesPage(window);

    window.present();

    // Opened alongside (not instead of) the base window above — the
    // Export dialog is its own transient Adw.Window, not a page inside
    // this one (see themePackExportDialog.js), so there's always a
    // sensible window underneath it either way.
    if (exportThemeId)
        controller.openExportThemeDialogForPack(window, exportThemeId);
    else if (exportThemeNew)
        controller.openExportThemeDialog(window);
}

/** Plain launch, no arguments — e.g. from a .desktop file with no Exec= arguments, or `gjs -m` with none. */
app.connect('activate', () => {
    presentWindow(null).catch(e => logError(e, '[widget-center] widget-center-prefs-app: activate failed'));
});

// Fires for EVERY invocation of this application-id, including from a
// brand new `gjs` process spawned while this one is already the
// registered primary instance for APPLICATION_ID — GApplication's own
// single-instance handshake hands that second process's command line off
// to *this* running instance over D-Bus (the new process itself just
// exits) instead of us ever having two windows, two processes, or a
// dconf round-trip involved. That handoff is the whole reason this file
// exists — see this file's header.
app.connect('command-line', (application, commandLine) => {
    const argv = commandLine.get_arguments();
    let requestedWidgetId = null;
    let focusTarget = null;
    let exportThemeId = null;
    let exportThemeNew = false;
    for (const arg of argv) {
        if (arg.startsWith('--widget-id='))
            requestedWidgetId = arg.slice('--widget-id='.length);
        else if (arg.startsWith('--focus='))
            focusTarget = arg.slice('--focus='.length);
        else if (arg.startsWith('--export-theme-id='))
            exportThemeId = arg.slice('--export-theme-id='.length);
        else if (arg === '--export-theme-new')
            exportThemeNew = true;
    }
    presentWindow(requestedWidgetId, focusTarget, exportThemeId, exportThemeNew).catch(e =>
        logError(e, '[widget-center] widget-center-prefs-app: command-line handling failed'));
    return 0;
});

// `ARGV` here is GJS's own global for the script's command-line
// arguments (distinct from `argv`/`commandLine.get_arguments()` above,
// which is GApplication's OWN copy, re-delivered on every invocation —
// this initial call only covers the very first process's own launch).
app.run([System.programInvocationName, ...ARGV]);
