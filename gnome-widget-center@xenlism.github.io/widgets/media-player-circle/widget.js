import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Pango from "gi://Pango";
import Cairo from "cairo";
import GdkPixbuf from "gi://GdkPixbuf";

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

const RING_SIZE = 153;
const RING_THICKNESS = 6;

const COVER_SIZE = 104;


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
            size
        };
    } catch (e) {
        return {
            family: fallbackFamily,
            size: fallbackSize
        };
    }
}


export default class MediaPlayerCircleWidget {

    constructor(api) {
        this._api = api;
        this._settings = api.settings;

        this._media = new MprisMediaService(api.logger);

        this._state = null;

        this._fraction = 0;

        this._baseMonotonicUs = 0;
        this._basePositionMs = 0;

        this._tickTimerId = null;

        this._ringRepaintId = null;
        this._fallbackRepaintId = null;
        this._hoverId = null;
    }


    buildActor() {

        /*
         * Main widget
         *
         * Use fixed SIZE instead of BindConstraint.
         * This gives us a reliable coordinate system:
         *
         * 0,0 ---------------- 176,0
         *  |                    |
         *  |       CENTER       |
         *  |      (88,88)       |
         *  |                    |
         * 0,176 -------------- 176,176
         */
        this._actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: SIZE,
            height: SIZE,
            reactive: true
        });


        /*
         * Content layer
         *
         * Fixed size = widget size.
         * This makes manual x/y centering predictable.
         */
        this._content = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: SIZE,
            height: SIZE,
            clip_to_allocation: true
        });

        this._actor.add_child(this._content);


        /*
         * =========================
         * Progress Ring
         * =========================
         *
         * Center manually.
         *
         * (176 - 153) / 2 = 11.5
         *
         * Using Math.round gives:
         * x = 12
         * y = 12
         */
        this._ringArea = new St.DrawingArea({
            width: RING_SIZE,
            height: RING_SIZE,

            x: Math.round((SIZE - RING_SIZE) / 2),
            y: Math.round((SIZE - RING_SIZE) / 2),

            clip_to_allocation: true
        });

        this._content.add_child(this._ringArea);

        this._ringRepaintId = this._ringArea.connect(
            "repaint",
            () => this._onRingRepaint()
        );


        /*
         * =========================
         * Cover Stack
         * =========================
         *
         * Center manually.
         *
         * (176 - 104) / 2 = 36
         *
         * So:
         * x = 36
         * y = 36
         */
        this._coverStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),

            width: COVER_SIZE,
            height: COVER_SIZE,

            x: Math.round((SIZE - COVER_SIZE) / 2),
            y: Math.round((SIZE - COVER_SIZE) / 2),

            style: `
                background-color: rgba(255,255,255,0.06);
                border-radius: 999px;
            `,

            clip_to_allocation: true
        });

        this._content.add_child(this._coverStack);


        this._fallbackArea = new St.DrawingArea({
            width: COVER_SIZE,
            height: COVER_SIZE
        });

        this._coverStack.add_child(this._fallbackArea);

        this._fallbackRepaintId = this._fallbackArea.connect(
            "repaint",
            () => this._onFallbackRepaint()
        );


        /*
         * Fallback icon
         */
        this._fallbackIcon = new St.Icon({
            icon_name: "audio-x-generic-symbolic",
            icon_size: 40,

            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,

            style: "color: rgba(255,255,255,0.9);"
        });

        this._coverStack.add_child(this._fallbackIcon);


        this._artIcon = new St.Widget({
            width: COVER_SIZE,
            height: COVER_SIZE,

            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,

            style: `
                border-radius: 999px;
                background-size: cover;
                background-position: center;
            `,

            visible: false
        });

        this._coverStack.add_child(this._artIcon);


        this._titleLabel = new St.Label({
            text: "No media playing"
        });

        this._artistLabel = new St.Label({
            text: ""
        });


        /*
         * Do not ellipsize.
         *
         * Content layer clips anything that overflows.
         */
        for (const label of [
            this._titleLabel,
            this._artistLabel
        ]) {
            label.clutter_text.set_line_wrap(false);
        }


        this._textBox = new St.BoxLayout({
            vertical: true,

            width: SIZE - 24,

            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END
        });

        this._textBox.set_style(
            "padding-bottom: 14px;"
        );

        this._textBox.add_child(this._titleLabel);
        this._textBox.add_child(this._artistLabel);

        this._content.add_child(this._textBox);


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


        this._controls = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,

            visible: false
        });

        this._controls.set_style(
            "spacing: 8px;"
        );

        this._controls.add_child(this._prevButton);
        this._controls.add_child(this._playPauseButton);
        this._controls.add_child(this._nextButton);

        this._content.add_child(this._controls);


        this._actor.set_track_hover(true);

        this._hoverId = this._actor.connect(
            "notify::hover",
            () => {
                this._controls.visible = this._actor.hover;
            }
        );


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

        this._stopTicker();


        if (
            this._ringRepaintId !== null &&
            this._ringArea
        ) {
            this._ringArea.disconnect(
                this._ringRepaintId
            );

            this._ringRepaintId = null;
        }


        if (
            this._fallbackRepaintId !== null &&
            this._fallbackArea
        ) {
            this._fallbackArea.disconnect(
                this._fallbackRepaintId
            );

            this._fallbackRepaintId = null;
        }


        if (
            this._hoverId !== null &&
            this._actor
        ) {
            this._actor.disconnect(
                this._hoverId
            );

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
                icon_size: 16
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

            const appInfo =
                Gio.DesktopAppInfo.new_from_filename(path);

            if (appInfo) {

                appInfo.launch([], null);

            } else {

                this._api.logger.info(
                    `media-player-circle: could not read .desktop file at ${path}`
                );
            }

        } catch (e) {

            this._api.logger.info(
                `media-player-circle: failed to launch ${path}: ${e}`
            );
        }
    }


    _render() {

        /*
         * Card style
         */
        this._actor.set_style(
            this._api.resolveCardCss?.() ??
            _cardStyleCss(
                this._settings,
                {
                    cornerRadiusFallback: 999
                }
            )
        );


        /*
         * Text colors / fonts
         */
        const infoColor = _toCssColor(
            this._settings.infoColor,
            "#FFFFFFFF"
        );

        const infoFont = _parseFontDescription(
            this._settings.infoFont ?? "Sans Bold 11",
            "Sans Bold",
            11
        );


        this._titleLabel.set_style(
            `color: ${infoColor}; ` +
            `font-family: ${infoFont.family}; ` +
            `font-size: ${infoFont.size}px; ` +
            `font-weight: bold; ` +
            `text-align: center;`
        );


        this._artistLabel.set_style(
            `color: ${infoColor}; ` +
            `font-family: ${infoFont.family}; ` +
            `font-size: ${Math.max(8, infoFont.size - 2)}px; ` +
            `opacity: 0.85; ` +
            `text-align: center;`
        );


        /*
         * Control buttons
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
                `padding: 7px; ` +
                `color: ${buttonColor};`
            );

            button.child.set_style(
                `color: ${buttonColor};`
            );
        }


        /*
         * Repaint custom drawing areas
         */
        if (this._ringArea)
            this._ringArea.queue_repaint();

        if (this._fallbackArea)
            this._fallbackArea.queue_repaint();
    }


    _renderState(state) {

        this._state = state;


        if (!state) {

            this._titleLabel.set_text("");
            this._artistLabel.set_text("");

            this._textBox.hide();

            this._playPauseButton.child.icon_name =
                "media-playback-start-symbolic";

            this._showFallbackArt();

            this._fraction = 0;

            this._stopTicker();

            if (this._ringArea)
                this._ringArea.queue_repaint();

            return;
        }


        this._textBox.show();

        this._titleLabel.set_text(
            state.title
        );

        this._artistLabel.set_text(
            state.artist
        );


        this._playPauseButton.child.icon_name =
            state.status === "Playing"
                ? "media-playback-pause-symbolic"
                : "media-playback-start-symbolic";


        /*
         * Album art
         */
        if (state.artUrl.length > 0) {

            try {

                const file =
                    state.artUrl.startsWith("file://")
                        ? Gio.File.new_for_uri(state.artUrl)
                        : Gio.File.new_for_path(state.artUrl);


                this._artIcon.set_style(
                    this._coverBackgroundStyle(file)
                );

                this._showArt();

            } catch (e) {

                this._showFallbackArt();
            }

        } else {

            this._showFallbackArt();
        }


        /*
         * Position tracking
         */
        this._baseMonotonicUs =
            GLib.get_monotonic_time();

        this._basePositionMs =
            state.positionMs;


        this._updateFraction(
            state.lengthMs
        );


        if (state.status === "Playing") {

            this._startTicker();

        } else {

            this._stopTicker();
        }
    }


    _startTicker() {

        if (this._tickTimerId !== null)
            return;


        this._tickTimerId =
            GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                1,
                () => {

                    this._updateFraction(
                        this._state?.lengthMs ?? 0
                    );

                    return GLib.SOURCE_CONTINUE;
                }
            );
    }


    _stopTicker() {

        if (this._tickTimerId !== null) {

            GLib.source_remove(
                this._tickTimerId
            );

            this._tickTimerId = null;
        }
    }


    _updateFraction(lengthMs) {

        const elapsedMs =
            (
                GLib.get_monotonic_time() -
                this._baseMonotonicUs
            ) / 1e3;


        const positionMs =
            this._basePositionMs +
            elapsedMs;


        this._fraction =
            lengthMs > 0
                ? Math.max(
                    0,
                    Math.min(
                        1,
                        positionMs / lengthMs
                    )
                )
                : 0;


        if (this._ringArea)
            this._ringArea.queue_repaint();
    }


    _showArt() {

        this._artIcon.show();

        this._fallbackArea.hide();

        this._fallbackIcon.hide();
    }


    /**
     * St's CSS engine doesn't actually center a
     * "background-size: cover; background-position: center;"
     * declaration the way a browser would.
     *
     * Compute explicit pixel background-size and
     * background-position so non-square artwork is
     * scaled to cover and centered correctly.
     */
    _coverBackgroundStyle(file) {

        const uri = file.get_uri();


        const fallback =
            `border-radius: 999px; ` +
            `background-size: ${COVER_SIZE}px ${COVER_SIZE}px; ` +
            `background-position: 0px 0px; ` +
            `background-image: url("${uri}");`;


        const path = file.get_path();

        if (!path)
            return fallback;


        let width;
        let height;


        try {

            [
                ,
                width,
                height
            ] = GdkPixbuf.Pixbuf.get_file_info(path);

        } catch (e) {

            return fallback;
        }


        if (!width || !height)
            return fallback;


        /*
         * Scale image to cover the entire circle.
         */
        const scale =
            Math.max(
                COVER_SIZE / width,
                COVER_SIZE / height
            );


        const scaledWidth =
            Math.ceil(width * scale);

        const scaledHeight =
            Math.ceil(height * scale);


        /*
         * Center the scaled image.
         */
        const offsetX =
            -Math.round(
                (scaledWidth - COVER_SIZE) / 2
            );

        const offsetY =
            -Math.round(
                (scaledHeight - COVER_SIZE) / 2
            );


        return (
            `border-radius: 999px; ` +
            `background-size: ${scaledWidth}px ${scaledHeight}px; ` +
            `background-position: ${offsetX}px ${offsetY}px; ` +
            `background-image: url("${uri}");`
        );
    }


    _showFallbackArt() {

        this._artIcon.hide();

        this._fallbackArea.show();

        this._fallbackIcon.show();
    }


    _onRingRepaint() {

        const cr =
            this._ringArea.get_context();


        /*
         * Clear canvas
         */
        cr.setOperator(
            Cairo.Operator.CLEAR
        );

        cr.paint();


        cr.setOperator(
            Cairo.Operator.OVER
        );


        /*
         * Colors
         */
        const baseColor =
            _hexToRgba("#FFFFFF26");

        const ringColor =
            _hexToRgba(
                this._settings.ringColor ??
                "#F5A623FF"
            );


        /*
         * Ring coordinate system is 153x153.
         *
         * Therefore the ring itself is perfectly
         * centered inside _ringArea.
         */
        const cx =
            RING_SIZE / 2;

        const cy =
            RING_SIZE / 2;


        const radius =
            (RING_SIZE - RING_THICKNESS) / 2 - 2;


        const startAngle =
            -Math.PI / 2;


        const fraction =
            Math.max(
                0,
                Math.min(
                    1,
                    this._fraction
                )
            );


        const endAngle =
            startAngle +
            fraction * 2 * Math.PI;


        /*
         * Base ring
         */
        cr.setLineWidth(
            RING_THICKNESS
        );

        cr.setLineCap(
            Cairo.LineCap.ROUND
        );

        cr.setSourceRGBA(
            baseColor.r,
            baseColor.g,
            baseColor.b,
            baseColor.a
        );


        cr.arc(
            cx,
            cy,
            radius,
            0,
            2 * Math.PI
        );

        cr.stroke();


        /*
         * Progress ring
         */
        if (fraction > 0) {

            cr.setSourceRGBA(
                ringColor.r,
                ringColor.g,
                ringColor.b,
                ringColor.a
            );


            cr.arc(
                cx,
                cy,
                radius,
                startAngle,
                endAngle
            );

            cr.stroke();
        }


        cr.$dispose();
    }


    _onFallbackRepaint() {

        const cr =
            this._fallbackArea.get_context();


        const w =
            COVER_SIZE;

        const h =
            COVER_SIZE;


        /*
         * Clear
         */
        cr.setOperator(
            Cairo.Operator.CLEAR
        );

        cr.paint();


        cr.setOperator(
            Cairo.Operator.OVER
        );


        /*
         * Gradient colors
         */
        const start =
            _hexToRgba("#FF8A00FF");

        const end =
            _hexToRgba("#B3260AFF");


        /*
         * Gradient
         */
        const gradient =
            new Cairo.LinearGradient(
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
         * Circle
         */
        cr.arc(
            w / 2,
            h / 2,
            Math.min(w, h) / 2,
            0,
            2 * Math.PI
        );


        cr.setSource(
            gradient
        );

        cr.fill();


        cr.$dispose();
    }
}

