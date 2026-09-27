# Muse Calm

A calm, friendly meditation companion for the **Muse 2** headband that runs entirely in your browser.
Connect over Bluetooth to see live brainwaves, heart rate and head motion, follow a calm meter tuned to your own
baseline, and settle into timed sessions with synthesized soundscapes (ocean, beach, rainforest, rain, binaural beats)
and birds that sing when you're calm.

**Try it: https://gordojr1.github.io/muse-calm/**

No sign-up, no server and no tracking: everything runs on your device, and past sessions are saved only in
your browser's local storage. Add `?demo` to the address to try it with a simulated headband:
https://gordojr1.github.io/muse-calm/?demo

## Browser support
Muse Calm uses Web Bluetooth.
- **Windows, macOS, Linux, ChromeOS, Android:** Chrome or Edge.
- **iPhone / iPad:** use the free **[Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)** browser.
  Safari and the other iOS browsers can't talk to Bluetooth devices. Tap once to turn on sound, and switch the
  ring/silent switch off if you hear nothing.

Switch the Muse on, but don't pair it in your system's Bluetooth settings. Then click **Connect Muse** in the app.

## Using it
1. **Fit check:** all four sensors need firm contact for 5 seconds before a session can start. Each sensor says what to adjust.
2. Pick a length and an optional interval bell, then start. The first 40 seconds record your personal baseline.
3. Birds sing while your calm score stays above the threshold. If a sensor loses contact, scoring pauses rather than counting against you.
4. At the end you get a summary, and the session is saved under **Past sessions**, with a detailed timeline you can explore.

On a phone the app uses bottom tabs (Session, Brain, Body, History). On a desktop everything fits on one screen.

**Customize the desktop layout:** click **Customize layout** in the top bar. Drag a tile by its title bar and resize it
from the bottom-right corner; tiles snap to a grid and push the others out of the way. Click **Done** to save the layout
in this browser, or **Reset layout** to go back to the default. A running session keeps going while you edit.

## Development
Plain HTML, CSS and JavaScript: no build step and no dependencies. Serve the folder with any static server,
for example `python -m http.server`, and open `http://localhost:8000/`. Web Bluetooth needs https or localhost.

Unit tests (Node.js):
```
node tests/unit.test.js && node tests/v2.test.js && node tests/review.test.js && node tests/v21.test.js && node tests/v24.test.js
```

The Muse protocol handling follows [urish/muse-js](https://github.com/urish/muse-js).
Muse Calm is not a medical device.
