import Adw from "gi://Adw";

import Gtk from "gi://Gtk";

import Gdk from "gi://Gdk";

import GdkPixbuf from "gi://GdkPixbuf";

import GLib from "gi://GLib";

import { chooseFile, showReportDialog } from "./prefsDialogs.js";

import { buildGwctDocumentAsync, writeGwctFile, ensureGwctExtension } from "./exportService.js";

const SCREENSHOT_KEYBINDING_KEY = "theme-screenshot-keybinding";

const DEFAULT_SCREENSHOT_ACCEL = "<Super>Delete";

// Theme Pack screenshots are embedded as base64 inside the .gwct JSON, and
// shown at a small, fixed-aspect size in the overlay's theme-pack grid.
// Without downsizing here, a full desktop screenshot (e.g. a 4K capture)
// gets base64-encoded whole, ballooning the exported file for no visual
// benefit. Resize+crop to this fixed box before embedding, regardless of
// where the image came from (file picker or the desktop-capture keybinding).
const EXPORT_SCREENSHOT_WIDTH = 460;

const EXPORT_SCREENSHOT_HEIGHT = 270;

// Cover-fit + center-crop a source image down to a fixed box, the same way
// CSS `background-size: cover` would, then re-encode as PNG. Takes a path
// (both the file-picker flow and the desktop-capture flow always have one)
// rather than raw bytes, since GdkPixbuf's loader wants a file or stream.
function resizeScreenshotToCover(path, targetWidth = EXPORT_SCREENSHOT_WIDTH, targetHeight = EXPORT_SCREENSHOT_HEIGHT) {
    const source = GdkPixbuf.Pixbuf.new_from_file(path);
    const sourceWidth = source.get_width();
    const sourceHeight = source.get_height();
    if (!sourceWidth || !sourceHeight) throw new Error("screenshot has no readable dimensions");
    const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
    const scaledWidth = Math.max(1, Math.round(sourceWidth * scale));
    const scaledHeight = Math.max(1, Math.round(sourceHeight * scale));
    const scaled = source.scale_simple(scaledWidth, scaledHeight, GdkPixbuf.InterpType.BILINEAR);
    const offsetX = Math.max(0, Math.round((scaledWidth - targetWidth) / 2));
    const offsetY = Math.max(0, Math.round((scaledHeight - targetHeight) / 2));
    const cropWidth = Math.min(targetWidth, scaledWidth);
    const cropHeight = Math.min(targetHeight, scaledHeight);
    const cropped = scaled.new_subpixbuf(offsetX, offsetY, cropWidth, cropHeight);
    const [ok, buffer] = cropped.save_to_bufferv("png", [], []);
    if (!ok || !buffer) throw new Error("could not encode resized screenshot to PNG");
    return {
        bytes: buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer),
        mime: "image/png"
    };
}

function buildTimestampedThemeId(rawName) {
    const slug = rawName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "theme-pack";
    const timestamp = GLib.DateTime.new_now_local().format("%Y%m%d%H%M%S");
    return `${slug}-${timestamp}`;
}

function idleTick() {
    return new Promise(resolve => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

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
        const [ ok, parsedKeyval, parsedMods ] = Gtk.accelerator_parse(screenshotAccel);
        if (ok && parsedKeyval) screenshotAccelLabel = Gtk.accelerator_get_label(parsedKeyval, parsedMods);
    } catch (e) {
        logError(e, "[widget-center] themePackExportDialog: could not label desktop-share accel");
    }
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
            const resized = resizeScreenshotToCover(path);
            applyScreenshotPick(path, resized.bytes, resized.mime);
        } catch (e) {
            logError(e, "[widget-center] themePackExportDialog: could not read screenshot");
            showReportDialog(window, "Could not read screenshot", e.message);
        }
    });
    screenshotRow.add_suffix(screenshotButton);
    group.add(screenshotRow);
    if (prefill.screenshotPath) {
        (async () => {
            try {
                const resized = resizeScreenshotToCover(prefill.screenshotPath);
                applyScreenshotPick(prefill.screenshotPath, resized.bytes, resized.mime);
            } catch (e) {
                logError(e, "[widget-center] themePackExportDialog: could not attach prefilled screenshot");
            }
        })();
    }
    const progressBar = new Gtk.ProgressBar({
        show_text: true,
        visible: false,
        margin_top: 4,
        margin_bottom: 4,
        margin_start: 12,
        margin_end: 12
    });
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
        exportButton.sensitive = false;
        closeButton.sensitive = false;
        progressBar.fraction = 0;
        progressBar.text = "Collecting widget settings…";
        progressBar.visible = true;
        await idleTick();
        try {
            const candidates = prefill.widgetIds ? discoveredWidgets.filter(w => prefill.widgetIds.includes(w.id)) : discoveredWidgets;
            const {document: document} = await buildGwctDocumentAsync(candidates, {
                storage: storage,
                theme: theme,
                settings: settings
            }, (done, total) => {
                progressBar.fraction = total > 0 ? done / total : 1;
                progressBar.text = `Collecting widget settings… (${done}/${total})`;
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
            progressBar.fraction = 1;
            progressBar.text = "Writing file…";
            await idleTick();
            const finalPath = writeGwctFile(ensureGwctExtension(savePath), document);
            showReportDialog(window, "Theme pack exported", `Saved to ${finalPath}\nWidgets included: ${document.widgets.length}`, () => {
                window.close();
                parentWindow.close();
            });
        } catch (e) {
            logError(e, "[widget-center] themePackExportDialog: export failed");
            showReportDialog(window, "Export failed", e.message);
        } finally {
            progressBar.visible = false;
            exportButton.sensitive = true;
            closeButton.sensitive = true;
        }
    });
    bottomBar.append(exportButton);
    const bottomBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL
    });
    bottomBox.append(progressBar);
    bottomBox.append(bottomBar);
    toolbarView.add_bottom_bar(bottomBox);
    toolbarView.set_content(new Gtk.ScrolledWindow({
        child: page,
        vexpand: true
    }));
    window.set_content(toolbarView);
    window.present();
    return window;
}