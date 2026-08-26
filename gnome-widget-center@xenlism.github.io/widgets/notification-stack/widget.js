import St from "gi://St";

import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { SHADOW_DEFAULTS, BLUR_DEFAULTS, shadowBoxShadowCss, borderCss, toCssColor, parseFontDescription, resolveCornerRadius } from "../../lib/widgetVisualKit.js";
import { applyCardBlur } from "../../lib/cardLayers.js";

const _DEMO_NOTIFICATIONS = [ {
    appName: "Fitness",
    isTimeSensitive: false,
    title: "Move goal achieved",
    body: "You closed your Move ring - well done."
}, {
    appName: "Medications Reminder",
    isTimeSensitive: true,
    title: "Medications Reminder",
    body: "Time to log your medications"
} ];

export default class NotificationStackWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._notifications = [];
        this._usingDemoData = true;
        this._sourceAddedId = null;
        this._notificationIds = new Map();
        this._cardBox = null;
    }

    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: "notification-stack-widget-root",
            vertical: true,
            style: "background-color: transparent;"
        });
        this._render();
        return this._actor;
    }

    enable() {
        this._trackExistingSources();
        this._sourceAddedId = Main.messageTray.connect("source-added", (_tray, source) => this._trackSource(source));
    }

    disable() {
        if (this._sourceAddedId !== null) {
            Main.messageTray.disconnect(this._sourceAddedId);
            this._sourceAddedId = null;
        }
        for (const [ source, ids ] of this._notificationIds) {
            try {
                if (ids.notificationAdded !== null) source.disconnect(ids.notificationAdded);
                if (ids.destroy !== null) source.disconnect(ids.destroy);
            } catch (e) {
            }
        }
        this._notificationIds.clear();
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            ...BLUR_DEFAULTS,
            maxCards: 3,
            cardSpacing: 8,
            cardBgColor: "#3A3A3CC2",
            cornerRadius: 20,
            cornerRadiusEnabled: true,
            borderEnabled: false,
            borderColor: "#FFFFFF26",
            borderWidth: 1,
            showAppIcon: true,
            showCategoryLabel: true,
            categoryFont: "Cantarell Bold 10",
            categoryColor: "#FF9F0A",
            titleFont: "Cantarell Bold 13",
            titleColor: "#FFFFFF",
            bodyFont: "Cantarell 12",
            bodyColor: "#D1D1D6"
        };
    }

    onSettingsChanged() {
        this._render();
    }

    _trackExistingSources() {
        const sources = Main.messageTray.getSources ? Main.messageTray.getSources() : Main.messageTray._sources ?? [];
        for (const source of sources) this._trackSource(source);
    }

    _trackSource(source) {
        if (!source || this._notificationIds.has(source)) return;
        const notificationAdded = source.connect("notification-added", (_source, notification) => this._onNotificationAdded(source, notification));
        const destroy = source.connect("destroy", () => {
            this._notificationIds.delete(source);
        });
        this._notificationIds.set(source, { notificationAdded, destroy });
    }

    _onNotificationAdded(source, notification) {
        this._usingDemoData = false;
        this._notifications.unshift({
            appName: source?.title ?? source?.name ?? "",
            isTimeSensitive: !!notification?.urgency && notification.urgency >= 2,
            title: notification?.title ?? "",
            body: notification?.body ?? notification?.bannerBodyText ?? "",
            gicon: notification?.gicon ?? source?.icon ?? null
        });
        const maxCards = Number.isFinite(this._settings.maxCards) ? this._settings.maxCards : 3;
        this._notifications = this._notifications.slice(0, Math.max(1, maxCards));
        this._render();
    }

    _render() {
        if (!this._actor) return;
        this._actor.destroy_all_children();

        const spacing = Number.isFinite(this._settings.cardSpacing) ? this._settings.cardSpacing : 8;
        this._actor.set_style(`background-color: transparent; spacing: ${spacing}px;`);

        const maxCards = Number.isFinite(this._settings.maxCards) ? this._settings.maxCards : 3;
        const items = (this._usingDemoData ? _DEMO_NOTIFICATIONS : this._notifications).slice(0, Math.max(1, maxCards));

        for (const item of items) this._actor.add_child(this._buildCard(item));
    }

    _buildCard(item) {
        const s = this._settings;
        const cornerRadius = resolveCornerRadius(s, 20);
        const bg = toCssColor(s.cardBgColor ?? "#3A3A3CC2", "#3A3A3CC2");

        const cardOuter = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            style_class: "notification-stack-widget-card",
            style: `background-color: ${bg}; border-radius: ${cornerRadius}px;` + borderCss(s) + shadowBoxShadowCss(s)
        });
        const cardBlurInset = new St.Widget({
            x_expand: true,
            y_expand: true,
            style: `background-color: ${bg}; margin: ${cornerRadius + 2}px;`
        });
        applyCardBlur(cardBlurInset, s);
        cardOuter.add_child(cardBlurInset);

        const card = new St.BoxLayout({ vertical: false, style: "padding: 10px 12px;" });
        cardOuter.add_child(card);

        if (s.showAppIcon ?? true) {
            const icon = new St.Icon({
                gicon: item.gicon ?? null,
                icon_name: item.gicon ? null : "dialog-information-symbolic",
                icon_size: 28,
                style: "margin-right: 10px;"
            });
            card.add_child(icon);
        }

        const textCol = new St.BoxLayout({ vertical: true, x_expand: true });

        if ((s.showCategoryLabel ?? true) && item.isTimeSensitive) {
            const { family: catFamily, size: catSize } = parseFontDescription(s.categoryFont ?? "Cantarell Bold 10", "Cantarell Bold", 10);
            const catLabel = new St.Label({
                text: "TIME SENSITIVE",
                style: `color: ${s.categoryColor ?? "#FF9F0A"}; font-family: ${catFamily}; font-size: ${catSize}px; letter-spacing: 1px;`
            });
            textCol.add_child(catLabel);
        }

        const { family: titleFamily, size: titleSize } = parseFontDescription(s.titleFont ?? "Cantarell Bold 13", "Cantarell Bold", 13);
        const titleLabel = new St.Label({
            text: item.appName && item.appName !== item.title ? `${item.appName}` : item.title ?? "",
            style: `color: ${s.titleColor ?? "#FFFFFF"}; font-family: ${titleFamily}; font-size: ${titleSize}px; font-weight: bold;`
        });
        textCol.add_child(titleLabel);

        if (item.appName && item.appName !== item.title && item.title) {
            const { family: titleFamily2, size: titleSize2 } = parseFontDescription(s.titleFont ?? "Cantarell Bold 13", "Cantarell Bold", 13);
            const subtitleLabel = new St.Label({
                text: item.title,
                style: `color: ${s.titleColor ?? "#FFFFFF"}; font-family: ${titleFamily2}; font-size: ${titleSize2}px;`
            });
            textCol.add_child(subtitleLabel);
        }

        if (item.body) {
            const { family: bodyFamily, size: bodySize } = parseFontDescription(s.bodyFont ?? "Cantarell 12", "Cantarell", 12);
            const bodyLabel = new St.Label({
                text: item.body,
                style: `color: ${s.bodyColor ?? "#D1D1D6"}; font-family: ${bodyFamily}; font-size: ${bodySize}px;`
            });
            bodyLabel.clutter_text.line_wrap = true;
            textCol.add_child(bodyLabel);
        }

        card.add_child(textCol);
        return cardOuter;
    }
}
