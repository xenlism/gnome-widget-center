import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { SHADOW_DEFAULTS, BLUR_DEFAULTS, shadowBoxShadowCss, borderCss, toCssColor, parseFontDescription, resolveCornerRadius } from "../../lib/widgetVisualKit.js";

export default class NotificationStackWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._notifications = [];
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
        this._notifications.unshift({
            appName: source?.title ?? source?.name ?? "",
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
        // An empty stack is intentional: do not fill it with placeholder/demo cards.
        const items = this._notifications.slice(0, Math.max(1, maxCards));

        for (const item of items) this._actor.add_child(this._buildCard(item));
    }

    _buildCard(item) {
        const s = this._settings;
        const cornerRadius = resolveCornerRadius(s, 20);
        const bg = toCssColor(s.cardBgColor ?? "#3A3A3CC2", "#3A3A3CC2");

        const cardOuter = new St.Widget({
            style_class: "notification-stack-widget-card",
            style: `background-color: ${bg}; border-radius: ${cornerRadius}px;` + borderCss(s) + shadowBoxShadowCss(s)
        });

        const card = new St.BoxLayout({ vertical: false, style: "padding: 12px 14px; min-height: 64px;" });
        cardOuter.add_child(card);

        if (s.showAppIcon ?? true) {
            const icon = new St.Icon({
                gicon: item.gicon ?? null,
                icon_name: item.gicon ? null : "dialog-information-symbolic",
                icon_size: 30,
                style: "margin-right: 12px; margin-top: 1px;"
            });
            card.add_child(icon);
        }

        const textCol = new St.BoxLayout({ vertical: true, x_expand: true });

        const { family: titleFamily, size: titleSize } = parseFontDescription(s.titleFont ?? "Cantarell Bold 13", "Cantarell Bold", 13);
        const titleLabel = new St.Label({
            text: item.appName && item.appName !== item.title ? `${item.appName}` : item.title ?? "",
            style: `color: ${s.titleColor ?? "#FFFFFF"}; font-family: ${titleFamily}; font-size: ${titleSize}px; font-weight: bold;`
        });
        titleLabel.clutter_text.ellipsize = 3;
        textCol.add_child(titleLabel);

        if (item.appName && item.appName !== item.title && item.title) {
            const { family: titleFamily2, size: titleSize2 } = parseFontDescription(s.titleFont ?? "Cantarell Bold 13", "Cantarell Bold", 13);
            const subtitleLabel = new St.Label({
                text: item.title,
                style: `color: ${s.titleColor ?? "#FFFFFF"}; font-family: ${titleFamily2}; font-size: ${titleSize2}px;`
            });
            subtitleLabel.clutter_text.ellipsize = 3;
            textCol.add_child(subtitleLabel);
        }

        if (item.body) {
            const { family: bodyFamily, size: bodySize } = parseFontDescription(s.bodyFont ?? "Cantarell 12", "Cantarell", 12);
            const bodyLabel = new St.Label({
                text: item.body,
                style: `color: ${s.bodyColor ?? "#D1D1D6"}; font-family: ${bodyFamily}; font-size: ${bodySize}px;`
            });
            bodyLabel.clutter_text.line_wrap = true;
            bodyLabel.clutter_text.ellipsize = 3;
            textCol.add_child(bodyLabel);
        }

        card.add_child(textCol);
        return cardOuter;
    }
}
