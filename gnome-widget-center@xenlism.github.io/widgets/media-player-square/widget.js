// widgets/media-player-square/widget.js
//
// 1x1 card: album cover fills the widget behind a visible padded frame,
// track info overlays the bottom of the cover on a dark scrim, and
// Play/Previous/Next controls are hidden until the pointer hovers the
// widget. Talks to whatever MPRIS2 player is running via
// lib/mediaApi.js's MprisMediaService (WIDGET_API.md §9.1) - signal-
// driven updates only, no DBus polling, full proxy/signal cleanup in
// disable(). Same shape as widgets/media-player, just a different layout
// on top of the same service.
//
// Cover click: raises the attached player if one exists, otherwise
// launches the app configured in config.json's desktopFilePath field
// (Gio.DesktopAppInfo, same pattern as widgets/clock-modern/widget.js's
// _launchApp()). The Play button falls back to the same launch behavior
// on its very first click when no player is attached yet, so a person
// who has never opened their player can still start it from here.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Cairo from 'cairo';
import {MprisMediaService} from '../../lib/mediaApi.js';
// Standardized on lib/widgetVisualKit.js (2026-08-03) - this widget used
// to carry its own local copy of SHADOW_DEFAULTS/box-shadow-CSS/hex-color
// helpers (see git history), which is how the "1x1 is 176px not 160px"
// migration and other fixes had to be applied four times over in
// media-player-square/circle/wide/poster instead of once. Every other
// bundled widget (archey-sysfetch, folder-widget-*, power-menu,
// settings-control, circles-*, calendar-*, ...) already imports this same
// file - WIDGET_API.md §9's restriction is on reaching into OTHER
// widgets' folders, not on lib/, so this was always allowed, just never
// done here.
import {
    SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba, toCssColor as _toCssColor,
} from '../../lib/widgetVisualKit.js';

// 1x1 block-type is 11x11 cells x BLOCK_CELL_SIZE(16px) = 176px, not
// 160px (that was the old 10x10-cell table, replaced 2026-07-27 - see
// blockSizeManager.js's BLOCK_TYPES). The widget's root actor already
// gets forced to the correct 176x176 by BlockSizeManager.applyBlockSize()
// regardless of what SIZE says here, but this widget's own layout still
// built the cover/card *inside* that actor sized off the stale 160,
// leaving a real ~16px unfilled gap around the card - i.e. the
// background genuinely wasn't 100% of the block. COVER_SIZE/COVER_RADIUS
// scaled by the same 176/160 ratio to keep proportions.
const SIZE = 176;
const COVER_SIZE = 154;
const COVER_RADIUS = 18;

