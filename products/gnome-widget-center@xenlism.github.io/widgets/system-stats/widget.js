// widgets/system-stats/widget.js
//
// 2026-07-19: rewritten to read CPU/RAM/network through the new shared
// lib/systemMetricsApi.js (SystemMetricsService) instead of duplicating
// /proc parsing inline - the CPU/RAM math here used to be a private copy
// of exactly this logic; now this widget is just one caller of the
// shared implementation, same relationship widgets/media-player/widget.js
// has with lib/mediaApi.js's MprisMediaService. Also adds a NET section
// (combined rx/tx throughput) now that the shared API makes that a single
// extra method call instead of another few dozen lines of /proc/net/dev
// parsing to hand-roll.

import St from 'gi://St';
import GLib from 'gi://GLib';
import {SystemMetricsService} from '../../lib/systemMetricsApi.js';

const BAR_WIDTH_PX = 160;

export default class SystemStatsWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;

        // One instance per widget instance, per systemMetricsApi.js's own
        // doc comment - CPU%/network-throughput deltas are tracked on
        // THIS object, so a second system-stats widget (or any other
        // widget importing the same class) never interferes with this
        // one's samples.
        this._metrics = new SystemMetricsService();
    }

    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'stats-widget',
            vertical: true,
        });

        // CPU Section
        this._cpuBox = new St.BoxLayout({vertical: true, style_class: 'stats-item'});
        this._cpuLabel = new St.Label({text: 'CPU', style_class: 'stats-label'});
        this._cpuValue = new St.Label({text: '0%', style_class: 'stats-value'});
        this._cpuBarBg = new St.Widget({style_class: 'bar-background'});
        this._cpuBarFill = new St.Widget({style_class: 'bar-fill-cpu', x_expand: false});
        this._cpuBarBg.add_child(this._cpuBarFill);

        this._cpuBox.add_child(this._cpuLabel);
        this._cpuBox.add_child(this._cpuValue);
        this._cpuBox.add_child(this._cpuBarBg);

        // RAM Section
        this._ramBox = new St.BoxLayout({vertical: true, style_class: 'stats-item'});
        this._ramLabel = new St.Label({text: 'RAM', style_class: 'stats-label'});
        this._ramValue = new St.Label({text: '0%', style_class: 'stats-value'});
        this._ramBarBg = new St.Widget({style_class: 'bar-background'});
        this._ramBarFill = new St.Widget({style_class: 'bar-fill-ram', x_expand: false});
        this._ramBarBg.add_child(this._ramBarFill);

        this._ramBox.add_child(this._ramLabel);
        this._ramBox.add_child(this._ramValue);
        this._ramBox.add_child(this._ramBarBg);

        // NET Section — throughput has no natural 0-100% scale like
        // CPU/RAM do, so this is text-only (no bar), showing combined
        // rx/tx across every interface systemMetricsApi.js finds.
        this._netBox = new St.BoxLayout({vertical: true, style_class: 'stats-item'});
        this._netLabel = new St.Label({text: 'NET', style_class: 'stats-label'});
        this._netValue = new St.Label({text: '\u2193 0 B/s   \u2191 0 B/s', style_class: 'stats-value'});

        this._netBox.add_child(this._netLabel);
        this._netBox.add_child(this._netValue);

        this._actor.add_child(this._cpuBox);
        this._actor.add_child(this._ramBox);
        this._actor.add_child(this._netBox);

        return this._actor;
    }

    enable() {
        this._logger.info('system-stats enabled');
        this._updateStats();
        this._setupTimer();
    }

    disable() {
        this._logger.info('system-stats disabled');
        this._destroyTimer();
    }

    getDefaultSettings() {
        return {updateInterval: 2};
    }

    onSettingsChanged(settings) {
        this._logger.info('Settings changed, restarting timer...');
        this._destroyTimer();
        this._setupTimer();
    }

    _setupTimer() {
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._settings.updateInterval, () => {
            this._updateStats();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _destroyTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _updateStats() {
        const {cpu, memory, network} = this._metrics.sample();

        this._cpuValue.text = `${cpu.percent}%`;
        this._cpuBarFill.width = Math.max(1, (cpu.percent / 100) * BAR_WIDTH_PX);

        this._ramValue.text = `${memory.percent}%`;
        this._ramBarFill.width = Math.max(1, (memory.percent / 100) * BAR_WIDTH_PX);

        this._netValue.text =
            `\u2193 ${this._formatBytesPerSec(network.totalRxBytesPerSec)}   ` +
            `\u2191 ${this._formatBytesPerSec(network.totalTxBytesPerSec)}`;
    }

    /** @private formats a bytes/sec number as a short human string
     * (e.g. "125 KB/s", "3.4 MB/s") — binary (1024-based) units, matching
     * how most Linux system monitors display network throughput. */
    _formatBytesPerSec(bytesPerSec) {
        const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        let value = bytesPerSec;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }
        const formatted = unitIndex === 0 ? String(Math.round(value)) : value.toFixed(1);
        return `${formatted} ${units[unitIndex]}`;
    }
}
