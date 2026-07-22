import St from 'gi://St';
import GLib from 'gi://GLib';

export default class MacosClockWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
    }

    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'macos-clock-widget',
            vertical: true
        });
        
        this._timeLabel = new St.Label({ style_class: 'clock-time' });
        this._dateLabel = new St.Label({ style_class: 'clock-date' });
        
        this._actor.add_child(this._timeLabel);
        this._actor.add_child(this._dateLabel);
        
        return this._actor;
    }

    enable() {
        this._logger.log('macos-clock enabled');
        this._updateTime();
        this._setupTimer();
    }

    disable() {
        this._logger.log('macos-clock disabled');
        this._destroyTimer();
    }

    getDefaultSettings() {
        return {
            format24h: true,
            showSeconds: false,
            accentColor: '#ffffff'
        };
    }

    onSettingsChanged(settings) {
        this._logger.log('Settings changed, restarting timer...');
        this._destroyTimer();
        this._setupTimer();
        this._updateTime();
    }

    _setupTimer() {
        const interval = this._settings.showSeconds ? 1 : 60;
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._updateTime();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _destroyTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _updateTime() {
        const now = GLib.DateTime.new_now_local();
        const timeFormat = this._settings.format24h ? "%H:%M" : "%I:%M %p";
        const fullTimeFormat = this._settings.showSeconds ? `${timeFormat}:%S` : timeFormat;
        
        this._timeLabel.text = now.format(fullTimeFormat);
        this._dateLabel.text = now.format("%A, %d %B");
        
        this._timeLabel.style = `color: ${this._settings.accentColor};`;
    }
}
