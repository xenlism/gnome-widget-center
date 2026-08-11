import GLib from "gi://GLib";

const PROC_STAT_PATH = "/proc/stat";

const PROC_MEMINFO_PATH = "/proc/meminfo";

const PROC_NET_DEV_PATH = "/proc/net/dev";

export class SystemMetricsService {
    constructor() {
        this._prevCpu = null;
        this._prevNet = null;
    }
    getCpuUsage() {
        try {
            const [ok, contents] = GLib.file_get_contents(PROC_STAT_PATH);
            if (!ok) return {
                percent: 0
            };
            const firstLine = (new TextDecoder).decode(contents).split("\n")[0];
            const fields = firstLine.trim().split(/\s+/).slice(1).map(Number);
            const idle = fields[3] ?? 0;
            const total = fields.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
            let percent = 0;
            if (this._prevCpu) {
                const diffIdle = idle - this._prevCpu.idle;
                const diffTotal = total - this._prevCpu.total;
                if (diffTotal > 0) percent = Math.max(0, Math.min(100, Math.round(100 * (1 - diffIdle / diffTotal))));
            }
            this._prevCpu = {
                idle: idle,
                total: total
            };
            return {
                percent: percent
            };
        } catch (e) {
            return {
                percent: 0
            };
        }
    }
    getMemoryUsage() {
        try {
            const [ok, contents] = GLib.file_get_contents(PROC_MEMINFO_PATH);
            if (!ok) return {
                totalKb: 0,
                availableKb: 0,
                usedKb: 0,
                percent: 0
            };
            const values = {};
            for (const line of (new TextDecoder).decode(contents).split("\n")) {
                const match = line.match(/^(\w+):\s+(\d+)/);
                if (match) values[match[1]] = Number(match[2]);
            }
            const totalKb = values.MemTotal ?? 0;
            const availableKb = values.MemAvailable ?? values.MemFree ?? 0;
            const usedKb = Math.max(0, totalKb - availableKb);
            const percent = totalKb > 0 ? Math.round(usedKb / totalKb * 100) : 0;
            return {
                totalKb: totalKb,
                availableKb: availableKb,
                usedKb: usedKb,
                percent: percent
            };
        } catch (e) {
            return {
                totalKb: 0,
                availableKb: 0,
                usedKb: 0,
                percent: 0
            };
        }
    }
    listNetworkDevices() {
        return this._readNetDev().map(({name: name}) => ({
            name: name
        }));
    }
    getNetworkUsage() {
        const nowUs = GLib.get_monotonic_time();
        const current = this._readNetDev();
        const interfaces = current.map(({name: name, rxBytes: rxBytes, txBytes: txBytes}) => {
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
            return {
                name: name,
                rxBytesPerSec: rxBytesPerSec,
                txBytesPerSec: txBytesPerSec,
                rxTotalBytes: rxBytes,
                txTotalBytes: txBytes
            };
        });
        this._prevNet = {
            timestampUs: nowUs,
            interfaces: new Map(current.map(({name: name, rxBytes: rxBytes, txBytes: txBytes}) => [ name, {
                rxBytes: rxBytes,
                txBytes: txBytes
            } ]))
        };
        return {
            interfaces: interfaces,
            totalRxBytesPerSec: interfaces.reduce((sum, i) => sum + i.rxBytesPerSec, 0),
            totalTxBytesPerSec: interfaces.reduce((sum, i) => sum + i.txBytesPerSec, 0)
        };
    }
    sample() {
        return {
            cpu: this.getCpuUsage(),
            memory: this.getMemoryUsage(),
            network: this.getNetworkUsage(),
            devices: this.listNetworkDevices()
        };
    }
    _readNetDev() {
        try {
            const [ok, contents] = GLib.file_get_contents(PROC_NET_DEV_PATH);
            if (!ok) return [];
            const lines = (new TextDecoder).decode(contents).split("\n").slice(2);
            const result = [];
            for (const line of lines) {
                if (!line.includes(":")) continue;
                const [namePart, dataPart] = line.split(":");
                const name = namePart.trim();
                const fields = dataPart.trim().split(/\s+/).map(Number);
                if (!name || fields.length < 9) continue;
                result.push({
                    name: name,
                    rxBytes: fields[0],
                    txBytes: fields[8]
                });
            }
            return result;
        } catch (e) {
            return [];
        }
    }
}