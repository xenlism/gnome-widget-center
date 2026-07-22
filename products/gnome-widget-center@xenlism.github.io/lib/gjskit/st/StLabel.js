import St from 'gi://St';
import { StWidgetWrapper } from './StWidget.js';

export class StLabelWrapper extends StWidgetWrapper {
    constructor(params) {
        super(new St.Label(params));
    }

    text(text) {
        this._widget.set_text(text);
        return this;
    }
}
