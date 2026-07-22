// products/extension/lib/systemMetricsApi.js
//
// Reusable system-metrics reader: CPU usage, RAM usage, per-interface
// network throughput, and the list of network devices. Pure GLib
// synchronous file reads only (`/proc/stat`, `/proc/meminfo`,
// `/proc/net/dev`) - no Gtk, safe to import from widget.js (Shell
// process). Extracted so any bundled widget that wants system stats -
// not just widgets/system-stats, which used to duplicate this logic
// inline - doesn't have to re-implement /proc parsing from scratch. Same
// reasoning, and same import convention, as lib/mediaApi.js's
// MprisMediaService for MPRIS.
//
// Scope note (see development/docs/WIDGET_API.md §8/§9's "reachable via
// relative import only" pattern - this file follows the exact same
// convention as mediaApi.js): only usable by widgets BUNDLED inside this
// extension (via `import {SystemMetricsService} from
// '../../lib/systemMetricsApi.js';`), not by third-party widgets under
// ~/.local/share/gnome-widget-center/widgets/ - they live in a different
// directory entirely and have no path back to this file. Not exposed on
// the public `api` object built in widgetLoader.js. If third-party
// widgets need this too, that's a deliberate `api.system` addition (and
// WIDGET_API.md needs rewriting alongside it) - don't wire it in silently
// as a side effect of some other change.
//
// No polling of its own, per the review-guidelines rule already
// documented in WIDGET_API.md §8 - every method below is a single
// synchronous snapshot read, meant to be called from the WIDGET's OWN
// `GLib.timeout_add` loop (same pattern widgets/system-stats/widget.js
// already used before this file existed). CPU% and network throughput
// both need a PREVIOUS sample to compute a delta - that's why this is a
// class you instantiate (one instance per widget instance) rather than a
// set of free functions: the previous-sample state lives on the
// instance, so it's naturally cleaned up along with the widget itself -
// there's nothing to release between calls (no timers, no signals, no
// held file descriptors), so unlike MprisMediaService there is no
// stop()/destroy() to call.

import GLib from 'gi://GLib';

const PROC_STAT_PATH = '/proc/stat';
const PROC_MEMINFO_PATH = '/proc/meminfo';
const PROC_NET_DEV_PATH = '/proc/net/dev';

/** @typedef {{percent: number}} CpuUsage */
/** @typedef {{totalKb: number, availableKb: number, usedKb: number, percent: number}} MemoryUsage */
/** @typedef {{name: string, rxBytesPerSec: number, txBytesPerSec: number, rxTotalBytes: number, txTotalBytes: number}} NetworkInterfaceUsage */
/** @typedef {{interfaces: NetworkInterfaceUsage[], totalRxBytesPerSec: number, totalTxBytesPerSec: number}} NetworkUsage */
/** @typedef {{name: string}} NetworkDevice */

export class SystemMetricsService {
    constructor() {
        /** @private previous `/proc/stat` combined-cores line, for the
         * CPU% delta in getCpuUsage(). null until the first call. */
        this._prevCpu = null; // {idle, total}

        /** @private previous `/proc/net/dev` sample + the monotonic
         * timestamp it was taken at, for the throughput deltas in
         * getNetworkUsage(). null until the first call. */
        this._prevNet = null; // {timestampUs, interfaces: Map<name, {rxBytes, txBytes}>}
    }

