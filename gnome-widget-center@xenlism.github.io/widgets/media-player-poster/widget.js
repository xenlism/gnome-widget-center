// widgets/media-player-poster/widget.js
//
// 2x2 poster card: large album cover on top, bold track title + smaller
// artist line below it, then a row of Play/Previous/Next controls -
// solid background, no blur. Talks to whatever MPRIS2 player is running
// via lib/mediaApi.js's MprisMediaService (WIDGET_API.md §9.1) - signal-
// driven updates only, no DBus polling, full cleanup in disable().
//
// Cover click: raises the attached player if one exists, otherwise
// launches the app configured in config.json's desktopFilePath field
// (Gio.DesktopAppInfo, same pattern as widgets/clock-modern/widget.js's
// _launchApp()). The Play button falls back to the same launch behavior
// on its very first click when no player is attached yet - same
// convention as this widget's 1x1/2x1 siblings (media-player-square,
// media-player-circle, media-player-wide).

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

// 2x2 block-type is 23x23 cells x 16px = 368px, not 336px - see the
// identical note in media-player-square/widget.js. PADDING kept fixed
// (card design constant, not size-derived) so CONTENT_SIZE grows with
// SIZE; COVER_HEIGHT scaled by the same 368/336 ratio.
const SIZE = 368;
const PADDING = 16;
const CONTENT_SIZE = SIZE - PADDING * 2;
const COVER_HEIGHT = 188;

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

