import St from "gi://St";

import Clutter from "gi://Clutter";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Pango from "gi://Pango";

import Cairo from "cairo";

import { MprisMediaService } from "../../lib/mediaApi.js";

import { SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba, toCssColor as _toCssColor, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
const SIZE = 368;

const PADDING = 16;

const CONTENT_SIZE = SIZE - PADDING * 2;

const COVER_HEIGHT = 188;

function _parseFontDescription(fontStr, fallbackFamily, fallbackSize) {
    try {
        const desc = Pango.FontDescription.from_string(fontStr);
        const rawSize = desc.get_size();
        const size = rawSize > 0 ? Math.round(rawSize / Pango.SCALE) : fallbackSize;
        desc.unset_fields(Pango.FontMask.SIZE);
        const family = desc.to_string().trim();
        return {
            family: family || fallbackFamily,
            size: size
        };
    } catch (e) {
        return {
            family: fallbackFamily,
            size: fallbackSize
        };
    }
}

export default class MediaPlayerPosterWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._media = new MprisMediaService(api.logger);
        this._state = null;
        this._repaintId = null;
    }
    buildActor() {
        this._actor = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            width: SIZE,
            height: SIZE
        });
        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true
        });
        // R1: content always matches blocksize.
        this._actor.add_child(this._content);
        this._content.add_constraint(new Clutter.BindConstraint({
            source: this._actor,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        // R5: padding lives on a child wrapper, not on _content itself.
        this._innerPad = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style: `padding: ${PADDING}px;`
        });
        this._coverStack = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            width: CONTENT_SIZE,
            height: COVER_HEIGHT,
            clip_to_allocation: true
        });
        this._innerPad.add_child(this._coverStack);
        this._fallbackArea = new St.DrawingArea({
            width: CONTENT_SIZE,
            height: COVER_HEIGHT
        });
        this._coverStack.add_child(this._fallbackArea);
        this._repaintId = this._fallbackArea.connect("repaint", () => this._onFallbackRepaint());
        this._fallbackIcon = new St.Icon({
            icon_name: "audio-x-generic-symbolic",
            icon_size: 64,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: "color: rgba(255,255,255,0.9);"
        });
        this._coverStack.add_child(this._fallbackIcon);
        this._artIcon = new St.Widget({
            width: CONTENT_SIZE,
            height: COVER_HEIGHT,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false
        });
        this._coverStack.add_child(this._artIcon);
        this._coverButton = new St.Button({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            style: "background-color: transparent;"
        });
        this._coverButton.connect("clicked", () => this._onCoverClicked());
        this._coverStack.add_child(this._coverButton);
        this._titleLabel = new St.Label({
            text: "No media playing"
        });
        this._artistLabel = new St.Label({
            text: ""
        });
        // Overflowing titles/artists are hidden by the Content Layer's
        // clip_to_allocation (Rule 4) - no ellipsize substitute.
        for (const label of [ this._titleLabel, this._artistLabel ]) label.clutter_text.set_line_wrap(false);
        this._titleLabel.set_style("margin-top: 12px;");
        this._artistLabel.set_style("margin-top: 3px;");
        this._innerPad.add_child(this._titleLabel);
        this._innerPad.add_child(this._artistLabel);
        const spacer = new St.Widget({
            y_expand: true
        });
        this._innerPad.add_child(spacer);
        this._prevButton = this._makeButton("media-skip-backward-symbolic", () => this._media.previous());
        this._playPauseButton = this._makeButton("media-playback-start-symbolic", () => this._onPlayClicked());
        this._nextButton = this._makeButton("media-skip-forward-symbolic", () => this._media.next());
        this._controls = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true
        });
        this._controls.set_style("spacing: 14px;");
        this._controls.add_child(this._prevButton);
        this._controls.add_child(this._playPauseButton);
        this._controls.add_child(this._nextButton);
        this._innerPad.add_child(this._controls);
        this._content.add_child(this._innerPad);
        this._render();
        this._renderState(null);
        return this._actor;
    }
    enable() {
        this._media.start(state => this._renderState(state));
    }
    disable() {
        this._media.stop();
        if (this._repaintId !== null && this._fallbackArea) {
            this._fallbackArea.disconnect(this._repaintId);
            this._repaintId = null;
        }
    }
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
        };
    }
    onSettingsChanged() {
        this._render();
    }
    _makeButton(iconName, onClicked) {
        const button = new St.Button({
            child: new St.Icon({
                icon_name: iconName,
                icon_size: 20
            })
        });
        button.connect("clicked", onClicked);
        return button;
    }
    _onPlayClicked() {
        if (!this._state) {
            this._onCoverClicked();
            return;
        }
        this._media.playPause();
    }
    _onCoverClicked() {
        if (this._state) {
            this._media.raise();
            return;
        }
        this._launchApp();
    }
    _launchApp() {
        const path = this._settings.desktopFilePath ?? "";
        if (!path) return;
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
            if (appInfo) appInfo.launch([], null); else this._api.logger.info(`media-player-poster: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`media-player-poster: failed to launch ${path}: ${e}`);
        }
    }
    _render() {
        this._actor.set_style((this._api.resolveCardCss?.() ?? _cardStyleCss(this._settings, {
            backgroundColorFallback: "#FFFFFF00",
            cornerRadiusKey: "widgetCornerRadius",
            cornerRadiusFallback: 18
        })));
        const coverCornerRadius = this._settings.coverCornerRadius ?? 18;
        this._coverStack.set_style(`background-color: rgba(255,255,255,0.05); border-radius: ${coverCornerRadius}px;`);
        this._artIcon.set_style(`border-radius: ${coverCornerRadius}px; background-size: cover; background-position: center;`);
        const trackColor = _toCssColor(this._settings.trackColor, "#FFFFFFFF");
        const trackFont = _parseFontDescription(this._settings.trackFont ?? "Sans Bold 20", "Sans Bold", 20);
        this._titleLabel.set_style(`margin-top: 12px; color: ${trackColor}; font-family: ${trackFont.family}; ` + `font-size: ${trackFont.size}px; font-weight: bold;`);
        const artistColor = _toCssColor(this._settings.artistColor, "#FFFFFFB3");
        const artistFont = _parseFontDescription(this._settings.artistFont ?? "Sans 13", "Sans", 13);
        this._artistLabel.set_style(`margin-top: 3px; color: ${artistColor}; font-family: ${artistFont.family}; ` + `font-size: ${artistFont.size}px;`);
        const buttonColor = _toCssColor(this._settings.buttonColor, "#FFFFFFFF");
        for (const button of [ this._prevButton, this._playPauseButton, this._nextButton ]) {
            button.set_style(`background-color: rgba(255,255,255,0.12); border-radius: 999px; padding: 10px; color: ${buttonColor};`);
            button.child.set_style(`color: ${buttonColor};`);
        }
        if (this._fallbackArea) this._fallbackArea.queue_repaint();
    }
    _renderState(state) {
        this._state = state;
        if (!state) {
            this._titleLabel.set_text("");
            this._artistLabel.set_text("");
            this._titleLabel.hide();
            this._artistLabel.hide();
            this._playPauseButton.child.icon_name = "media-playback-start-symbolic";
            this._showFallbackArt();
            return;
        }
        this._titleLabel.show();
        this._artistLabel.show();
        this._titleLabel.set_text(state.title);
        this._artistLabel.set_text(state.artist);
        this._playPauseButton.child.icon_name = state.status === "Playing" ? "media-playback-pause-symbolic" : "media-playback-start-symbolic";
        if (state.artUrl.length > 0) {
            try {
                const file = state.artUrl.startsWith("file://") ? Gio.File.new_for_uri(state.artUrl) : Gio.File.new_for_path(state.artUrl);
                const coverCornerRadius = this._settings.coverCornerRadius ?? 18;
                this._artIcon.set_style(`border-radius: ${coverCornerRadius}px; background-size: cover; background-position: center; ` + `background-image: url("${file.get_uri()}");`);
                this._showArt();
            } catch (e) {
                this._showFallbackArt();
            }
        } else {
            this._showFallbackArt();
        }
    }
    _showArt() {
        this._artIcon.show();
        this._fallbackArea.hide();
        this._fallbackIcon.hide();
    }
    _showFallbackArt() {
        this._artIcon.hide();
        this._fallbackArea.show();
        this._fallbackIcon.show();
    }
    _onFallbackRepaint() {
        const cr = this._fallbackArea.get_context();
        const w = CONTENT_SIZE;
        const h = COVER_HEIGHT;
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const start = _hexToRgba("#FF8A00FF");
        const end = _hexToRgba("#B3260AFF");
        const gradient = new Cairo.LinearGradient(0, 0, w, h);
        gradient.addColorStopRGBA(0, start.r, start.g, start.b, start.a);
        gradient.addColorStopRGBA(1, end.r, end.g, end.b, end.a);
        const radius = Math.min(this._settings.coverCornerRadius ?? 18, Math.min(w, h) / 2);
        cr.newSubPath();
        cr.arc(w - radius, radius, radius, -Math.PI / 2, 0);
        cr.arc(w - radius, h - radius, radius, 0, Math.PI / 2);
        cr.arc(radius, h - radius, radius, Math.PI / 2, Math.PI);
        cr.arc(radius, radius, radius, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
        cr.setSource(gradient);
        cr.fill();
        cr.$dispose();
    }
}