    /**
     * @method getCpuUsage
     * @description Overall CPU usage percent since the LAST call to this
     * method on THIS instance (first call always returns 0 - there's no
     * previous sample yet to diff against, same as the old system-stats
     * widget's own `_prevIdle`/`_prevTotal` fields did). Reads all cores
     * combined (`/proc/stat`'s first "cpu " line), not per-core.
     * @returns {CpuUsage}
     */
    getCpuUsage() {
        try {
            const [ok, contents] = GLib.file_get_contents(PROC_STAT_PATH);
            if (!ok)
                return {percent: 0};

            const firstLine = new TextDecoder().decode(contents).split('\n')[0];
            const fields = firstLine.trim().split(/\s+/).slice(1).map(Number);
            const idle = fields[3] ?? 0;
            const total = fields.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);

            let percent = 0;
            if (this._prevCpu) {
                const diffIdle = idle - this._prevCpu.idle;
                const diffTotal = total - this._prevCpu.total;
                if (diffTotal > 0)
                    percent = Math.max(0, Math.min(100, Math.round(100 * (1 - diffIdle / diffTotal))));
            }
            this._prevCpu = {idle, total};

            return {percent};
        } catch (e) {
            return {percent: 0};
        }
    }

    /**
     * @method getMemoryUsage
     * @description Point-in-time RAM usage - no delta involved, so unlike
     * getCpuUsage()/getNetworkUsage() this is safe to call on a
     * brand-new instance right away and get a meaningful number back.
     * `usedKb` is `totalKb - availableKb` using `MemAvailable` (falling
     * back to `MemFree` on very old kernels that lack it) rather than
     * `MemFree` alone - the same distinction tools like `htop`/`free -h`
     * make, since `MemFree` alone over-counts "used" by ignoring
     * reclaimable cache/buffers.
     * @returns {MemoryUsage}
     */
    getMemoryUsage() {
        try {
            const [ok, contents] = GLib.file_get_contents(PROC_MEMINFO_PATH);
            if (!ok)
                return {totalKb: 0, availableKb: 0, usedKb: 0, percent: 0};

            const values = {};
            for (const line of new TextDecoder().decode(contents).split('\n')) {
                const match = line.match(/^(\w+):\s+(\d+)/);
                if (match)
                    values[match[1]] = Number(match[2]);
            }

            const totalKb = values.MemTotal ?? 0;
            const availableKb = values.MemAvailable ?? values.MemFree ?? 0;
            const usedKb = Math.max(0, totalKb - availableKb);
            const percent = totalKb > 0 ? Math.round((usedKb / totalKb) * 100) : 0;

            return {totalKb, availableKb, usedKb, percent};
        } catch (e) {
            return {totalKb: 0, availableKb: 0, usedKb: 0, percent: 0};
        }
    }

    /**
     * @method listNetworkDevices
     * @description Every network interface the kernel currently knows
     * about, loopback (`lo`) included - callers that only want "real"
     * devices should filter it out themselves
     * (`devices.filter(d => d.name !== 'lo')`), since some headless/
     * container setups genuinely have nothing else. No delta/history
     * involved, so - like getMemoryUsage() - always safe to call, even
     * before any getNetworkUsage() call on the same instance.
     * @returns {NetworkDevice[]}
     */
    listNetworkDevices() {
        return this._readNetDev().map(({name}) => ({name}));
    }

    /**
     * @method getNetworkUsage
     * @description Per-interface AND combined rx/tx throughput (bytes per
     * second) since the LAST call to this method on THIS instance - like
     * getCpuUsage(), the first call always returns 0 for every interface
     * (nothing to diff against yet). Uses `GLib.get_monotonic_time()`
     * (not wall-clock) for the elapsed-time divisor, so a system clock
     * change between two samples can never produce a bogus/negative rate.
     * An interface that appears or disappears between two calls (e.g. a
     * USB adapter unplugged) is simply absent from whichever sample it's
     * missing from - never throws.
     * @returns {NetworkUsage}
     */
    getNetworkUsage() {
        const nowUs = GLib.get_monotonic_time();
        const current = this._readNetDev();

        const interfaces = current.map(({name, rxBytes, txBytes}) => {
            const prevEntry = this._prevNet?.interfaces.get(name);
            let rxBytesPerSec = 0;
            let txBytesPerSec = 0;

            if (prevEntry && this._prevNet) {
                const elapsedSec = (nowUs - this._prevNet.timestampUs) / 1e6;
                if (elapsedSec > 0) {
                    rxBytesPerSec = Math.max(0, Math.round((rxBytes - prevEntry.rxBytes) / elapsedSec));
                    txBytesPerSec = Math.max(0, Math.round((txBytes - prevEntry.txBytes) / elapsedSec));
                }
            }

            return {name, rxBytesPerSec, txBytesPerSec, rxTotalBytes: rxBytes, txTotalBytes: txBytes};
        });

        this._prevNet = {
            timestampUs: nowUs,
            interfaces: new Map(current.map(({name, rxBytes, txBytes}) => [name, {rxBytes, txBytes}])),
        };

        return {
            interfaces,
            totalRxBytesPerSec: interfaces.reduce((sum, i) => sum + i.rxBytesPerSec, 0),
            totalTxBytesPerSec: interfaces.reduce((sum, i) => sum + i.txBytesPerSec, 0),
        };
    }

    /**
     * @method sample
     * @description Convenience one-shot snapshot combining every metric
     * above - handy for a widget with a single timer that wants CPU, RAM,
     * network throughput, and the device list all at once rather than
     * calling each method separately every tick.
     * @returns {{cpu: CpuUsage, memory: MemoryUsage, network: NetworkUsage, devices: NetworkDevice[]}}
     */
    sample() {
        return {
            cpu: this.getCpuUsage(),
            memory: this.getMemoryUsage(),
            network: this.getNetworkUsage(),
            devices: this.listNetworkDevices(),
        };
    }

    /** @private parses `/proc/net/dev` into `{name, rxBytes, txBytes}[]`.
     * Format is 2 header lines followed by one line per interface, e.g.:
     *   "  eth0: 123 0 0 0 0 0 0 0 456 0 0 0 0 0 0 0"
     * where column 0 (after the name) is rx bytes and column 8 is tx
     * bytes (see `man 5 proc`, `/proc/net/dev`). Never throws - returns
     * `[]` on any read/parse failure so callers never have to guard this
     * themselves. */
    _readNetDev() {
        try {
            const [ok, contents] = GLib.file_get_contents(PROC_NET_DEV_PATH);
            if (!ok)
                return [];

            const lines = new TextDecoder().decode(contents).split('\n').slice(2);
            const result = [];
            for (const line of lines) {
                if (!line.includes(':'))
                    continue;

                const [namePart, dataPart] = line.split(':');
                const name = namePart.trim();
                const fields = dataPart.trim().split(/\s+/).map(Number);
                if (!name || fields.length < 9)
                    continue;

                result.push({name, rxBytes: fields[0], txBytes: fields[8]});
            }
            return result;
        } catch (e) {
            return [];
        }
    }
}
