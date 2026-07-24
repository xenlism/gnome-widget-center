/**
 * widgets/example-widget/settings.js
 *
 * Example: how a widget declares its configurable settings.
 * Every widget that wants settings exports a `defineSettings(gwc)`
 * function. The engine calls this once with a fresh, widget-scoped
 * `gwc` context and collects the resulting schema.
 */

'use strict';

function defineSettings(gwc) {
    gwc.settings
        .group('Appearance')
        .setFont('fontFamily', {
            label: 'Font',
            hint: 'Font used for the widget body text',
            default: 'Cantarell 11',
        })
        .setColor('accentColor', {
            label: 'Accent Color',
            default: '#3584e4',
        })
        .setIcon('headerIcon', {
            label: 'Header Icon',
            default: 'preferences-system-symbolic',
        })
        .option('layout', { 1: 'Compact', 2: 'Comfortable', 3: 'Custom' }, {
            label: 'Layout Density',
            default: 2,
        })
        .setRange('customSpacing', {
            label: 'Custom Spacing',
            hint: 'Only used when Layout is set to Custom',
            min: 0,
            max: 32,
            step: 1,
            default: 8,
        })
        .showIf('layout', '3')

        .group('Behavior')
        .setBoolean('showHeader', {
            label: 'Show Header',
            default: true,
        })
        .setDate('startDate', {
            label: 'Start Date',
            hint: 'Used to calculate elapsed days',
        })
        .setNumber('refreshInterval', {
            label: 'Refresh Interval (seconds)',
            min: 5,
            max: 3600,
            step: 5,
            default: 60,
        })
        .setText('customLabel', {
            label: 'Custom Label',
            placeholder: 'My Widget',
        })
        .setMultiOption('activeDays', {
            1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun',
        }, {
            label: 'Active Days',
            default: ['1', '2', '3', '4', '5'],
        })
        .setAction('resetCache', {
            label: 'Cache',
            hint: 'Clears cached data for this widget instance',
            buttonLabel: 'Clear Cache',
            destructive: true,
            onActivate: (store) => {
                store.setMany({ startDate: null });
            },
        });
}

var ExampleWidgetSettings = { defineSettings };
