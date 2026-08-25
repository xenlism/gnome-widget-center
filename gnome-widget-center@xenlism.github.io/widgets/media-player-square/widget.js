import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Pango from "gi://Pango";
import Cairo from "cairo";

import { MprisMediaService } from "../../lib/mediaApi.js";

import {
    SHADOW_DEFAULTS,
    cardStyleCss as _cardStyleCss,
    hexToRgba as _hexToRgba,
    toCssColor as _toCssColor,
    BORDER_DEFAULTS,
    OPACITY_DEFAULTS
} from "../../lib/widgetVisualKit.js";

import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";


const SIZE = 176;

const COVER_SIZE = 154;

const COVER_RADIUS = 18;


function _parseFontDescription(fontStr, fallbackFamily, fallbackSize) {
    try {
        const desc = Pango.FontDescription.from_string(fontStr);

        const rawSize = desc.get_size();

        const size = rawSize > 0
            ? Math.round(rawSize / Pango.SCALE)
            : fallbackSize;

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


export default class MediaPlayerSquareWidget {

    constructor(api) {
        this._api = api;
        this._settings = api.settings;

        this._media = new MprisMediaService(api.logger);

        this._state = null;

        this._coverPressId = null;
        this._hoverId = null;
        this._repaintId = null;
    }


    buildActor() {

        /*
         * Main widget
         */
        this._actor = new St.Widget({
            layout_manager: new Clutter.BinLayout,

            width: SIZE,
            height: SIZE,

            reactive: true
        });


        /*
         * Content
         *
         * Force this layer to occupy the complete widget.
         * This prevents the cover from being positioned relative
         * to a smaller/natural-size allocation.
         */
        this._content = new St.Widget({
            layout_manager: new Clutter.BinLayout,

            x_expand: true,
            y_expand: true,

            clip_to_allocation: true
        });


        this._content.add_constraint(new Clutter.BindConstraint({
            source: this._actor,
            coordinate: Clutter.BindCoordinate.SIZE
        }));


        this._actor.add_child(this._content);


        /*
         * Cover
         *
         * IMPORTANT:
         * Do not use x/y here.
         * Let BinLayout center the cover inside _content.
         */
        this._coverStack = new St.Widget({
            layout_manager: new Clutter.BinLayout,

            width: COVER_SIZE,
            height: COVER_SIZE,

            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,

            clip_to_allocation: true
        });


        this._content.add_child(this._coverStack);


        /*
         * Fallback artwork
         */
        this._fallbackArea = new St.DrawingArea({
            width: COVER_SIZE,
            height: COVER_SIZE
        });

        this._coverStack.add_child(this._fallbackArea);


        this._repaintId = this._fallbackArea.connect(
            "repaint",
            () => this._onFallbackRepaint()
        );


        this._fallbackIcon = new St.Icon({
            icon_name: "audio-x-generic-symbolic",

            icon_size: 56,

            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,

            style: "color: rgba(255,255,255,0.9);"
        });

        this._coverStack.add_child(this._fallbackIcon);


        /*
         * Album artwork
         */
        this._artIcon = new St.Widget({
            width: COVER_SIZE,
            height: COVER_SIZE,

            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,

            visible: false
        });

        this._coverStack.add_child(this._artIcon);


        /*
         * Bottom scrim
         */
        this._scrim = new St.Widget({
            width: COVER_SIZE,
            height: 58,

            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,

            style: "background-color: rgba(0,0,0,0.55);"
        });

        this._coverStack.add_child(this._scrim);


        /*
         * Text labels
         */
        this._titleLabel = new St.Label({
            text: "No media playing"
        });

        this._albumLabel = new St.Label({
            text: ""
        });

        this._artistLabel = new St.Label({
            text: ""
        });


        /*
         * Do not ellipsize.
         * The content layer clips overflowing text.
         */
        for (const label of [
            this._titleLabel,
            this._albumLabel,
            this._artistLabel
        ]) {
            label.clutter_text.set_line_wrap(false);
        }


        /*
         * Text container
         */
        this._textBox = new St.BoxLayout({
            vertical: true,

            width: COVER_SIZE,

            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END
        });

        this._textBox.set_style("padding: 8px;");


        this._textBox.add_child(this._titleLabel);
        this._textBox.add_child(this._albumLabel);
        this._textBox.add_child(this._artistLabel);


        this._coverStack.add_child(this._textBox);


        /*
         * Cover click area
         *
         * Keep this centered/full-size over the widget.
         */
        this._coverButton = new St.Button({
            x_expand: true,
            y_expand: true,

            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,

            style: "background-color: transparent;"
        });

        this._coverButton.connect(
            "clicked",
            () => this._onCoverClicked()
        );

        this._content.add_child(this._coverButton);


        /*
         * Playback buttons
         */
        this._prevButton = this._makeButton(
            "media-skip-backward-symbolic",
            () => this._media.previous()
        );


        this._playPauseButton = this._makeButton(
            "media-playback-start-symbolic",
            () => this._onPlayClicked()
        );


        this._nextButton = this._makeButton(
            "media-skip-forward-symbolic",
            () => this._media.next()
        );


        /*
         * Controls container
         */
        this._controls = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,

            visible: false
        });

        this._controls.set_style("spacing: 10px;");


        this._controls.add_child(this._prevButton);
        this._controls.add_child(this._playPauseButton);
        this._controls.add_child(this._nextButton);


        this._content.add_child(this._controls);


        /*
         * Hover controls
         */
        this._actor.set_track_hover(true);


        this._hoverId = this._actor.connect(
            "notify::hover",
            () => {
                this._controls.visible = this._actor.hover;
            }
        );


        /*
         * Initial render
         */
        this._render();

        this._renderState(null);


        return this._actor;
    }


    enable() {
        this._media.start(
            state => this._renderState(state)
        );
    }


    disable() {

        this._media.stop();


        if (this._repaintId !== null && this._fallbackArea) {
            this._fallbackArea.disconnect(this._repaintId);

            this._repaintId = null;
        }


        if (this._hoverId !== null && this._actor) {
            this._actor.disconnect(this._hoverId);

            this._hoverId = null;
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
                icon_size: 18
            })
        });


        button.connect(
            "clicked",
            onClicked
        );


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

        if (!path)
            return;


        try {

            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);


            if (appInfo) {
                appInfo.launch([], null);
            } else {
                this._api.logger.info(
                    `media-player-square: could not read .desktop file at ${path}`
                );
            }

        } catch (e) {

            this._api.logger.info(
                `media-player-square: failed to launch ${path}: ${e}`
            );
        }
    }


    _applyArtStyle() {

        if (this._artIcon) {
            this._artIcon.set_style(
                `border-radius: ${COVER_RADIUS}px; ` +
                `background-size: cover; ` +
                `background-position: center;`
            );
        }
    }


    _render() {

        /*
         * Main card styling
         */
        this._actor.set_style(
            this._api.resolveCardCss?.() ??
            _cardStyleCss(this._settings, {
                cornerRadiusFallback: 18
            })
        );


        /*
         * Cover background
         */
        this._coverStack.set_style(
            `background-color: rgba(255,255,255,0.05); ` +
            `border-radius: ${COVER_RADIUS}px;`
        );


        this._applyArtStyle();


        /*
         * Text
         */
        const infoColor = _toCssColor(
            this._settings.infoColor,
            "#FFFFFFFF"
        );


        const infoFont = _parseFontDescription(
            this._settings.infoFont ?? "Sans Bold 13",
            "Sans Bold",
            13
        );


        this._titleLabel.set_style(
            `color: ${infoColor}; ` +
            `font-family: ${infoFont.family}; ` +
            `font-size: ${infoFont.size}px; ` +
            `font-weight: bold;`
        );


        this._albumLabel.set_style(
            `color: ${infoColor}; ` +
            `font-family: ${infoFont.family}; ` +
            `font-size: ${Math.max(8, infoFont.size - 3)}px; ` +
            `opacity: 0.85;`
        );


        this._artistLabel.set_style(
            `color: ${infoColor}; ` +
            `font-family: ${infoFont.family}; ` +
            `font-size: ${Math.max(8, infoFont.size - 3)}px; ` +
            `opacity: 0.85;`
        );


        /*
         * Playback buttons
         */
        const buttonColor = _toCssColor(
            this._settings.buttonColor,
            "#FFFFFFFF"
        );


        for (const button of [
            this._prevButton,
            this._playPauseButton,
            this._nextButton
        ]) {

            button.set_style(
                `background-color: rgba(0,0,0,0.45); ` +
                `border-radius: 999px; ` +
                `padding: 8px; ` +
                `color: ${buttonColor};`
            );


            button.child.set_style(
                `color: ${buttonColor};`
            );
        }


        if (this._fallbackArea)
            this._fallbackArea.queue_repaint();
    }


    _renderState(state) {

        this._state = state;


        /*
         * No media
         */
        if (!state) {

            this._titleLabel.set_text("");
            this._albumLabel.set_text("");
            this._artistLabel.set_text("");

            this._textBox.hide();
            this._scrim.hide();


            this._playPauseButton.child.icon_name =
                "media-playback-start-symbolic";


            this._showFallbackArt();

            return;
        }


        /*
         * Media exists
         */
        this._textBox.show();
        this._scrim.show();


        this._titleLabel.set_text(state.title);
        this._albumLabel.set_text(state.album);
        this._artistLabel.set_text(state.artist);


        this._playPauseButton.child.icon_name =
            state.status === "Playing"
                ? "media-playback-pause-symbolic"
                : "media-playback-start-symbolic";


        /*
         * Artwork
         */
        if (state.artUrl.length > 0) {

            try {

                const file =
                    state.artUrl.startsWith("file://")
                        ? Gio.File.new_for_uri(state.artUrl)
                        : Gio.File.new_for_path(state.artUrl);


                this._artIcon.set_style(
                    `border-radius: ${COVER_RADIUS}px; ` +
                    `background-size: cover; ` +
                    `background-position: center; ` +
                    `background-image: url("${file.get_uri()}");`
                );


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

        const w = COVER_SIZE;
        const h = COVER_SIZE;


        /*
         * Clear
         */
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();


        cr.setOperator(Cairo.Operator.OVER);


        /*
         * Gradient colors
         */
        const start = _hexToRgba("#FF8A00FF");
        const end = _hexToRgba("#B3260AFF");


        const gradient = new Cairo.LinearGradient(
            0,
            0,
            w,
            h
        );


        gradient.addColorStopRGBA(
            0,
            start.r,
            start.g,
            start.b,
            start.a
        );


        gradient.addColorStopRGBA(
            1,
            end.r,
            end.g,
            end.b,
            end.a
        );


        /*
         * Rounded rectangle
         */
        const radius = COVER_RADIUS;


        cr.newSubPath();


        cr.arc(
            w - radius,
            radius,
            radius,
            -Math.PI / 2,
            0
        );


        cr.arc(
            w - radius,
            h - radius,
            radius,
            0,
            Math.PI / 2
        );


        cr.arc(
            radius,
            h - radius,
            radius,
            Math.PI / 2,
            Math.PI
        );


        cr.arc(
            radius,
            radius,
            radius,
            Math.PI,
            3 * Math.PI / 2
        );


        cr.closePath();


        cr.setSource(gradient);

        cr.fill();


        cr.$dispose();
    }
}
