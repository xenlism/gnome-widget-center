import Adw from "gi://Adw";

import Gtk from "gi://Gtk";

import Gdk from "gi://Gdk";

import GLib from "gi://GLib";

import { chooseFile, showReportDialog } from "./prefsDialogs.js";

import { buildGwctDocument, writeGwctFile, ensureGwctExtension } from "./exportService.js";

import { readBytesFile } from "./fsUtils.js";

import { captureDesktopScreenshotViaPortal } from "./screenshotPortal.js";

const SCREENSHOT_KEYBINDING_KEY = "theme-screenshot-keybinding";

const DEFAULT_SCREENSHOT_ACCEL = "<Super>Delete";

/**
 * Builds a theme pack id from its display name plus an export timestamp,
 * so re-exporting the same name never collides with a previous pack:
 * "My Cool Theme" -> "my-cool-theme-20260812153045" (yyyymmddhhmmss, local time).
 */
function buildTimestampedThemeId(rawName) {
    const slug = rawName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "theme-pack";
    const timestamp = GLib.DateTime.new_now_local().format("%Y%m%d%H%M%S");
    return `${slug}-${timestamp}`;
}

/**
 * Hides `window` and waits a beat before resolving, so the compositor has
 * actually unmapped/redrawn behind it before a screenshot is taken. Without
 * this, the export dialog - being the top-most window at the moment the
 * shortcut/button fires - ends up baked into its own "desktop" screenshot
 * instead of the clean desktop underneath it. Caller is responsible for
 * calling `window.present()` again afterward (in a `finally`, so the dialog
 * always comes back even if the capture itself fails).
 */
