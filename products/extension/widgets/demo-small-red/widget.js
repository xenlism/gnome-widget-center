import St from 'gi://St';

export default class DemoWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
    }

    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'demo-widget-demo-small-red',
            vertical: true,
            x_expand: false,
            y_expand: false
        });
        
        this._actor.set_size(160, 160);
        
        const label = new St.Label({
            text: "Red\n160x160",
            style_class: 'demo-widget-label'
        });
        
        this._actor.add_child(label);
        
        this._actor.style = `
            background-color: #e74c3c;
            border-radius: 16px;
            padding: 20px;
            color: white;
            font-size: 20px;
            font-weight: bold;
        `;
        
        return this._actor;
    }

    enable() {
        console.log('demo-small-red enabled');
    }

    disable() {
        console.log('demo-small-red disabled');
    }

    getDefaultSettings() {
        return {};
    }
}
