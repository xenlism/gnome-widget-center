// products/extension/lib/monitorLockManager.js
//
// Task 13 — Monitor Lock. ป้องกันการลาก Widget ข้ามจอหรือหลุดขอบจอ
// คำนวณพิกัดแบบ Monitor-relative (เช่นเดียวกับ WidgetLayer) — index ที่รับเข้ามาคือ
// ตัวเดียวกับ monitorIndex ที่ใช้ทั้งระบบ (มาจาก MonitorWatcher.getMonitors(), ซึ่ง
// index ในนั้น *คือ* index ใน Main.layoutManager.monitors ตรงๆ — ดู monitorWatcher.js
// getMonitors() doc comment) จึงอ่าน Main.layoutManager.monitors[monitorIndex] ตรงนี้
// ได้อย่างปลอดภัยโดยไม่ต้อง inject MonitorWatcher เข้ามา

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class MonitorLockManager {
    /**
     * @method clamp
     * @description บังคับพิกัด x,y ให้อยู่ภายในขอบเขตของ Monitor ที่กำหนด โดยคำนึงถึง
     * ขนาดจริงของ widget (width/height) ด้วย ไม่ใช่แค่จุด origin — ต่างจาก
     * WidgetLayer._clampToMonitor() (ใช้ตอน addWidgetActor()/reconcileMonitors() ซึ่ง
     * clamp แค่จุดเดียวโดยไม่รู้ขนาด widget) ตรงนี้จงใจแยกกันเพราะ DragController/
     * EditModeDragController มีขนาด actor อยู่ในมืออยู่แล้วระหว่างลาก
     * @param {number} monitorIndex
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @returns {{x: number, y: number}}
     */
    static clamp(monitorIndex, x, y, width, height) {
        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (!monitor) return {x, y};

        return {
            x: Math.max(0, Math.min(x, Math.max(monitor.width - width, 0))),
            y: Math.max(0, Math.min(y, Math.max(monitor.height - height, 0))),
        };
    }
}
