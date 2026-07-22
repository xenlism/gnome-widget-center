import St from 'gi://St';

export default class DemoWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
    }

    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'demo-widget-demo-large-square-black',
            vertical: true,
            x_expand: false,
            y_expand: false
        });
        
        this._actor.set_size(688, 688);
        
        const label = new St.Label({
            text: "Black\n688x688",
            style_class: 'demo-widget-label'
        });
        
        this._actor.add_child(label);
        
        this._actor.style = `
            background-color: #2c3e50;
            border-radius: 16px;
            padding: 20px;
            color: white;
            font-size: 20px;
            font-weight: bold;
        `;
        
        return this._actor;
    }

    enable() {
        console.log('demo-large-square-black enabled');
    }

    disable() {
        console.log('demo-large-square-black disabled');
    }

    getDefaultSettings() {
        return {};
    }
}
