// widgets/media-player-wide/widget.js
//
// 2x1 card: album cover fills the left half, track info + always-visible
// Play/Previous/Next controls fill the right half (no hover-reveal here -
// there's already room for the controls, unlike the 1x1 square/circle
// siblings). Talks to whatever MPRIS2 player is running via
// lib/mediaApi.js's MprisMediaService (WIDGET_API.md §9.1) - signal-
// driven updates only, no DBus polling, full cleanup in disable().
//
// Cover click: raises the attached player if one exists, otherwise
// launches the app configured in config.json's desktopFilePath field
// (Gio.DesktopAppInfo, same pattern as widgets/clock-modern/widget.js's
// _launchApp()). The Play button falls back to the same launch behavior
// on its very first click when no player is attached yet.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Cairo from 'cairo';
import {MprisMediaService} from '../../lib/mediaApi.js';
// Standardized on lib/widgetVisualKit.js (2026-08-03) - see the identical
// note in media-player-square/widget.js for why this replaced a local
// per-file copy of these helpers.
import {
    SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba, toCssColor as _toCssColor,
} from '../../lib/widgetVisualKit.js';

// 2x1 block-type is 23x11 cells x 16px = 368x176px, not 336x160 - see
// the identical note in media-player-square/widget.js. LEFT_WIDTH stays
// exactly half of WIDTH (was 168 = 336/2, now 184 = 368/2). COVER_SIZE
// keeps its original 14px padding from HEIGHT rather than scaling
// proportionally (176 - 2*14 = 148), matching how circles-clock/widget.js
// handled the same migration.
const WIDTH = 368;
const HEIGHT = 176;
const LEFT_WIDTH = 184;
const COVER_SIZE = 148;
const COVER_RADIUS = 15;

/** @private splits a combined Pango font-description string into the
 * family/size pieces St's set_style() needs - see
 * widgets/clock-modern/widget.js's _parseFontDescription(). */
function _parseFontDescription(fontStr, fallbackFamily, fallbackSize) {
    try {
        const desc = Pango.FontDescription.from_string(fontStr);
        const rawSize = desc.get_size();
        const size = rawSize > 0 ? Math.round(rawSize / Pango.SCALE) : fallbackSize;
        desc.unset_fields(Pango.FontMask.SIZE);
        const family = desc.to_string().trim();
        return {family: family || fallbackFamily, size};
    } catch (e) {
        return {family: fallbackFamily, size: fallbackSize};
    }
}