export default class MediaPlayerPosterWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._media = new MprisMediaService(api.logger);
        this._state = null;
        this._repaintId = null;
    }

    buildActor() {
        this._actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: SIZE,
            height: SIZE,
        });

        this._contentBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._contentBox.set_style(`padding: ${PADDING}px;`);
        this._actor.add_child(this._contentBox);

        // --- Cover ---
        this._coverStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: CONTENT_SIZE,
            height: COVER_HEIGHT,
            clip_to_allocation: true,
        });
        this._contentBox.add_child(this._coverStack);

        this._fallbackArea = new St.DrawingArea({width: CONTENT_SIZE, height: COVER_HEIGHT});
        this._coverStack.add_child(this._fallbackArea);
        this._repaintId = this._fallbackArea.connect('repaint', () => this._onFallbackRepaint());

        this._fallbackIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 64,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.9);',
        });
        this._coverStack.add_child(this._fallbackIcon);

        // Album art layer - painted via CSS background-image/cover
        // instead of St.Icon; see media-player-square's identical fix
        // for the full explanation. Sized to CONTENT_SIZE x COVER_HEIGHT
        // (the full rectangular cover area, not a centered square) since
        // this is the widget where the aspect-ratio mismatch was most
        // visible - a square icon centered in a much wider rectangle.
        this._artIcon = new St.Widget({
            width: CONTENT_SIZE,
            height: COVER_HEIGHT,
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
        this._coverStack.add_child(this._coverButton);

        // --- Track title (big) / artist (small) ---
        this._titleLabel = new St.Label({text: 'No media playing'});
        this._artistLabel = new St.Label({text: ''});
        for (const label of [this._titleLabel, this._artistLabel])
            label.clutter_text.set_ellipsize(3 /* Pango.EllipsizeMode.END */);

        this._titleLabel.set_style('margin-top: 12px;');
        this._artistLabel.set_style('margin-top: 3px;');
        this._contentBox.add_child(this._titleLabel);
        this._contentBox.add_child(this._artistLabel);

        // pushes the controls row toward the bottom of the card
        const spacer = new St.Widget({y_expand: true});
        this._contentBox.add_child(spacer);

        // --- Controls (always visible, just Prev/Play/Next) ---
        this._prevButton = this._makeButton('media-skip-backward-symbolic', () => this._media.previous());
        this._playPauseButton = this._makeButton('media-playback-start-symbolic', () => this._onPlayClicked());
        this._nextButton = this._makeButton('media-skip-forward-symbolic', () => this._media.next());

        this._controls = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._controls.set_style('spacing: 14px;');
        this._controls.add_child(this._prevButton);
        this._controls.add_child(this._playPauseButton);
        this._controls.add_child(this._nextButton);
        this._contentBox.add_child(this._controls);

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
            widgetCornerRadius: 18,
            coverCornerRadius: 18,
            trackFont: 'Sans Bold 20',
            trackColor: '#FFFFFFFF',
            artistFont: 'Sans 13',
            artistColor: '#FFFFFFB3',
            buttonColor: '#FFFFFFFF',
            desktopFilePath: '',
        };
    }

    onSettingsChanged() {
        this._render();
    }

    /** @private */
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
                this._api.logger.info(`media-player-poster: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`media-player-poster: failed to launch ${path}: ${e}`);
        }
    }

    /** @private */
    _render() {
        this._actor.set_style(_cardStyleCss(this._settings, {
            backgroundColorFallback: '#FFFFFF00',
            cornerRadiusKey: 'widgetCornerRadius',
            cornerRadiusFallback: 18,
        }));

        const coverCornerRadius = this._settings.coverCornerRadius ?? 18;
        this._coverStack.set_style(
            `background-color: rgba(255,255,255,0.05); border-radius: ${coverCornerRadius}px;`
        );
        this._artIcon.set_style(`border-radius: ${coverCornerRadius}px; background-size: cover; background-position: center;`);

        const trackColor = _toCssColor(this._settings.trackColor, '#FFFFFFFF');
        const trackFont = _parseFontDescription(this._settings.trackFont ?? 'Sans Bold 20', 'Sans Bold', 20);
        this._titleLabel.set_style(
            `margin-top: 12px; color: ${trackColor}; font-family: ${trackFont.family}; ` +
            `font-size: ${trackFont.size}px; font-weight: bold;`
        );

        const artistColor = _toCssColor(this._settings.artistColor, '#FFFFFFB3');
        const artistFont = _parseFontDescription(this._settings.artistFont ?? 'Sans 13', 'Sans', 13);
        this._artistLabel.set_style(
            `margin-top: 3px; color: ${artistColor}; font-family: ${artistFont.family}; ` +
            `font-size: ${artistFont.size}px;`
        );

        const buttonColor = _toCssColor(this._settings.buttonColor, '#FFFFFFFF');
        for (const button of [this._prevButton, this._playPauseButton, this._nextButton]) {
            button.set_style(
                `background-color: rgba(255,255,255,0.12); border-radius: 999px; padding: 10px; color: ${buttonColor};`
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
            this._artistLabel.set_text('');
            this._titleLabel.hide();
            this._artistLabel.hide();
            this._playPauseButton.child.icon_name = 'media-playback-start-symbolic';
            this._showFallbackArt();
            return;
        }

        this._titleLabel.show();
        this._artistLabel.show();
        this._titleLabel.set_text(state.title);
        this._artistLabel.set_text(state.artist);
        this._playPauseButton.child.icon_name = state.status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        if (state.artUrl.length > 0) {
            try {
                const file = state.artUrl.startsWith('file://')
                    ? Gio.File.new_for_uri(state.artUrl)
                    : Gio.File.new_for_path(state.artUrl);
                const coverCornerRadius = this._settings.coverCornerRadius ?? 18;
                this._artIcon.set_style(
                    `border-radius: ${coverCornerRadius}px; background-size: cover; background-position: center; ` +
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
     * placeholder shown when the player reports no artwork. Corner
     * radius follows the coverCornerRadius setting so the fallback
     * always matches real artwork's frame. */
    _onFallbackRepaint() {
        const cr = this._fallbackArea.get_context();
        const w = CONTENT_SIZE;
        const h = COVER_HEIGHT;

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const start = _hexToRgba('#FF8A00FF');
        const end = _hexToRgba('#B3260AFF');
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
