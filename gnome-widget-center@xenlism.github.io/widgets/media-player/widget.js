// widgets/media-player/widget.js
//
// Task 06 — SDK example #2: a "Now Playing" widget that reads/controls
// whatever MPRIS2-compatible media player is currently running (Spotify,
// VLC, Rhythmbox, Firefox, ...) over the session DBus. This is the point
// of the second example widget in this pack: it proves the CURRENT
// WidgetAPI already supports a widget that talks to an external system
// service, with no new hooks added to the host — see
// development/docs/WIDGET_API.md §8 for the full pattern and the MUST rules this file
// follows (graceful degradation with no player running, signal-based
// updates only, no polling, full DBusProxy/signal cleanup in disable()).
//
// Update (2026-07-16): the actual DBusProxy/MPRIS plumbing now lives in
// products/extension/lib/mediaApi.js (MprisMediaService) so it isn't
// duplicated if a second media-related widget is ever added. This file
// only reaches it via a relative import because it's bundled inside this
// extension's own tree — that path does NOT change what §8 recommends to
// third-party widget developers, who can't reach lib/ from
// ~/.local/share/gnome-widget-center/widgets/ and should still talk to
// DBusProxy directly as documented there.
//
// Known limitation (documented, not a bug — see
// development/tasks/06-widget-sdk-example.md "Out of scope"): if more than one MPRIS
// player is running at once, this widget follows whichever bus name it
// noticed first (either already running at enable() time, or the first
// NameOwnerChanged after that) and ignores the rest until that one goes
// away. That behavior lives in MprisMediaService now, not here.

import St from 'gi://St';
import Gio from 'gi://Gio';
import {MprisMediaService} from '../../lib/mediaApi.js';

export default class MediaPlayerWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._media = new MprisMediaService(api.logger);
    }

    // Must never throw even before enable() has found a player - starts on
    // the same "No media playing" placeholder enable() would fall back to
    // anyway if DBus itself were unreachable.
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'media-player-widget-root',
            vertical: true,
        });

        this._art = new St.Icon({
            style_class: 'media-player-widget-art',
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 48,
        });

        this._titleLabel = new St.Label({style_class: 'media-player-widget-title'});
        this._artistLabel = new St.Label({style_class: 'media-player-widget-artist'});

        const infoBox = new St.BoxLayout({vertical: true, style_class: 'media-player-widget-info'});
        infoBox.add_child(this._titleLabel);
        infoBox.add_child(this._artistLabel);

        const topRow = new St.BoxLayout({style_class: 'media-player-widget-top'});
        topRow.add_child(this._art);
        topRow.add_child(infoBox);

        this._prevButton = this._makeButton('media-skip-backward-symbolic', () => this._media.previous());
        this._playPauseButton = this._makeButton('media-playback-start-symbolic', () => this._media.playPause());
        this._nextButton = this._makeButton('media-skip-forward-symbolic', () => this._media.next());

        this._controls = new St.BoxLayout({style_class: 'media-player-widget-controls'});
        this._controls.add_child(this._prevButton);
        this._controls.add_child(this._playPauseButton);
        this._controls.add_child(this._nextButton);

        this._actor.add_child(topRow);
        this._actor.add_child(this._controls);

        this._renderState(null);
        return this._actor;
    }

    enable() {
        this._media.start(state => this._renderState(state));
    }

    disable() {
        this._media.stop();
    }

    getDefaultSettings() {
        return {
            showArtwork: true,
            compactMode: false,
        };
    }

    /** @private */
    _makeButton(iconName, onClicked) {
        const button = new St.Button({
            style_class: 'media-player-widget-button',
            child: new St.Icon({icon_name: iconName, icon_size: 20}),
        });
        button.connect('clicked', onClicked);
        return button;
    }

    /**
     * @private
     * @param {import('../../lib/mediaApi.js').MediaState|null} state
     */
    _renderState(state) {
        if (!state) {
            this._titleLabel.set_text('No media playing');
            this._artistLabel.set_text('');
            this._art.icon_name = 'audio-x-generic-symbolic';
            this._controls.hide();
            return;
        }

        this._titleLabel.set_text(state.title);
        this._artistLabel.set_text(state.artist);
        this._controls.show();

        this._playPauseButton.child.icon_name = state.status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        const compact = this._settings.compactMode ?? false;
        this._prevButton.visible = !compact;
        this._nextButton.visible = !compact;

        const showArtwork = this._settings.showArtwork ?? true;
        if (showArtwork && state.artUrl.length > 0) {
            try {
                const file = state.artUrl.startsWith('file://')
                    ? Gio.File.new_for_uri(state.artUrl)
                    : Gio.File.new_for_path(state.artUrl);
                this._art.gicon = new Gio.FileIcon({file});
            } catch (e) {
                this._art.icon_name = 'audio-x-generic-symbolic';
            }
            this._art.show();
        } else if (showArtwork) {
            this._art.icon_name = 'audio-x-generic-symbolic';
            this._art.show();
        } else {
            this._art.hide();
        }
    }
}
