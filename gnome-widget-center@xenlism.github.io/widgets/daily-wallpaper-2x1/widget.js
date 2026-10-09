import Clutter from "gi://Clutter";
import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GdkPixbuf from "gi://GdkPixbuf";
import Soup from "gi://Soup?version=3.0";
import { SHADOW_DEFAULTS, BORDER_DEFAULTS, OPACITY_DEFAULTS, resolveCornerRadius } from "../../lib/widgetVisualKit.js";
import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";
import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";

const USER_AGENT = "GNOME-Widget-Center-Daily-Wallpaper/1.0 (https://github.com/xenlism/gnome-widget-center)";
const FALLBACK_CORNER_RADIUS = 18;
const KEEP_CACHED_FILES = 6;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const SOURCES = {
    bing: { name: "Bing Daily", random: true },
    wikimedia: { name: "Wikimedia Commons", random: true },
    picsum: { name: "Lorem Picsum", random: true },
};

export default class DailyWallpaperWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._session = null;
        this._timerId = null;
        this._busy = false;
        this._disposed = false;
        this._currentPath = null;
        this._currentSource = "";
        this._currentAuthor = "";
        this._currentTitle = "";
        this._generation = 0;
        this._loadedKey = null;
        this._radius = FALLBACK_CORNER_RADIUS;
        this._activeIsA = true;
        this._layerInfo = new Map();
        this._sizeSig = "";
    }

    buildActor() {
        this._disposed = false;
        // Same structure as image-slideshow: a layered card, a clipped frame and
        // two photo layers (A/B) painted with CSS background-image that crossfade.
        this._layers = createLayeredCard({ contentStyleClass: "daily-wallpaper-root" });
        this._actor = this._layers.root;
        this._frame = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            x_expand: true, y_expand: true, clip_to_allocation: true
        });
        this._layers.content.add_child(this._frame);
        this._layerA = new St.Widget({ x_expand: true, y_expand: true, opacity: 255 });
        this._layerB = new St.Widget({ x_expand: true, y_expand: true, opacity: 0 });
        this._frame.add_child(this._layerA);
        this._frame.add_child(this._layerB);

        this._placeholder = new St.Icon({
            icon_name: "preferences-desktop-wallpaper-symbolic",
            icon_size: 48,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: "color: rgba(255,255,255,0.35);"
        });
        this._frame.add_child(this._placeholder);

        // Bottom overlay: dark gradient + title/subtitle + two icon buttons.
        this._info = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true,
            y_align: Clutter.ActorAlign.END,
        });
        this._frame.add_child(this._info);
        const row = new St.BoxLayout({ x_expand: true, style: "spacing: 8px;" });
        this._info.add_child(row);
        const texts = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        row.add_child(texts);
        this._title = new St.Label({
            text: "Daily Wallpaper",
            style: "color: white; font-weight: bold; font-size: 13px;"
        });
        this._title.clutter_text.ellipsize = 3;
        texts.add_child(this._title);
        this._subtitle = new St.Label({
            text: "Loading…",
            style: "color: rgba(255,255,255,0.8); font-size: 10px;"
        });
        this._subtitle.clutter_text.ellipsize = 3;
        texts.add_child(this._subtitle);

        const btnStyle = "background-color: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.4); border-radius: 999px; width: 30px; height: 30px; color: white;";
        this._randomButton = new St.Button({
            style: btnStyle, can_focus: true, reactive: true, track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({ icon_name: "view-refresh-symbolic", icon_size: 14, style: "color: white;" })
        });
        this._randomButton.connect("clicked", () => this._loadImage(true));
        row.add_child(this._randomButton);
        this._applyButton = new St.Button({
            style: "background-color: rgba(255,255,255,0.94); border-radius: 999px; width: 30px; height: 30px;",
            can_focus: true, reactive: true, track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({ icon_name: "preferences-desktop-wallpaper-symbolic", icon_size: 14, style: "color: #202124;" })
        });
        this._applyButton.connect("clicked", () => this._applyWallpaper());
        row.add_child(this._applyButton);

        // "cover" needs pixel sizes, so re-style the photo layers when the card is resized.
        this._frame.connect("notify::allocation", () => {
            const sig = `${Math.round(this._frame.width)}x${Math.round(this._frame.height)}`;
            if (sig !== this._sizeSig) {
                this._sizeSig = sig;
                this._restyleLayers();
            }
        });
        console.log("[daily-wallpaper] buildActor ok");
        this._renderStyle();
        this._updateProviderUI();
        this._loadImage(false);
        return this._actor;
    }

    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS, ...BORDER_DEFAULTS, ...OPACITY_DEFAULTS
        };
    }

    enable() {
        // enable() may run again after disable() (e.g. extension toggled), so undo disable().
        const wasDisposed = this._disposed;
        this._disposed = false;
        this._startTimer();
        if (wasDisposed && this._actor) this._loadImage(false);
    }

    disable() {
        this._disposed = true;
        this._generation++;
        this._busy = false;
        this._stopTimer();
        if (this._session) {
            try { this._session.abort(); } catch (_) {}
            this._session = null;
        }
    }

    onSettingsChanged() {
        if (this._disposed) return;
        this._renderStyle();
        this._updateProviderUI();
        this._startTimer();
        // Only re-download when something that affects the image itself changed;
        // colour / shadow / fit tweaks must not trigger a new download.
        if (this._requestKey() !== this._loadedKey)
            this._loadImage(false);
        else
            this._applyPhotoStyle();
    }

    _getSession() {
        if (!this._session)
            this._session = new Soup.Session({ user_agent: USER_AGENT, timeout: 25, idle_timeout: 25 });
        return this._session;
    }

    _renderStyle() {
        if (!this._layers) return;
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#151515FF",
            cornerRadiusFallback: FALLBACK_CORNER_RADIUS
        }, false);
        try {
            this._radius = resolveCornerRadius(this._settings, FALLBACK_CORNER_RADIUS);
        } catch (_) {
            this._radius = FALLBACK_CORNER_RADIUS;
        }
        this._applyPhotoStyle();
    }

    _fitCss(path) {
        const fitMode = this._settings.fitMode || "cover";
        if (fitMode === "stretch") return "background-size: 100% 100%; background-position: center; background-repeat: no-repeat;";
        if (fitMode === "contain") return "background-size: contain; background-position: center; background-repeat: no-repeat;";
        // cover: St's CSS has no reliable `cover`, so compute the pixel size ourselves.
        const fw = this._frame?.width || 0, fh = this._frame?.height || 0;
        const dims = path ? this._imageSize(path) : null;
        if (fw > 0 && fh > 0 && dims) {
            const k = Math.max(fw / dims.width, fh / dims.height);
            const w = Math.ceil(dims.width * k), h = Math.ceil(dims.height * k);
            return `background-size: ${w}px ${h}px; background-position: ${Math.round((fw - w) / 2)}px ${Math.round((fh - h) / 2)}px; background-repeat: no-repeat;`;
        }
        return "background-size: contain; background-position: center; background-repeat: no-repeat;";
    }

    _imageSize(path) {
        let info = this._layerInfo.get(`size:${path}`);
        if (info) return info;
        try {
            const res = GdkPixbuf.Pixbuf.get_file_info(path);
            if (res && res[1] > 0 && res[2] > 0) info = { width: res[1], height: res[2] };
        } catch (_) {}
        if (info) this._layerInfo.set(`size:${path}`, info);
        return info ?? null;
    }

    _layerStyle(path) {
        const image = path ? `background-image: url("${GLib.filename_to_uri(path, null)}"); ` : "";
        return `${image}${this._fitCss(path)} border-radius: ${this._radius}px;`;
    }

    _infoStyle() {
        // The gradient overlay is a square St.Widget and St only clips a background to the
        // widget's own border-radius, so give it the card's bottom radius too.
        const r = this._radius;
        return `padding: 8px 10px; background-gradient-direction: vertical; background-gradient-start: rgba(0,0,0,0); background-gradient-end: rgba(0,0,0,0.7); border-radius: 0 0 ${r}px ${r}px;`;
    }

    _restyleLayers() {
        if (this._info) this._info.set_style(this._infoStyle());
        for (const layer of [this._layerA, this._layerB]) {
            if (layer) layer.set_style(this._layerStyle(this._layerInfo.get(layer) ?? null));
        }
    }

    _applyPhotoStyle() {
        this._restyleLayers();
    }

    _showImage(path) {
        const incoming = this._activeIsA ? this._layerB : this._layerA;
        const outgoing = this._activeIsA ? this._layerA : this._layerB;
        this._layerInfo.set(incoming, path);
        incoming.set_style(this._layerStyle(path));
        incoming.opacity = 0;
        incoming.ease({ opacity: 255, duration: 500, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        outgoing.ease({ opacity: 0, duration: 500, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        this._activeIsA = !this._activeIsA;
        this._placeholder.visible = false;
    }

    _provider() {
        const id = this._settings.provider || "bing";
        return SOURCES[id] ? id : "bing";
    }

    _requestKey() {
        const r = this._targetResolution();
        return `${this._provider()}|${r.width}x${r.height}`;
    }

    _updateProviderUI() {
        if (!this._randomButton) return;
        this._randomButton.visible = SOURCES[this._provider()]?.random === true;
    }

    _startTimer() {
        this._stopTimer();
        const hours = Math.max(1, Math.min(168, Number(this._settings.refreshHours ?? 24) || 24));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, hours * 3600, () => {
            this._loadImage(true);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _request(url, callback) {
        let msg;
        try {
            msg = Soup.Message.new("GET", url);
        } catch (e) {
            msg = null;
        }
        if (!msg) {
            callback(new Error("Invalid request URL"), null, null);
            return;
        }
        this._getSession().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const status = msg.get_status();
                if (status < 200 || status >= 300)
                    throw new Error(`HTTP ${status}`);
                callback(null, bytes, msg.get_response_headers().get_one("Content-Type") || "");
            } catch (e) {
                callback(e, null, null);
            }
        });
    }

    _targetResolution() {
        try {
            const mode = this._settings.downloadResolution || "screen";
            const presets = {
                "1080p": { width: 1920, height: 1080 },
                "1440p": { width: 2560, height: 1440 },
                "4k": { width: 3840, height: 2160 }
            };
            if (presets[mode]) return presets[mode];
            const display = global.display;
            const primary = display.get_primary_monitor();
            const rect = display.get_monitor_geometry(primary);
            let scale = 1;
            try { scale = display.get_monitor_scale(primary) || 1; } catch (_) {}
            return {
                width: Math.max(1280, Math.min(7680, Math.round(rect.width * scale))),
                height: Math.max(720, Math.min(4320, Math.round(rect.height * scale)))
            };
        } catch (_) {
            return { width: 1920, height: 1080 };
        }
    }

    _fetchCandidate(forceRandom, callback) {
        const provider = this._provider();
        const resolution = this._targetResolution();
        if (provider === "picsum") {
            callback(null, {
                imageUrl: `https://picsum.photos/${resolution.width}/${resolution.height}.jpg?random=${GLib.get_real_time()}`,
                title: "Lorem Picsum",
                author: "Lorem Picsum",
                pageUrl: "https://picsum.photos/"
            });
            return;
        }
        if (provider === "bing") {
            const url = "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=en-US";
            this._request(url, (err, bytes) => {
                if (err) return callback(err);
                try {
                    const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    const images = (data.images || []).filter(item => item.urlbase || item.url);
                    if (!images.length) throw new Error("Bing returned no images");
                    // Daily pick = newest image; Random = any of the last 8.
                    const item = forceRandom ? images[Math.floor(Math.random() * images.length)] : images[0];
                    let imageUrl;
                    if (item.urlbase) {
                        // Bing's documented size suffixes; _UHD is the original, much larger image.
                        const suffix = resolution.width > 1920 ? "_UHD.jpg" : "_1920x1080.jpg";
                        imageUrl = `https://www.bing.com${item.urlbase}${suffix}`;
                    } else {
                        imageUrl = item.url.startsWith("http") ? item.url : `https://www.bing.com${item.url}`;
                    }
                    callback(null, {
                        imageUrl, title: (item.title || "Bing Daily").trim(),
                        author: item.copyright || "Bing",
                        pageUrl: "https://www.bing.com/"
                    });
                } catch (e) { callback(e); }
            });
            return;
        }
        // Wikimedia Commons: keyless MediaWiki API, random file from Featured Pictures.
        const dir = Math.random() < 0.5 ? "ascending" : "descending";
        const url = "https://commons.wikimedia.org/w/api.php?action=query&generator=categorymembers" +
            "&gcmtitle=Category:Featured_pictures_on_Wikimedia_Commons&gcmtype=file&gcmlimit=50" +
            `&gcmsort=timestamp&gcmdir=${dir}` +
            `&prop=imageinfo&iiprop=url%7Cextmetadata&iiurlwidth=${resolution.width}&format=json&formatversion=2&origin=*`;
        this._request(url, (err, bytes) => {
            if (err) return callback(err);
            try {
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const raw = data.query?.pages || [];
                const list = Array.isArray(raw) ? raw : Object.values(raw);
                const pages = list.filter(p => p.imageinfo?.[0]?.thumburl || p.imageinfo?.[0]?.url);
                if (!pages.length) throw new Error("Wikimedia returned no images");
                const page = pages[Math.floor(Math.random() * pages.length)];
                const info = page.imageinfo[0];
                const metadata = info.extmetadata || {};
                const author = (metadata.Artist?.value || "Wikimedia Commons").replace(/<[^>]*>/g, "").trim().slice(0, 160);
                callback(null, {
                    imageUrl: info.thumburl || info.url,
                    title: (page.title || "").replace(/^File:/, "").replace(/\.[A-Za-z0-9]+$/, "") || "Featured picture",
                    author,
                    pageUrl: info.descriptionurl || "https://commons.wikimedia.org/"
                });
            } catch (e) { callback(e); }
        });
    }

    _cacheDir() {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), "gnome-widget-center", "daily-wallpaper"]);
        // GLib.mkdir_with_parents is a no-op when the folder exists;
        // Gio.File.make_directory_with_parents() throws EXISTS and broke every download after the first.
        GLib.mkdir_with_parents(dir, 0o755);
        return dir;
    }

    _pruneCache(dir, keepPath) {
        try {
            const enumerator = Gio.File.new_for_path(dir).enumerate_children(
                "standard::name,time::modified", Gio.FileQueryInfoFlags.NONE, null);
            const files = [];
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const path = GLib.build_filenamev([dir, info.get_name()]);
                files.push({ path, mtime: info.get_attribute_uint64("time::modified") });
            }
            enumerator.close(null);
            files.sort((a, b) => b.mtime - a.mtime);
            for (const f of files.slice(KEEP_CACHED_FILES)) {
                if (f.path === keepPath || f.path === this._currentPath) continue;
                try { Gio.File.new_for_path(f.path).delete(null); } catch (_) {}
            }
        } catch (_) {}
    }

    _extensionFor(contentType, bytes) {
        const ct = (contentType || "").toLowerCase();
        if (ct.includes("png")) return "png";
        if (ct.includes("webp")) return "webp";
        if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
        const d = bytes;
        if (d.length > 4 && d[0] === 0x89 && d[1] === 0x50) return "png";
        if (d.length > 3 && d[0] === 0xFF && d[1] === 0xD8) return "jpg";
        if (d.length > 12 && d[8] === 0x57 && d[9] === 0x45) return "webp";
        return null;
    }

    _setStatus(text) {
        if (this._disposed || !this._subtitle) return;
        this._subtitle.text = text;
    }

    _loadImage(forceRandom) {
        if (this._disposed || !this._actor) return;
        // A newer request (e.g. Random clicked while a download is running) supersedes the old one.
        const generation = ++this._generation;
        this._busy = true;
        const key = this._requestKey();
        this._randomButton.reactive = false;
        if (!this._currentPath) this._subtitle.text = "Loading…";
        console.log(`[daily-wallpaper] loading (provider=${this._provider()}, random=${forceRandom})`);
        this._fetchCandidate(forceRandom, (err, candidate) => {
            if (this._disposed || generation !== this._generation) return;
            console.log(`[daily-wallpaper] candidate: ${err ? 'ERROR ' + err.message : candidate?.imageUrl}`);
            if (err || !candidate) {
                this._finishLoad(generation);
                this._setStatus(this._currentPath ? "Could not refresh. Keeping last image." : "Could not load image. Check your connection.");
                this._api.logger.warn(`daily-wallpaper: ${err?.message || "provider error"}`);
                return;
            }
            this._request(candidate.imageUrl, (imageErr, bytes, contentType) => {
                if (this._disposed || generation !== this._generation) return;
                this._finishLoad(generation);
                console.log(`[daily-wallpaper] download: ${imageErr ? 'ERROR ' + imageErr.message : (bytes?.get_size() + ' bytes, ' + contentType)}`);
                if (imageErr || !bytes) {
                    this._setStatus("Download failed. Will retry later.");
                    this._api.logger.warn(`daily-wallpaper: image download failed: ${imageErr?.message || "unknown error"}`);
                    return;
                }
                try {
                    const data = bytes.get_data();
                    if (!data || data.length === 0 || data.length > MAX_IMAGE_BYTES)
                        throw new Error(`unexpected image size (${data?.length ?? 0} bytes)`);
                    const ext = this._extensionFor(contentType, data);
                    if (!ext)
                        throw new Error(`response is not an image (${contentType || "unknown type"})`);
                    const cacheDir = this._cacheDir();
                    const path = GLib.build_filenamev([cacheDir, `${this._provider()}-${Date.now()}.${ext}`]);
                    Gio.File.new_for_path(path).replace_contents(data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    this._currentPath = path;
                    this._loadedKey = key;
                    this._currentSource = candidate.pageUrl;
                    this._currentAuthor = candidate.author || "";
                    this._currentTitle = candidate.title || "Daily Wallpaper";
                    console.log(`[daily-wallpaper] saved ${path}`);
                    this._showImage(path);
                    this._title.text = this._currentTitle;
                    this._subtitle.text = this._settings.showAttribution === false
                        ? this._providerLabel()
                        : `${this._providerLabel()} · ${this._currentAuthor.slice(0, 90)}`;
                    this._pruneCache(cacheDir, path);
                    if (this._settings.autoApplyWallpaper) this._applyWallpaper();
                } catch (e) {
                    this._setStatus("Could not save image");
                    this._api.logger.warn(`daily-wallpaper: could not cache image: ${e.message}`);
                }
            });
        });
    }

    _finishLoad(generation) {
        if (generation !== this._generation) return;
        this._busy = false;
        if (this._randomButton) this._randomButton.reactive = true;
    }

    _providerLabel() {
        return SOURCES[this._provider()]?.name || "Wallpaper";
    }

    _applyWallpaper() {
        if (!this._currentPath) {
            this._setStatus("No wallpaper loaded yet");
            return;
        }
        try {
            const settings = new Gio.Settings({ schema_id: "org.gnome.desktop.background" });
            const uri = GLib.filename_to_uri(this._currentPath, null);
            const keys = settings.settings_schema.list_keys();
            settings.set_string("picture-uri", uri);
            if (keys.includes("picture-uri-dark"))
                settings.set_string("picture-uri-dark", uri);
            const applyMode = this._settings.wallpaperApplyMode || "zoom";
            if (keys.includes("picture-options"))
                settings.set_string("picture-options", applyMode);
            Gio.Settings.sync();
            this._setStatus("Wallpaper applied");
        } catch (e) {
            this._setStatus("Could not apply wallpaper");
            this._api.logger.warn(`daily-wallpaper: apply failed: ${e.message}`);
        }
    }
}
