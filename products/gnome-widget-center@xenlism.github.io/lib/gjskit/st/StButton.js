import St from 'gi://St';
import { StWidgetWrapper } from './StWidget.js';

export class StButtonWrapper extends StWidgetWrapper {
    constructor(params) {
        super(new St.Button(params));
    }

    label(text) {
        this._widget.set_label(text);
        return this;
    }
}
