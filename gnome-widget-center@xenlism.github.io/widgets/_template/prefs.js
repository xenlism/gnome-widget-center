import Adw from "gi://Adw";

export default class TemplateWidgetPrefs {
    constructor(settings) {
        this._settings = settings;
    }
    buildPrefsWidget() {
        const page = new Adw.PreferencesPage;
        const group = new Adw.PreferencesGroup({
            title: "Template Widget",
            description: "This template has no settings yet."
        });
        page.add(group);
        return page;
    }
}