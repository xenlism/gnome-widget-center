import St from 'gi://St';

export default class DemoWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
    }

    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'demo-widget-demo-large-horizontal-pink',
            vertical: true,
            x_expand: false,
            y_expand: false
        });
        
        this._actor.set_size(688, 336);
        
        const label = new St.Label({
            text: "Pink\n688x336",
            style_class: 'demo-widget-label'
        });
        
        this._actor.add_child(label);
        
        this._actor.style = `
            background-color: #e91e63;
            border-radius: 16px;
            padding: 20px;
            color: white;
            font-size: 20px;
            font-weight: bold;
        `;
        
        return this._actor;
    }

    enable() {
        console.log('demo-large-horizontal-pink enabled');
    }

    disable() {
        console.log('demo-large-horizontal-pink disabled');
    }

    getDefaultSettings() {
        return {};
    }
}
