import St from 'gi://St';

export default class DemoWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
    }

    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'demo-widget-demo-large-square-gray',
            vertical: true,
            x_expand: false,
            y_expand: false
        });
        
        this._actor.set_size(688, 688);
        
        const label = new St.Label({
            text: "Gray\n688x688",
            style_class: 'demo-widget-label'
        });
        
        this._actor.add_child(label);
        
        this._actor.style = `
            background-color: #7f8c8d;
            border-radius: 16px;
            padding: 20px;
            color: white;
            font-size: 20px;
            font-weight: bold;
        `;
        
        return this._actor;
    }

    enable() {
        console.log('demo-large-square-gray enabled');
    }

    disable() {
        console.log('demo-large-square-gray disabled');
    }

    getDefaultSettings() {
        return {};
    }
}
