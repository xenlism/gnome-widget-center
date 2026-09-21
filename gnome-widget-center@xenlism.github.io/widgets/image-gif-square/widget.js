import Clutter from "gi://Clutter";

import St from "gi://St";

import Gio from "gi://Gio";

import GLib from "gi://GLib";

import GdkPixbuf from "gi://GdkPixbuf";

import { SHADOW_DEFAULTS, BORDER_DEFAULTS, OPACITY_DEFAULTS, toCssColor as _toCssColor, resolveCornerRadius } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";

// Upper bound on distinct decoded frames written to the temp cache. A normal
// GIF is a few dozen frames; this only protects against pathological files.
const MAX_CACHED_FRAMES = 600;

// GIFs that declare a ~0 ms delay are played at 100 ms, like browsers do.
const MIN_FRAME_DELAY_MS = 20;
const FALLBACK_FRAME_DELAY_MS = 100;

// How often to re-poll when the timer fired a hair before the next frame was
// due (the timer uses the monotonic clock, gdk-pixbuf uses wall-clock time).
const EARLY_WAKE_POLL_MS = 10;

const FALLBACK_CORNER_RADIUS = 18;

export default class ImageGifSquareWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._animation = null;
        this._animIter = null;
        this._animTimerId = null;
        this._disposed = false;
        this._loadToken = 0;
        this._loadedPath = null;
        this._currentUri = null;
        this._radius = FALLBACK_CORNER_RADIUS;
        this._frameCache = new Map();
        this._frameDir = null;
        this._signals = [];
    }
    buildActor() {
        this._disposed = false;
        this._layers = createLayeredCard({
            contentStyleClass: "image-gif-square-root"
        });
        this._actor = this._layers.root;
        this._frame = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true
        });
        this._layers.content.add_child(this._frame);
        // The picture. Both static images and every frame of an animated GIF
        // are painted through CSS `background-image` on this one St.Widget.
        // That matters for two reasons:
        //  1. St clips a CSS background-image to the widget's `border-radius`,
        //     so the picture follows the card's rounded corners. (A plain
        //     Clutter.Actor with `content` - what this widget used before -
        //     is always a hard rectangle and overflowed the corners.)
        //  2. It doesn't depend on Cogl / Clutter.Image, which is what made
        //     animated GIFs silently degrade to a still frame.
        this._image = new St.Widget({
            x_expand: true,
            y_expand: true
        });
        this._frame.add_child(this._image);
        this._placeholder = new St.Icon({
            icon_name: "image-missing-symbolic",
            icon_size: 48,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: "color: rgba(255,255,255,0.35);"
        });
        this._frame.add_child(this._placeholder);
        this._connectSignals();
        this._render();
        this._loadSource();
        return this._actor;
    }
    enable() {
        // disable() tears everything down; bring it back if we were disabled.
        if (!this._disposed) return;
        this._disposed = false;
        this._connectSignals();
        this._render();
        this._loadSource();
    }
    disable() {
        this._teardown();
    }
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS
        };
    }
    onSettingsChanged() {
        this._render();
        // Only re-open the file when the path changed; dragging a shadow slider
        // shouldn't restart the animation.
        if ((this._settings.imagePath ?? "") !== this._loadedPath) this._loadSource();
    }
    // --- lifecycle helpers -------------------------------------------------
    _connectSignals() {
        this._disconnectSignals();
        try {
            this._signals.push([ this._actor, this._actor.connect("destroy", () => this._teardown()) ]);
        } catch (_e) {}
    }
    _disconnectSignals() {
        for (const [ actor, id ] of this._signals) {
            try {
                actor.disconnect(id);
            } catch (_e) {}
        }
        this._signals = [];
    }
    _teardown() {
        this._disposed = true;
        this._loadToken++;
        this._stopAnimation();
        this._disconnectSignals();
        this._loadedPath = null;
        this._cleanupFrames();
    }
    _cleanupFrames() {
        this._frameCache.clear();
        if (!this._frameDir) return;
        try {
            const dir = Gio.File.new_for_path(this._frameDir);
            const enumerator = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) enumerator.get_child(info).delete(null);
            enumerator.close(null);
            dir.delete(null);
        } catch (_e) {}
        this._frameDir = null;
    }
    // --- corner radius -----------------------------------------------------
    // Same resolver cardLayers.js uses for the card itself, so the picture's
    // corners always match the card (including "corner radius" switched off).
    _computeRadius() {
        return resolveCornerRadius(this._settings, FALLBACK_CORNER_RADIUS);
    }
    // --- rendering ---------------------------------------------------------
    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#000000FF",
            cornerRadiusFallback: FALLBACK_CORNER_RADIUS
        }, false);
        this._radius = this._computeRadius();
        this._applyImageStyle();
    }
    _applyImageStyle() {
        if (!this._image) return;
        const fit = (this._settings.fitMode ?? "contain") === "stretch" ? "100% 100%" : "contain";
        let css = `background-size: ${fit}; background-position: center; background-repeat: no-repeat; border-radius: ${this._radius}px;`;
        if (this._currentUri) css = `background-image: url("${this._currentUri}"); ${css}`;
        this._image.set_style(css);
    }
    _setUri(uri) {
        this._currentUri = uri;
        this._placeholder.visible = false;
        this._image.visible = true;
        this._applyImageStyle();
    }
    _showPlaceholder() {
        this._stopAnimation();
        this._currentUri = null;
        this._placeholder.visible = true;
        this._image.visible = false;
        this._applyImageStyle();
    }
    _showFile(path) {
        this._stopAnimation();
        this._setUri(GLib.filename_to_uri(path, null));
    }
    // --- animation ---------------------------------------------------------
    _stopAnimation() {
        if (this._animTimerId !== null) {
            GLib.source_remove(this._animTimerId);
            this._animTimerId = null;
        }
        this._animIter = null;
        this._animation = null;
    }
    // Writes the current (fully composited) GIF frame to a temp PNG once and
    // returns its file URI. Frames are keyed by pixel checksum, so after the
    // first loop every frame is just a cache hit and nothing is re-encoded.
    _frameUri(pixbuf) {
        const key = GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, pixbuf.read_pixel_bytes());
        const cached = this._frameCache.get(key);
        if (cached) return cached;
        if (this._frameCache.size >= MAX_CACHED_FRAMES) return null;
        if (!this._frameDir) this._frameDir = GLib.dir_make_tmp("xenlism-image-gif-XXXXXX");
        const path = GLib.build_filenamev([ this._frameDir, `${key}.png` ]);
        pixbuf.savev(path, "png", [ "compression" ], [ "1" ]);
        const uri = GLib.filename_to_uri(path, null);
        this._frameCache.set(key, uri);
        return uri;
    }
    _paintFrame(path) {
        try {
            const uri = this._frameUri(this._animIter.get_pixbuf());
            if (!uri) throw new Error(`more than ${MAX_CACHED_FRAMES} distinct frames`);
            this._setUri(uri);
            return true;
        } catch (e) {
            this._api.logger.warn?.(`image-gif: frame paint failed for "${path}": ${e.message}`);
            this._showFile(path);
            return false;
        }
    }
    _frameDelay() {
        const delay = this._animIter.get_delay_time();
        if (delay < 0) return -1;
        return delay < MIN_FRAME_DELAY_MS ? FALLBACK_FRAME_DELAY_MS : delay;
    }
    _scheduleNext(token, path, delayMs) {
        this._animTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._animTimerId = null;
            if (this._disposed || token !== this._loadToken || !this._animIter) return GLib.SOURCE_REMOVE;
            let changed;
            try {
                changed = this._animIter.advance(null);
            } catch (e) {
                this._api.logger.warn?.(`image-gif: advance failed for "${path}": ${e.message}`);
                this._showFile(path);
                return GLib.SOURCE_REMOVE;
            }
            if (!changed) {
                this._scheduleNext(token, path, EARLY_WAKE_POLL_MS);
                return GLib.SOURCE_REMOVE;
            }
            if (!this._paintFrame(path)) return GLib.SOURCE_REMOVE;
            const next = this._frameDelay();
            if (next >= 0) this._scheduleNext(token, path, next);
            return GLib.SOURCE_REMOVE;
        });
    }
    _loadSource() {
        const path = this._settings.imagePath ?? "";
        const token = ++this._loadToken;
        this._stopAnimation();
        this._loadedPath = path;
        if (!path) {
            this._showPlaceholder();
            return;
        }
        let animation;
        try {
            animation = GdkPixbuf.PixbufAnimation.new_from_file(path);
        } catch (e) {
            this._api.logger.warn?.(`image-gif: could not open "${path}": ${e.message}`);
            this._showPlaceholder();
            return;
        }
        if (animation.is_static_image()) {
            this._showFile(path);
            return;
        }
        let iter;
        try {
            iter = animation.get_iter(null);
        } catch (e) {
            this._api.logger.warn?.(`image-gif: could not iterate "${path}": ${e.message}`);
            this._showFile(path);
            return;
        }
        this._animation = animation;
        this._animIter = iter;
        if (!this._paintFrame(path)) return;
        const delay = this._frameDelay();
        if (delay >= 0) this._scheduleNext(token, path, delay);
    }
}
