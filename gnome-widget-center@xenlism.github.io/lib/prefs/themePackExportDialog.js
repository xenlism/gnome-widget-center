import Adw from "gi://Adw";

import Gtk from "gi://Gtk";

import Gdk from "gi://Gdk";

import GdkPixbuf from "gi://GdkPixbuf";

import GLib from "gi://GLib";

import Soup from "gi://Soup";

import { chooseFile, showReportDialog } from "./prefsDialogs.js";

import { buildGwctDocumentAsync, writeGwctFile, ensureGwctExtension } from "../exportService.js";

const SCREENSHOT_KEYBINDING_KEY = "theme-screenshot-keybinding";

const DEFAULT_SCREENSHOT_ACCEL = "<Super>Delete";

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

// ── HTTP helper (Soup 3 — available in GNOME 42+, no fetch needed) ───────────
// GJS prefs processes do not expose a global `fetch`; we use libsoup instead.
const _soupSession = new Soup.Session();

function soupPostJson(url, requestBody, headers = {}) {
    return new Promise((resolve, reject) => {
        let message;
        try {
            message = Soup.Message.new("POST", url);
        } catch (e) {
            reject(new Error(`Bad URL: ${url}`));
            return;
        }

        for (const [key, value] of Object.entries(headers))
            message.get_request_headers().append(key, value);

        const encoded = new TextEncoder().encode(JSON.stringify(requestBody));
        message.set_request_body_from_bytes(
            "application/json",
            GLib.Bytes.new(encoded)
        );

        _soupSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (_session, asyncResult) => {
                try {
                    const bytes = _soupSession.send_and_read_finish(asyncResult);
                    const status = message.get_status();
                    if (status < 200 || status >= 300)
                        throw new Error(`AI service error: HTTP ${status}`);
                    const text = new TextDecoder().decode(bytes.get_data());
                    resolve(JSON.parse(text));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

// ─────────────────────────────────────────────────────────────────────────────

// ── AI meta-generation ────────────────────────────────────────────────────────
// 2026-09-27: Pollinations retired its old key-free text.pollinations.ai/openai
// endpoint (now legacy → HTTP 404) in favor of a unified gen.pollinations.ai
// API that requires a free "pk_" publishable key from enter.pollinations.ai.
//
// The ✦ AI buttons call Pollinations directly using the key the user pasted
// into Preferences → Import/Export → Theme pack (pollinations-api-key).
//
// Modes:
//   name + image  → generates description only
//   image only    → suggests both name and description
//   name only     → generates description from name alone (no vision)
const POLLINATIONS_CHAT_URL = "https://gen.pollinations.ai/v1/chat/completions";

function buildAiPrompt(name, hasImage) {
    const hasName = typeof name === "string" && name.trim().length > 0;
    if (hasName && hasImage) {
        return `This is a preview screenshot from a GNOME desktop themepack named "${name.trim()}". ` +
               `Write a compelling 2-sentence description capturing its visual style, color palette, and mood. ` +
               `Reply with ONLY valid JSON, no markdown fences: {"description":"..."}`;
    }
    if (hasImage) {
        return `Look at this GNOME desktop screenshot. ` +
               `Suggest a creative, evocative themepack name (2–4 words) and write a 2-sentence description. ` +
               `Reply with ONLY valid JSON, no markdown fences: {"name":"...","description":"..."}`;
    }
    return `Write a compelling 2-sentence description for a GNOME desktop themepack named "${name.trim()}". ` +
           `Reply with ONLY valid JSON, no markdown fences: {"description":"..."}`;
}

async function generateViaPollinations(promptText, base64Image, imageMime, pollinationsKey) {
    if (!pollinationsKey)
        throw new Error(
            "No Pollinations API key is set. Add a free key from " +
            "enter.pollinations.ai in Preferences → Import/Export."
        );
    const userContent = [{ type: "text", text: promptText }];
    if (base64Image)
        userContent.push({ type: "image_url", image_url: { url: `data:${imageMime};base64,${base64Image}` } });

    const data = await soupPostJson(
        POLLINATIONS_CHAT_URL,
        { model: "openai", messages: [{ role: "user", content: userContent }] },
        { Authorization: `Bearer ${pollinationsKey}` }
    );
    return data.choices?.[0]?.message?.content ?? "";
}

async function generateAiMeta(name, base64Image, imageMime = "image/png", pollinationsKey = null) {
    const hasName = typeof name === "string" && name.trim().length > 0;
    const hasImage = typeof base64Image === "string" && base64Image.length > 0;

    if (!hasName && !hasImage)
        throw new Error("Provide a name or add a screenshot so AI has something to work with.");

    const promptText = buildAiPrompt(name, hasImage);

    const raw = await generateViaPollinations(promptText, hasImage ? base64Image : null, imageMime, pollinationsKey);

    // Strip markdown fences the model occasionally wraps despite instructions
    const cleaned = raw.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();

    try {
        return JSON.parse(cleaned);
    } catch {
        // Try to extract the first JSON object in the string
        const match = cleaned.match(/\{[\s\S]*?\}/);
        if (match) {
            try { return JSON.parse(match[0]); } catch { /* fall through */ }
        }
        // Plain-text fallback: treat entire response as the description
        return { description: cleaned };
    }
}
// ─────────────────────────────────────────────────────────────────────────────

export function openThemePackExportDialog(parentWindow, services, prefill = {}) {
    const {storage: storage, theme: theme, settings: settings, discoveredWidgets: discoveredWidgets} = services;
    const tr = typeof services.tr === "function" ? services.tr : (key, fallback) => fallback;

    const window = new Adw.Window({
        transient_for: parentWindow,
        modal: true,
        default_width: 480,
        default_height: 560,
        title: tr("importexport.exportpack.title", "Export Theme…")
    });

    const toolbarView = new Adw.ToolbarView;
    const header = new Adw.HeaderBar({
        show_end_title_buttons: true
    });
    toolbarView.add_top_bar(header);

    const page = new Adw.PreferencesPage;
    const group = new Adw.PreferencesGroup({
        title: tr("export.group.title", "Theme pack details"),
        description: tr("export.group.description", "Shown to anyone who opens this .gwct file in their own Widget Center.")
    });
    page.add(group);

    // ── Name row ──────────────────────────────────────────────────────────────
    const nameRow = new Adw.EntryRow({
        title: tr("export.field.name", "Name")
    });
    nameRow.text = prefill.name ?? "";

    // AI spinner + button for the name field
    const nameSpinner = new Gtk.Spinner({ valign: Gtk.Align.CENTER });
    nameSpinner.visible = false;

    const nameAiBtn = new Gtk.Button({
        label: tr("export.ai.name_btn", "✦ AI"),
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
        tooltip_text: tr("export.ai.name_tooltip", "Suggest a name from the screenshot")
    });
    nameRow.add_suffix(nameSpinner);
    nameRow.add_suffix(nameAiBtn);
    group.add(nameRow);

    // ── Description row ───────────────────────────────────────────────────────
    const descRow = new Adw.EntryRow({
        title: tr("export.field.description", "Description")
    });
    descRow.text = prefill.description ?? "";

    // AI spinner + button for the description field
    const descSpinner = new Gtk.Spinner({ valign: Gtk.Align.CENTER });
    descSpinner.visible = false;

    const descAiBtn = new Gtk.Button({
        label: tr("export.ai.desc_btn", "✦ AI"),
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
        tooltip_text: tr("export.ai.desc_tooltip", "Generate description from name + screenshot")
    });
    descRow.add_suffix(descSpinner);
    descRow.add_suffix(descAiBtn);
    group.add(descRow);

    // ── Remaining metadata rows (unchanged) ───────────────────────────────────
    const authorRow = new Adw.EntryRow({
        title: tr("export.field.author", "Author")
    });
    authorRow.text = prefill.author ?? "";
    group.add(authorRow);

    const emailRow = new Adw.EntryRow({
        title: tr("export.field.email", "Email")
    });
    emailRow.text = prefill.email ?? "";
    group.add(emailRow);

    const urlRow = new Adw.EntryRow({
        title: tr("export.field.url", "URL")
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

    // ── Screenshot row (unchanged) ────────────────────────────────────────────
    let screenshotPick = null;
    const screenshotAccel = settings?.isReady
        ? settings.getGlobalValue(SCREENSHOT_KEYBINDING_KEY)?.[0] || DEFAULT_SCREENSHOT_ACCEL
        : DEFAULT_SCREENSHOT_ACCEL;
    let screenshotAccelLabel = screenshotAccel;
    try {
        const [ ok, parsedKeyval, parsedMods ] = Gtk.accelerator_parse(screenshotAccel);
        if (ok && parsedKeyval) screenshotAccelLabel = Gtk.accelerator_get_label(parsedKeyval, parsedMods);
    } catch (e) {
        logError(e, "[widget-center] themePackExportDialog: could not label desktop-share accel");
    }

    const screenshotSubtitle = GLib.markup_escape_text(
        tr("export.screenshot.none", "No image selected — or press {accel} to capture the desktop")
            .replace("{accel}", screenshotAccelLabel),
        -1
    );
    const screenshotRow = new Adw.ActionRow({
        title: tr("export.screenshot.title", "Screenshot"),
        subtitle: screenshotSubtitle
    });

    const applyScreenshotPick = (path, bytes, mime) => {
        screenshotPick = { path: path, bytes: bytes, mime: mime };
        screenshotRow.subtitle = GLib.markup_escape_text(GLib.path_get_basename(path), -1);
    };

    const screenshotButton = new Gtk.Button({
        label: tr("shared.browse", "Browse…"),
        valign: Gtk.Align.CENTER
    });
    screenshotButton.connect("clicked", async () => {
        const path = await chooseFile(window, {
            action: "open",
            title: tr("export.screenshot.chooser_title", "Choose a screenshot image"),
            pattern: "*.png"
        });
        if (!path) return;
        try {
            const resized = resizeScreenshotToCover(path);
            applyScreenshotPick(path, resized.bytes, resized.mime);
        } catch (e) {
            logError(e, "[widget-center] themePackExportDialog: could not read screenshot");
            showReportDialog(window, tr("export.screenshot.read_failed", "Could not read screenshot"), e.message);
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

    // ── AI button handlers ────────────────────────────────────────────────────
    // These are wired here (after screenshotPick is declared) and rely on
    // JavaScript closures — screenshotPick/nameRow/descRow are all in scope.

    // Helper: disable both AI buttons + show spinner while an operation runs
    const withAiLock = async (spinner, fn) => {
        nameAiBtn.sensitive = false;
        descAiBtn.sensitive = false;
        spinner.visible = true;
        spinner.start();
        try {
            await fn();
        } finally {
            spinner.stop();
            spinner.visible = false;
            nameAiBtn.sensitive = true;
            descAiBtn.sensitive = true;
        }
    };

    // Name ✦ AI — suggests a name (requires a screenshot); also fills
    // description if the description field is currently empty.
    nameAiBtn.connect("clicked", async () => {
        if (!screenshotPick) {
            showReportDialog(
                window,
                tr("export.ai.no_screenshot_heading", "No screenshot selected"),
                tr("export.ai.no_screenshot_body", "Add a screenshot first — AI needs an image to suggest a name.")
            );
            return;
        }
        await withAiLock(nameSpinner, async () => {
            try {
                const b64 = GLib.base64_encode(screenshotPick.bytes);
                const pollinationsKey = settings?.isReady ? settings.getGlobalValue("pollinations-api-key") : "";
                const result = await generateAiMeta(nameRow.text, b64, screenshotPick.mime, pollinationsKey);
                if (result.name)        nameRow.text = result.name;
                if (result.description && !descRow.text.trim())
                    descRow.text = result.description;
            } catch (e) {
                logError(e, "[widget-center] themePackExportDialog: AI name generation failed");
                showReportDialog(window, tr("export.ai.failed_heading", "AI generation failed"), e.message);
            }
        });
    });

    // Description ✦ AI — generates a description from name + screenshot.
    // Works with name alone (no screenshot) or screenshot alone (no name).
    descAiBtn.connect("clicked", async () => {
        const name = nameRow.text.trim();
        const hasImage = screenshotPick !== null;
        if (!name && !hasImage) {
            showReportDialog(
                window,
                tr("export.ai.nothing_to_go_on_heading", "Nothing to go on"),
                tr("export.ai.nothing_to_go_on_body", "Enter a name or add a screenshot so AI has something to work with.")
            );
            return;
        }
        await withAiLock(descSpinner, async () => {
            try {
                const b64 = hasImage ? GLib.base64_encode(screenshotPick.bytes) : null;
                const mime = screenshotPick?.mime ?? "image/png";
                const pollinationsKey = settings?.isReady ? settings.getGlobalValue("pollinations-api-key") : "";
                const result = await generateAiMeta(name, b64, mime, pollinationsKey);
                if (result.description) descRow.text = result.description;
            } catch (e) {
                logError(e, "[widget-center] themePackExportDialog: AI description generation failed");
                showReportDialog(window, tr("export.ai.failed_heading", "AI generation failed"), e.message);
            }
        });
    });
    // ─────────────────────────────────────────────────────────────────────────

    // ── Progress bar + bottom bar (unchanged) ─────────────────────────────────
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
        label: tr("dialog.close", "Close")
    });
    closeButton.connect("clicked", () => window.close());
    bottomBar.append(closeButton);

    const exportButton = new Gtk.Button({
        label: tr("export.button", "Export"),
        css_classes: [ "suggested-action" ]
    });
    exportButton.connect("clicked", async () => {
        if (!nameRow.text.trim()) {
            showReportDialog(window, tr("export.name_required.heading", "Give this theme pack a name"), tr("export.name_required.body", "The Name field can't be empty."));
            return;
        }
        if (!markValidity(emailRow, EMAIL_PATTERN)) {
            showReportDialog(window, tr("export.email_invalid.heading", "Check the Email field"), tr("export.email_invalid.body", "\"{value}\" doesn't look like a valid email address.").replace("{value}", emailRow.text.trim()));
            return;
        }
        if (!markValidity(urlRow, URL_PATTERN)) {
            showReportDialog(window, tr("export.url_invalid.heading", "Check the URL field"), tr("export.url_invalid.body", "\"{value}\" doesn't look like a valid URL (must start with http:// or https://).").replace("{value}", urlRow.text.trim()));
            return;
        }
        const defaultName = ensureGwctExtension(nameRow.text.trim().replace(/[^\w.-]+/g, "-") || "theme-pack");
        const savePath = await chooseFile(window, {
            action: "save",
            title: tr("export.save_title", "Save theme pack"),
            initialName: defaultName,
            initialFolder: GLib.get_home_dir(),
            pattern: "*.gwct"
        });
        if (!savePath) return;
        exportButton.sensitive = false;
        closeButton.sensitive = false;
        progressBar.fraction = 0;
        progressBar.text = tr("importexport.export.progress_start", "Collecting widget settings…");
        progressBar.visible = true;
        await idleTick();
        try {
            const candidates = prefill.widgetIds
                ? discoveredWidgets.filter(w => prefill.widgetIds.includes(w.id))
                : discoveredWidgets;
            const {document: document} = await buildGwctDocumentAsync(candidates, {
                storage: storage,
                theme: theme,
                settings: settings
            }, (done, total) => {
                progressBar.fraction = total > 0 ? done / total : 1;
                progressBar.text = tr("importexport.export.progress_counted", "Collecting widget settings… ({done}/{total})").replace("{done}", done).replace("{total}", total);
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
            progressBar.text = tr("importexport.export.progress_writing", "Writing file…");
            await idleTick();
            const finalPath = writeGwctFile(ensureGwctExtension(savePath), document);
            showReportDialog(window, tr("export.done_heading", "Theme pack exported"), `${tr("importexport.result.saved_to", "Saved to {path}").replace("{path}", finalPath)}\n${tr("backup.result.widgets_included", "Widgets included: {count}").replace("{count}", document.widgets.length)}`, () => {
                window.close();
                parentWindow.close();
            });
        } catch (e) {
            logError(e, "[widget-center] themePackExportDialog: export failed");
            showReportDialog(window, tr("importexport.result.export_failed_heading", "Export failed"), e.message);
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
