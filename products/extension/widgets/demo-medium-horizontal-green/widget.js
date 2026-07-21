import St from 'gi://St';

export default class DemoWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
    }

    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'demo-widget-demo-medium-horizontal-green',
            vertical: true,
            x_expand: false,
            y_expand: false
        });
        
        this._actor.set_size(336, 160);
        
        const label = new St.Label({
            text: "Green\n336x160",
            style_class: 'demo-widget-label'
        });
        
        this._actor.add_child(label);
        
        this._actor.style = `
            background-color: #2ecc71;
            border-radius: 16px;
            padding: 20px;
            color: white;
            font-size: 20px;
            font-weight: bold;
        `;
        
        return this._actor;
    }

    enable() {
        console.log('demo-medium-horizontal-green enabled');
    }

    disable() {
        console.log('demo-medium-horizontal-green disabled');
    }

    getDefaultSettings() {
        return {};
    }
}
