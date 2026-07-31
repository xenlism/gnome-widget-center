import { StButtonWrapper } from './StButton.js';
import { StLabelWrapper } from './StLabel.js';
import { StBoxLayoutWrapper } from './StBoxLayout.js';

export const $ = {
    button: (params) => {
        const btn = new StButtonWrapper(params);
        return btn;
    },
    label: (params) => {
        const lbl = new StLabelWrapper(params);
        if (params?.text) lbl.text(params.text);
        return lbl;
    },
    box: (params) => {
        const box = new StBoxLayoutWrapper(params);
        return box;
    }
};
