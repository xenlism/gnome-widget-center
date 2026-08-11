import * as Main from "resource:///org/gnome/shell/ui/main.js";

export class MonitorLockManager {
    static clamp(monitorIndex, x, y, width, height) {
        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (!monitor) return {
            x: x,
            y: y
        };
        return {
            x: Math.max(0, Math.min(x, Math.max(monitor.width - width, 0))),
            y: Math.max(0, Math.min(y, Math.max(monitor.height - height, 0)))
        };
    }
}