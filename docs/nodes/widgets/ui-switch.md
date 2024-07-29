---
description: Utilize the ui-switch widget in Node-RED Dashboard 2.0 to create interactive toggle controls for dynamic dashboard interactions.
props:
    Group: Defines which group of the UI Dashboard this widget will render in.
    Size: Controls the width of the button with respect to the parent group. Maximum value is the width of the group.
    Label: The text shown within the button.
    On Payload: The type & value to output in <code>msg.payload</code> when the switch is turned on.
    Off Payload: The type & value to output in <code>msg.payload</code> when the switch is turned off.
    On Icon: If provided, this <a href="https://pictogrammers.com/library/mdi/" target="_blank">Material Design icon</a> will replace the default switch when in "on" state. No need to include the <code>mdi</code> prefix.
    Off Icon: If provided, this <a href="https://pictogrammers.com/library/mdi/" target="_blank">Material Design icon</a> will replace the default switch when in "off" state. No need to include the <code>mdi</code> prefix.
    On Color: If provided with a icons, this colour is used for the icon when in "on" state
    Off Color: If provided with a icons, this colour is used for the icon when in "off" state
controls:
    enabled:
        example: true | false
        description: Allow control over whether or not the switch can be toggled via the UI.
dynamic:
    Class:
        payload: msg.class
        structure: ["String"]
---

<script setup>
</script>

# Toggle Switch `ui-switch`

Adds a toggle switch to the user interface.

## Properties

<PropsTable/>

## Dynamic Properties

<DynamicPropsTable/>

## Controls

<ControlsTable/>

## Example

![Example of a Toggle Switch](/images/node-examples/ui-switch.png "Example of a Toggle Switch"){data-zoomable}
*Example of rendered switches in a Dashboard.*
