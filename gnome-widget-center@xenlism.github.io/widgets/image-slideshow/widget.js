import Clutter from "gi://Clutter";

import St from "gi://St";

import Gio from "gi://Gio";

import GLib from "gi://GLib";

import { SHADOW_DEFAULTS, BORDER_DEFAULTS, OPACITY_DEFAULTS, toCssColor as _toCssColor, resolveCornerRadius } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";

const FALLBACK_CORNER_RADIUS = 18;

const IMAGE_EXTENSIONS = new Set([ ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif" ]);

function _shuffle(array) {
    const result = array.slice();
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ result[i], result[j] ] = [ result[j], result[i] ];
    }
    return result;
}

export default class ImageSlideshowWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._files = [];
        this._index = -1;
        this._activeIsA = true;
        this._timerId = null;
        this._scannedFolder = null;
        this._radius = FALLBACK_CORNER_RADIUS;
        this._layerUri = new Map();
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "image-slideshow-root"
        });
        this._actor = this._layers.root;
        this._frame = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true
        });
        this._layers.content.add_child(this._frame);
        this._layerA = new St.Widget({
            x_expand: true,
            y_expand: true,
            opacity: 255
        });
        this._layerB = new St.Widget({
            x_expand: true,
            y_expand: true,
            opacity: 0
        });
        this._frame.add_child(this._layerA);
        this._frame.add_child(this._layerB);
        this._fileNameLabel = new St.Label({
            text: "",
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            style: "color: rgba(255,255,255,0.85); font-size: 10px; padding: 4px 8px; " + "background-color: rgba(0,0,0,0.45); border-radius: 6px; margin: 8px;"
        });
        this._frame.add_child(this._fileNameLabel);
        this._placeholder = new St.Icon({
            icon_name: "folder-open-symbolic",
            icon_size: 48,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: "color: rgba(255,255,255,0.35);"
        });
        this._frame.add_child(this._placeholder);
        this._render();
        this._rescanAndStart();
        return this._actor;
    }
    enable() {
        if (this._files.length > 1) this._startTimer();
    }
    disable() {
        this._stopTimer();
    }
    // --- corner radius -----------------------------------------------------
    // The photos are CSS background-images on St.Widgets. St clips a
    // background-image to the widget's own `border-radius`, but NOT to its
    // parent's, so each photo layer needs the card's radius itself - otherwise
    // the square image paints over the card's rounded corners.
    _computeRadius() {
        // Same resolver cardLayers.js uses for the card itself, so the photo's
        // corners always match the card (including "corner radius" switched off).
        return resolveCornerRadius(this._settings, FALLBACK_CORNER_RADIUS);
    }
    _layerStyle(uri) {
        const image = uri ? `background-image: url("${uri}"); ` : "";
        return `${image}${this._fitCss} border-radius: ${this._radius}px;`;
    }
    _setLayerUri(layer, uri) {
        this._layerUri.set(layer, uri);
        layer.set_style(this._layerStyle(uri));
    }
    _restyleLayers() {
        for (const layer of [ this._layerA, this._layerB ]) {
            if (layer) layer.set_style(this._layerStyle(this._layerUri.get(layer) ?? null));
        }
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
        if (this._settings.folderPath !== this._scannedFolder) {
            this._rescanAndStart();
        } else {
            this._startTimer();
        }
    }
    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#000000FF",
            cornerRadiusFallback: FALLBACK_CORNER_RADIUS
        }, false);
        this._radius = this._computeRadius();
        const fit = (this._settings.fitMode ?? "contain") === "stretch" ? "100% 100%" : "contain";
        this._fitCss = `background-size: ${fit}; background-position: center; background-repeat: no-repeat;`;
        if (this._fileNameLabel) this._fileNameLabel.visible = this._settings.showFileName ?? false;
        this._restyleLayers();
    }
    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }
    _startTimer() {
        this._stopTimer();
        if (this._files.length < 2) return;
        const seconds = Math.max(2, this._settings.intervalSeconds ?? 8);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._advance();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _listImageFiles(folderPath) {
        const results = [];
        try {
            const dir = Gio.File.new_for_path(folderPath);
            const enumerator = dir.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.REGULAR) continue;
                const name = info.get_name();
                const dot = name.lastIndexOf(".");
                if (dot === -1) continue;
                const ext = name.slice(dot).toLowerCase();
                if (IMAGE_EXTENSIONS.has(ext)) results.push(name);
            }
            enumerator.close(null);
        } catch (e) {
            this._api.logger.warn?.(`image-slideshow: could not read folder "${folderPath}": ${e.message}`);
        }
        results.sort((a, b) => a.localeCompare(b));
        return results;
    }
    _rescanAndStart() {
        this._stopTimer();
        const folderPath = this._settings.folderPath;
        this._scannedFolder = folderPath;
        this._index = -1;
        if (!folderPath) {
            this._files = [];
            this._showPlaceholder();
            return;
        }
        let names = this._listImageFiles(folderPath);
        if ((this._settings.order ?? "sequential") === "random") names = _shuffle(names);
        this._files = names.map(name => GLib.build_filenamev([ folderPath, name ]));
        if (this._files.length === 0) {
            this._showPlaceholder();
            return;
        }
        this._placeholder.visible = false;
        this._advance();
        this._startTimer();
    }
    _showPlaceholder() {
        this._placeholder.visible = true;
        this._layerUri.clear();
        this._restyleLayers();
        this._fileNameLabel.set_text("");
    }
    _nextPath() {
        if (this._files.length === 0) return null;
        this._index++;
        if (this._index >= this._files.length) {
            this._index = 0;
            if ((this._settings.order ?? "sequential") === "random") {
                // Re-shuffle on loop so the cycle doesn't repeat identically -
                // and so the same photo can't land at both the end of one
                // loop and the start of the next.
                this._files = _shuffle(this._files);
            }
        }
        return this._files[this._index];
    }
    _advance() {
        const path = this._nextPath();
        if (!path) {
            this._showPlaceholder();
            return;
        }
        const uri = GLib.filename_to_uri(path, null);
        const incoming = this._activeIsA ? this._layerB : this._layerA;
        const outgoing = this._activeIsA ? this._layerA : this._layerB;
        this._setLayerUri(incoming, uri);
        this._fileNameLabel.set_text(GLib.path_get_basename(path));
        const duration = Math.max(0, this._settings.transitionMs ?? 600);
        incoming.opacity = 0;
        incoming.ease({
            opacity: 255,
            duration: duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
        outgoing.ease({
            opacity: 0,
            duration: duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
        this._activeIsA = !this._activeIsA;
    }
}
