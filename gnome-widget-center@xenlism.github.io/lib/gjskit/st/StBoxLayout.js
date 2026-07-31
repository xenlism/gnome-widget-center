import St from 'gi://St';
import { StWidgetWrapper } from './StWidget.js';

export class StBoxLayoutWrapper extends StWidgetWrapper {
    constructor(params) {
        super(new St.BoxLayout(params));
    }

    append(widget) {
        // ภายในจะใช้ add_child ของ St แต่ Developer ใช้ append เหมือนกันหมด
        this._widget.add_child(widget.raw);
        return this;
    }
}