function hideWindowDuringCapture(window) {
    return new Promise(resolve => {
        window.set_visible(false);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

const MIME_BY_EXTENSION = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const URL_PATTERN = /^https?:\/\/[^\s]+\.[^\s]+$/i;

export function openThemePackExportDialog(parentWindow, services, prefill = {}) {
    const {storage: storage, theme: theme, settings: settings, discoveredWidgets: discoveredWidgets} = services;
    const window = new Adw.Window({
        transient_for: parentWindow,
        modal: true,
        default_width: 480,
        default_height: 560,
        title: "Export Theme…"
    });
    const toolbarView = new Adw.ToolbarView;
    const header = new Adw.HeaderBar({
        show_end_title_buttons: true
    });
    toolbarView.add_top_bar(header);
    const page = new Adw.PreferencesPage;
    const group = new Adw.PreferencesGroup({
        title: "Theme pack details",
        description: "Shown to anyone who opens this .gwct file in their own Widget Center."
    });
    page.add(group);
    const nameRow = new Adw.EntryRow({
        title: "Name"
    });
    nameRow.text = prefill.name ?? "";
    group.add(nameRow);
    const descRow = new Adw.EntryRow({
        title: "Description"
    });
    descRow.text = prefill.description ?? "";
    group.add(descRow);
    const authorRow = new Adw.EntryRow({
        title: "Author"
    });
    authorRow.text = prefill.author ?? "";
    group.add(authorRow);
    const emailRow = new Adw.EntryRow({
        title: "Email"
    });
    emailRow.text = prefill.email ?? "";
    group.add(emailRow);
    const urlRow = new Adw.EntryRow({
        title: "URL"
    });
    urlRow.text = prefill.url ?? "";
    group.add(urlRow);
    const markValidity = (row, pattern) => {
        const text = row.text.trim();
        const invalid = text.length > 0 && !pattern.test(text);
        row.set_css_classes(invalid ? [ "error" ] : []);
        return !invalid;
    };
    emailRow.connect("notify::text", () => markValidity(emailRow, EMAIL_PATTERN));
    urlRow.connect("notify::text", () => markValidity(urlRow, URL_PATTERN));
    let screenshotPick = null;
    const screenshotAccel = settings?.isReady ? settings.getGlobalValue(SCREENSHOT_KEYBINDING_KEY)?.[0] || DEFAULT_SCREENSHOT_ACCEL : DEFAULT_SCREENSHOT_ACCEL;
    let screenshotAccelLabel = screenshotAccel;
    try {
        // gtk_accelerator_parse() is `gboolean` in GTK4 (it was `void` in
        // GTK3), so the gjs binding returns a 3-tuple [ok, key, mods] —
        // not [key, mods]. Destructuring only two values here used to
        // shift `mods` into where `key` belongs and the real keyval (e.g.
        // 0xffff for Delete) into where `mods` belongs, which then made
        // accelerator_get_label() throw "0xffff is not a valid value for
        // flags argument accelerator_mods".
        const [ ok, parsedKeyval, parsedMods ] = Gtk.accelerator_parse(screenshotAccel);
        if (ok && parsedKeyval) screenshotAccelLabel = Gtk.accelerator_get_label(parsedKeyval, parsedMods);
    } catch (e) {
        logError(e, "[widget-center] themePackExportDialog: could not label desktop-share accel");
    }
    // Adw.ActionRow's subtitle is interpreted as Pango markup by default,
    // so anything interpolated into it must be escaped - including the
    // "already-labeled" success path, not just the raw-accel-string
    // fallback above. The raw accel string itself (e.g. "<Super>Delete")
    // is the case that actually broke markup parsing before: if the try
    // block above throws, `screenshotAccelLabel` is still that raw
    // string, and "<Super>" isn't a valid markup tag.
    const screenshotSubtitle = GLib.markup_escape_text(`No image selected — or press ${screenshotAccelLabel} to capture the desktop`, -1);
    const screenshotRow = new Adw.ActionRow({
        title: "Screenshot",
        subtitle: screenshotSubtitle
    });
    const applyScreenshotPick = (path, bytes, mime) => {
        screenshotPick = {
            path: path,
            bytes: bytes,
            mime: mime
        };
        screenshotRow.subtitle = GLib.markup_escape_text(GLib.path_get_basename(path), -1);
    };
    const runDesktopShare = async () => {
        try {
            // Just hide this dialog (so it isn't baked into its own
            // "desktop" screenshot) then capture via the portal - no
            // Show-Desktop/minimize-other-windows dance, no D-Bus service
            // beyond the portal itself. The capture may include whatever
            // other windows are on screen; that's expected now.
            await hideWindowDuringCapture(window);
            let path;
            try {
                path = await captureDesktopScreenshotViaPortal();
            } finally {
                window.present();
            }
            const bytes = readBytesFile(path);
            if (!bytes) throw new Error("could not read the captured screenshot");
            applyScreenshotPick(path, bytes, "image/png");
        } catch (e) {
            logError(e, "[widget-center] themePackExportDialog: desktop share capture failed");
            showReportDialog(window, "Could not capture the desktop", `${e.message}\n\nMake sure the desktop portal (xdg-desktop-portal) is running ` + "on this session, or use Browse… instead.");
        }
    };
    const screenshotButton = new Gtk.Button({
        label: "Browse…",
        valign: Gtk.Align.CENTER
    });
    screenshotButton.connect("clicked", async () => {
        const path = await chooseFile(window, {
            action: "open",
            title: "Choose a screenshot image",
            pattern: "*.png"
        });
        if (!path) return;
        try {
            const bytes = readBytesFile(path);
            if (!bytes) throw new Error("could not read the chosen file");
            const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
            const mime = MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
            applyScreenshotPick(path, bytes, mime);
        } catch (e) {
            logError(e, "[widget-center] themePackExportDialog: could not read screenshot");
            showReportDialog(window, "Could not read screenshot", e.message);
        }
    });
    screenshotRow.add_suffix(screenshotButton);
    const shareDesktopButton = new Gtk.Button({
        label: "Share desktop",
        valign: Gtk.Align.CENTER,
        tooltip_text: `Capture the desktop now (shortcut: ${screenshotAccelLabel}, works even when this window isn't open)`
    });
    shareDesktopButton.connect("clicked", () => runDesktopShare());
    screenshotRow.add_suffix(shareDesktopButton);
    group.add(screenshotRow);
    // NOTE: the actual ${screenshotAccel} keypress is handled by a real
    // system-wide Mutter grab (lib/globalScreenshotKeybinding.js, added
    // via Main.wm.addKeybinding from extension.js) - not by a
    // Gtk.ShortcutController here. A GTK-level shortcut can only ever be
    // "global to this window", and the default accel is Super-modified,
    // which the Shell reserves for itself before any client app would
    // see the event - so a window-scoped shortcut could never actually
    // fire for it. See globalScreenshotKeybinding.js for the full
    // capture -> restore -> launch/focus-this-dialog flow; if this
    // dialog is already open when the shortcut fires, that flow re-runs
    // captureDesktopScreenshot/hideWindowDuringCapture from this same
    // process rather than this button's runDesktopShare, so both paths
    // share the "hide dialog, wait for redraw" behavior independently.
    if (prefill.screenshotPath) {
        try {
            const bytes = readBytesFile(prefill.screenshotPath);
            if (bytes) applyScreenshotPick(prefill.screenshotPath, bytes, "image/png");
        } catch (e) {
            logError(e, "[widget-center] themePackExportDialog: could not attach prefilled screenshot");
        }
    }
    const bottomBar = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        halign: Gtk.Align.END,
        margin_top: 8,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12
    });
    const closeButton = new Gtk.Button({
        label: "Close"
    });
    closeButton.connect("clicked", () => window.close());
    bottomBar.append(closeButton);
    const exportButton = new Gtk.Button({
        label: "Export",
        css_classes: [ "suggested-action" ]
    });
    exportButton.connect("clicked", async () => {
        if (!nameRow.text.trim()) {
            showReportDialog(window, "Give this theme pack a name", "The Name field can't be empty.");
            return;
        }
        if (!markValidity(emailRow, EMAIL_PATTERN)) {
            showReportDialog(window, "Check the Email field", `"${emailRow.text.trim()}" doesn't look like a valid email address.`);
            return;
        }
        if (!markValidity(urlRow, URL_PATTERN)) {
            showReportDialog(window, "Check the URL field", `"${urlRow.text.trim()}" doesn't look like a valid URL (must start with http:// or https://).`);
            return;
        }
        const defaultName = ensureGwctExtension(nameRow.text.trim().replace(/[^\w.-]+/g, "-") || "theme-pack");
        const savePath = await chooseFile(window, {
            action: "save",
            title: "Save theme pack",
            initialName: defaultName,
            initialFolder: GLib.get_home_dir(),
            pattern: "*.gwct"
        });
        if (!savePath) return;
        try {
            const candidates = prefill.widgetIds ? discoveredWidgets.filter(w => prefill.widgetIds.includes(w.id)) : discoveredWidgets;
            const {document: document} = buildGwctDocument(candidates, {
                storage: storage,
                theme: theme,
                settings: settings
            });
            document.packMeta = {
                id: buildTimestampedThemeId(nameRow.text),
                name: nameRow.text.trim(),
                description: descRow.text.trim(),
                author: authorRow.text.trim(),
                email: emailRow.text.trim(),
                url: urlRow.text.trim()
            };
            if (screenshotPick) {
                document.screenshot = {
                    mimeType: screenshotPick.mime,
                    base64: GLib.base64_encode(screenshotPick.bytes)
                };
            }
            const finalPath = writeGwctFile(ensureGwctExtension(savePath), document);
            showReportDialog(window, "Theme pack exported", `Saved to ${finalPath}\nWidgets included: ${document.widgets.length}`);
            window.close();
        } catch (e) {
            logError(e, "[widget-center] themePackExportDialog: export failed");
            showReportDialog(window, "Export failed", e.message);
        }
    });
    bottomBar.append(exportButton);
    toolbarView.add_bottom_bar(bottomBar);
    toolbarView.set_content(new Gtk.ScrolledWindow({
        child: page,
        vexpand: true
    }));
    window.set_content(toolbarView);
    window.present();
    return window;
}