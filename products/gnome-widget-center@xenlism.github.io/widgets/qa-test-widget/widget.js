// widgets/qa-test-widget/widget.js
//
// QA-only widget (see README.md in this folder) - deliberately minimal.
// Its only job is to exist as a real, discoverable widget with a
// themeable card, an on-screen readout of its OWN current settings (so a
// tester can visually confirm a .gwct import/.gwcbak restore actually
// changed something), and a metadata.json declaring both a satisfied and
// an unsatisfied system dependency (see checklist.md).

import St from 'gi://St';
import GLib from 'gi://GLib';

export default class QaTestWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
    }

    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'qa-test-widget-root',
            vertical: true,
        });

        this._labelText = new St.Label({style_class: 'qa-test-widget-label'});
        this._readout = new St.Label({style_class: 'qa-test-widget-readout'});

        this._actor.add_child(this._labelText);
        this._actor.add_child(this._readout);

        this._render();
        return this._actor;
    }

    enable() {
        const intervalSeconds = Math.max(1, this._settings.refreshSeconds ?? 5);
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, intervalSeconds, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    getDefaultSettings() {
        return {
            displayLabel: 'QA Test Widget',
            refreshSeconds: 5,
            apiKey: '',
            contactEmail: '',
            accountUsername: '',
            plainNote: 'nothing sensitive here',
            accounts: [],
            enableFeatureSwitch: true,
            enableFeatureCheckbox: false,
            layoutMode: 'compact',
            alignMode: 'start',
            spinValue: 3,
            sliderValue: 50,
            accentColor: '#3584e4',
            labelFont: 'Cantarell 11',
            widgetIcon: 'applications-graphics-symbolic',
            importFile: '',
            exportFolder: '',
            tags: ['example'],
        };
    }

    onSettingsChanged() {
        this._render();
    }

    /** @private Shows which non-secret fields currently hold a value, so
     * a tester can eyeball whether an import/restore actually took
     * effect. Deliberately never renders apiKey/contactEmail/
     * accountUsername/accounts[].accessToken - a QA widget for testing
     * secret redaction shouldn't itself put secrets on screen. */
    _render() {
        this._labelText.set_text(this._settings.displayLabel ?? 'QA Test Widget');
        const accountCount = Array.isArray(this._settings.accounts) ? this._settings.accounts.length : 0;
        this._readout.set_text(
            `plainNote: ${this._settings.plainNote ?? ''} | accounts: ${accountCount} | ` +
            `refresh: ${this._settings.refreshSeconds ?? 5}s`
        );
    }
}