/** @private splits a combined Pango font-description string into the
 * family/size pieces St's set_style() needs separately - same pattern as
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

export default class MediaPlayerSquareWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
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
        this._actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: SIZE,
            height: SIZE,
            reactive: true,
            clip_to_allocation: false, // Allow shadow to render outside bounds
        });

        // --- Cover frame (padded inset, centered by BinLayout) ---
        this._coverStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: COVER_SIZE,
            height: COVER_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });
        this._actor.add_child(this._coverStack);

        this._fallbackArea = new St.DrawingArea({width: COVER_SIZE, height: COVER_SIZE});
        this._coverStack.add_child(this._fallbackArea);
        this._repaintId = this._fallbackArea.connect('repaint', () => this._onFallbackRepaint());

        this._fallbackIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 56,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.9);',
        });
        this._coverStack.add_child(this._fallbackIcon);

        // Album art layer: a plain St.Widget painted via CSS
        // background-image rather than an St.Icon holding a Gio.FileIcon.
        // St.Icon fits the image *inside* its icon_size box preserving
        // aspect ratio ("contain"), which is why art used to show up
        // letterboxed with visible gaps instead of filling the cover
        // area. Painting it as this actor's own background with
        // `background-size: cover` crops any overflow instead of padding
        // it, so the art always fills COVER_SIZE x COVER_SIZE exactly.
        // It's also drawn at full COVER_SIZE with its own border-radius
        // matching the cover frame - an actor's *background* respects its
        // own border-radius when St paints it, even though
        // clip_to_allocation on a parent only clips to a plain rectangle.
        // (That mismatch - a square icon child inside a circular parent -
        // was why media-player-circle's art never actually looked round.)
        this._artIcon = new St.Widget({
            width: COVER_SIZE,
            height: COVER_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._coverStack.add_child(this._artIcon);

        this._scrim = new St.Widget({
            width: COVER_SIZE,
            height: 58,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            style: 'background-color: rgba(0,0,0,0.55);',
        });
        this._coverStack.add_child(this._scrim);

        this._titleLabel = new St.Label({text: 'No media playing'});
        this._albumLabel = new St.Label({text: ''});
        this._artistLabel = new St.Label({text: ''});
        for (const label of [this._titleLabel, this._albumLabel, this._artistLabel])
            label.clutter_text.set_ellipsize(3 /* Pango.EllipsizeMode.END */);

        this._textBox = new St.BoxLayout({
            vertical: true,
            width: COVER_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this._textBox.set_style('padding: 8px;');
        this._textBox.add_child(this._titleLabel);
        this._textBox.add_child(this._albumLabel);
        this._textBox.add_child(this._artistLabel);
        this._coverStack.add_child(this._textBox);

        // --- Whole-widget click target for launch/focus (§8/§9.1) ---
        this._coverButton = new St.Button({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            style: 'background-color: transparent;',
        });
        this._coverButton.connect('clicked', () => this._onCoverClicked());
        this._actor.add_child(this._coverButton);

        // --- Hover-revealed controls (added last so they paint/hit-test
        // above the cover button). ---
        this._prevButton = this._makeButton('media-skip-backward-symbolic', () => this._media.previous());
        this._playPauseButton = this._makeButton('media-playback-start-symbolic', () => this._onPlayClicked());
        this._nextButton = this._makeButton('media-skip-forward-symbolic', () => this._media.next());

        this._controls = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._controls.set_style('spacing: 10px;');
        this._controls.add_child(this._prevButton);
        this._controls.add_child(this._playPauseButton);
        this._controls.add_child(this._nextButton);
        this._actor.add_child(this._controls);

        // Hover-reveal via St's built-in track_hover/`hover` property
        // rather than manually wiring enter-event/leave-event on the
        // root actor. The root has several overlapping reactive
        // descendants on top of it (coverButton, and the controls
        // themselves once shown) - track_hover is what St widgets use
        // internally to track pointer hover correctly across exactly
        // this kind of overlapping-children layout (it's the same
        // mechanism behind every ":hover" CSS pseudo-class in the Shell),
        // whereas hand-rolled enter/leave pairs on a plain actor are the
        // documented-flaky way to do it and were the source of hover
        // sometimes not registering while over the cover or the text.
        this._actor.set_track_hover(true);
        this._hoverId = this._actor.connect('notify::hover', () => {
            this._controls.visible = this._actor.hover;
        });

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
        if (this._hoverId !== null && this._actor) {
            this._actor.disconnect(this._hoverId);
            this._hoverId = null;
        }
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            backgroundColor: '#FFFFFF00',
            cornerRadius: 18,
            infoFont: 'Sans Bold 13',
            infoColor: '#FFFFFFFF',
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
            child: new St.Icon({icon_name: iconName, icon_size: 18}),
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
                this._api.logger.info(`media-player-square: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`media-player-square: failed to launch ${path}: ${e}`);
        }
    }

    /** @private keeps the art layer's rounding in sync with the cover
     * frame it sits inside - called from _render() since it's cheap and
     * settings-driven radius changes should apply immediately. */
    _applyArtStyle() {
        if (this._artIcon)
            this._artIcon.set_style(`border-radius: ${COVER_RADIUS}px; background-size: cover; background-position: center;`);
    }

    /** @private applies settings-driven colors/fonts; safe to call before
     * a player has ever been seen. */
    _render() {
        this._actor.set_style(_cardStyleCss(this._settings, {cornerRadiusFallback: 18}));
        this._coverStack.set_style(`background-color: rgba(255,255,255,0.05); border-radius: ${COVER_RADIUS}px;`);
        this._applyArtStyle();

        const infoColor = _toCssColor(this._settings.infoColor, '#FFFFFFFF');
        const infoFont = _parseFontDescription(this._settings.infoFont ?? 'Sans Bold 13', 'Sans Bold', 13);
        this._titleLabel.set_style(
            `color: ${infoColor}; font-family: ${infoFont.family}; font-size: ${infoFont.size}px; font-weight: bold;`
        );
        this._albumLabel.set_style(
            `color: ${infoColor}; font-family: ${infoFont.family}; font-size: ${Math.max(8, infoFont.size - 3)}px; opacity: 0.85;`
        );
        this._artistLabel.set_style(
            `color: ${infoColor}; font-family: ${infoFont.family}; font-size: ${Math.max(8, infoFont.size - 3)}px; opacity: 0.85;`
        );

        const buttonColor = _toCssColor(this._settings.buttonColor, '#FFFFFFFF');
        for (const button of [this._prevButton, this._playPauseButton, this._nextButton]) {
            button.set_style(
                `background-color: rgba(0,0,0,0.45); border-radius: 999px; padding: 8px; color: ${buttonColor};`
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
            this._textBox.hide();
            this._scrim.hide();
            this._playPauseButton.child.icon_name = 'media-playback-start-symbolic';
            this._showFallbackArt();
            return;
        }

        this._textBox.show();
        this._scrim.show();
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
                // Painted as a CSS background (not an St.Icon gicon) so
                // `background-size: cover` (set in _applyArtStyle()) can
                // crop the art to fill COVER_SIZE x COVER_SIZE exactly,
                // instead of St.Icon's aspect-preserving "contain" fit
                // that left visible gaps around non-square artwork.
                this._artIcon.set_style(
                    `border-radius: ${COVER_RADIUS}px; background-size: cover; background-position: center; ` +
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

    /** @private StDrawingArea::repaint handler - paints the rounded
     * orange-gradient placeholder used when the player reports no
     * artwork. Context is disposed before returning (GJS requirement). */
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