export default class MediaPlayerWideWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._media = new MprisMediaService(api.logger);
        this._state = null;
        this._repaintId = null;
    }

    buildActor() {
        this._actor = new St.BoxLayout({
            width: WIDTH,
            height: HEIGHT,
        });

        // --- Left half: cover ---
        this._leftStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: LEFT_WIDTH,
            height: HEIGHT,
        });
        this._actor.add_child(this._leftStack);

        this._coverStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: COVER_SIZE,
            height: COVER_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });
        this._leftStack.add_child(this._coverStack);

        this._fallbackArea = new St.DrawingArea({width: COVER_SIZE, height: COVER_SIZE});
        this._coverStack.add_child(this._fallbackArea);
        this._repaintId = this._fallbackArea.connect('repaint', () => this._onFallbackRepaint());

        this._fallbackIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 52,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.9);',
        });
        this._coverStack.add_child(this._fallbackIcon);

        // Album art layer - painted via CSS background-image/cover
        // instead of St.Icon; see media-player-square's identical fix
        // for the full explanation (St.Icon letterboxes non-square art
        // instead of filling the frame).
        this._artIcon = new St.Widget({
            width: COVER_SIZE,
            height: COVER_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._coverStack.add_child(this._artIcon);

        this._coverButton = new St.Button({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            style: 'background-color: transparent;',
        });
        this._coverButton.connect('clicked', () => this._onCoverClicked());
        this._leftStack.add_child(this._coverButton);

        // --- Right half: track info + controls ---
        this._rightBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._rightBox.set_style('padding: 16px;');
        this._actor.add_child(this._rightBox);

        this._titleLabel = new St.Label({text: 'No media playing'});
        this._albumLabel = new St.Label({text: ''});
        this._artistLabel = new St.Label({text: ''});
        for (const label of [this._titleLabel, this._albumLabel, this._artistLabel])
            label.clutter_text.set_ellipsize(3 /* Pango.EllipsizeMode.END */);

        this._infoBox = new St.BoxLayout({vertical: true, y_expand: true});
        this._infoBox.add_child(this._titleLabel);
        this._infoBox.add_child(this._albumLabel);
        this._infoBox.add_child(this._artistLabel);
        this._rightBox.add_child(this._infoBox);

        this._prevButton = this._makeButton('media-skip-backward-symbolic', () => this._media.previous());
        this._playPauseButton = this._makeButton('media-playback-start-symbolic', () => this._onPlayClicked());
        this._nextButton = this._makeButton('media-skip-forward-symbolic', () => this._media.next());

        this._controls = new St.BoxLayout();
        this._controls.set_style('spacing: 10px;');
        this._controls.add_child(this._prevButton);
        this._controls.add_child(this._playPauseButton);
        this._controls.add_child(this._nextButton);
        this._rightBox.add_child(this._controls);

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
            ...SHADOW_DEFAULTS,
            backgroundColor: '#FFFFFF00',
            cornerRadius: 18,
            infoFont: 'Sans Bold 18',
            infoColor: '#FFFFFFFF',
            buttonColor: '#EAEAEAFF',
            desktopFilePath: '',
        };
    }

    onSettingsChanged() {
        this._render();
    }

    /** @private buttons "styled like the reference" - rounded-square
     * tiles, not circular pills, matching the wide-card mockup. */
    _makeButton(iconName, onClicked) {
        const button = new St.Button({
            child: new St.Icon({icon_name: iconName, icon_size: 20}),
        });
        button.connect('clicked', onClicked);
        return button;
    }

    /** @private */
    _onPlayClicked() {
        if (!this._state) {
            this._onCoverClicked();
            return;
        }
        this._media.playPause();
    }

    /** @private */
    _onCoverClicked() {
        if (this._state) {
            this._media.raise();
            return;
        }
        this._launchApp();
    }

    /** @private */
    _launchApp() {
        const path = this._settings.desktopFilePath ?? '';
        if (!path)
            return;
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
            if (appInfo)
                appInfo.launch([], null);
            else
                this._api.logger.info(`media-player-wide: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`media-player-wide: failed to launch ${path}: ${e}`);
        }
    }

    /** @private */
    _render() {
        this._actor.set_style(_cardStyleCss(this._settings, {cornerRadiusFallback: 18}));
        this._coverStack.set_style(`background-color: rgba(255,255,255,0.05); border-radius: ${COVER_RADIUS}px;`);
        this._artIcon.set_style(`border-radius: ${COVER_RADIUS}px; background-size: cover; background-position: center;`);

        const infoColor = _toCssColor(this._settings.infoColor, '#FFFFFFFF');
        const infoFont = _parseFontDescription(this._settings.infoFont ?? 'Sans Bold 18', 'Sans Bold', 18);
        this._titleLabel.set_style(
            `color: ${infoColor}; font-family: ${infoFont.family}; font-size: ${infoFont.size}px; font-weight: bold;`
        );
        this._albumLabel.set_style(
            `color: ${infoColor}; font-family: ${infoFont.family}; font-size: ${Math.max(10, infoFont.size - 5)}px; opacity: 0.85;`
        );
        this._artistLabel.set_style(
            `color: ${infoColor}; font-family: ${infoFont.family}; font-size: ${Math.max(10, infoFont.size - 5)}px; opacity: 0.85;`
        );

        const buttonColor = _toCssColor(this._settings.buttonColor, '#EAEAEAFF');
        for (const button of [this._prevButton, this._playPauseButton, this._nextButton]) {
            button.set_style(
                `background-color: rgba(255,255,255,0.14); border-radius: 12px; padding: 10px; color: ${buttonColor};`
            );
            button.child.set_style(`color: ${buttonColor};`);
        }

        if (this._fallbackArea)
            this._fallbackArea.queue_repaint();
    }

    /**
     * @private
     * @param {import('../../lib/mediaApi.js').MediaState|null} state
     */
    _renderState(state) {
        this._state = state;

        if (!state) {
            this._titleLabel.set_text('');
            this._albumLabel.set_text('');
            this._artistLabel.set_text('');
            this._infoBox.hide();
            this._playPauseButton.child.icon_name = 'media-playback-start-symbolic';
            this._showFallbackArt();
            return;
        }

        this._infoBox.show();
        this._titleLabel.set_text(state.title);
        this._albumLabel.set_text(state.album);
        this._artistLabel.set_text(state.artist);
        this._playPauseButton.child.icon_name = state.status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        if (state.artUrl.length > 0) {
            try {
                const file = state.artUrl.startsWith('file://')
                    ? Gio.File.new_for_uri(state.artUrl)
                    : Gio.File.new_for_path(state.artUrl);
                const cornerRadius = COVER_RADIUS;
                this._artIcon.set_style(
                    `border-radius: ${cornerRadius}px; background-size: cover; background-position: center; ` +
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

    /** @private */
    _showArt() {
        this._artIcon.show();
        this._fallbackArea.hide();
        this._fallbackIcon.hide();
    }

    /** @private */
    _showFallbackArt() {
        this._artIcon.hide();
        this._fallbackArea.show();
        this._fallbackIcon.show();
    }

    /** @private StDrawingArea::repaint handler - rounded orange-gradient
     * placeholder shown when the player reports no artwork. */
    _onFallbackRepaint() {
        const cr = this._fallbackArea.get_context();
        const w = COVER_SIZE;
        const h = COVER_SIZE;

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const start = _hexToRgba('#FF8A00FF');
        const end = _hexToRgba('#B3260AFF');
        const gradient = new Cairo.LinearGradient(0, 0, w, h);
        gradient.addColorStopRGBA(0, start.r, start.g, start.b, start.a);
        gradient.addColorStopRGBA(1, end.r, end.g, end.b, end.a);

        const radius = COVER_RADIUS;
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
