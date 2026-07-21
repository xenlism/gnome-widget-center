import St from 'gi://St';

export default class MiniNotesWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
    }

    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'notes-widget',
            vertical: true
        });
        
        this._header = new St.Label({ text: "Notes", style_class: 'notes-header' });
        this._content = new St.Label({ style_class: 'notes-content' });
        this._content.clutter_text.line_wrap = true;
        this._content.clutter_text.line_wrap_mode = 1; // WORD_CHAR
        
        this._actor.add_child(this._header);
        this._actor.add_child(this._content);
        
        this._applyStyles();
        this._updateContent();
        
        return this._actor;
    }

    enable() {
        this._logger.info('mini-notes enabled');
    }

    disable() {
        this._logger.info('mini-notes disabled');
    }

    getDefaultSettings() {
        return {
            noteText: "- Buy groceries\n- Call mom\n- Finish project",
            backgroundColor: "#fff5b1"
        };
    }

    onSettingsChanged(settings) {
        this._logger.info('Notes updated');
        this._applyStyles();
        this._updateContent();
    }

    _applyStyles() {
        this._actor.style = `background-color: ${this._settings.backgroundColor};`;
    }

    _updateContent() {
        this._content.text = this._settings.noteText || "";
    }
}
