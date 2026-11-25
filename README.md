# Circle Judge

Draw a circle and get it judged for roundness. Works with a mouse or trackpad on a laptop, and with a finger or Apple Pencil on an iPad.

There's no target circle and no fixed center. The center is found from your drawing **after** you lift:

1. **Resample.** The stroke is resampled at even spacing along its length, so drawing faster or slower in places doesn't skew the result.
2. **Locate the center.** The center is the point whose distance to every part of the stroke is as even as possible. This is a least-squares best-fit circle, the usual reference for measuring roundness. A Kåsa algebraic fit gives the starting guess, then a Levenberg–Marquardt solver refines the true geometric fit.
3. **Average distance.** The radius is the average distance from that center to the stroke. It's drawn as a dashed circle.
4. **Score.** `100 − 5 × (RMS deviation from the average radius, as % of the radius)`. A loop left open loses another 100 points per full turn of gap (about 3 points per 10°). Going a little past the start costs nothing. Strokes that go less than 270° or more than 1.5 laps around aren't scored.

The result card shows the average radius, the RMS wobble, the biggest miss (ringed on the drawing), widest minus narrowest radius, whether the loop closed, and the time taken. The stroke is colored from green (on the average radius) to red (8% or more off). If the shape is mostly oval, the card says which way it's stretched.

## iPad and Apple Pencil

- Uses Pointer Events with coalesced events where the browser supports them, so fast Apple Pencil input stays smooth.
- **Palm rejection:** once a Pencil stroke is seen, touches from your hand are ignored. Tap the *Pencil only* chip to allow finger drawing again.
- Scrolling, pinch-zoom, the text magnifier and Scribble are blocked on the drawing surface.
- Can be added to the Home Screen and runs full screen.

## Run it

It's a static site with no build step and no dependencies. Open `index.html` directly, or serve the folder:

```sh
npm start          # python3 -m http.server 8000, then open http://localhost:8000
```

To try it on an iPad, host the folder anywhere static, for example GitHub Pages (Settings → Pages → Deploy from a branch). Or serve it from your laptop and open `http://<laptop-ip>:8000` on the iPad over the same Wi-Fi.

## Tests

```sh
npm test           # unit tests for the fitting and scoring (Node 18+)
```

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup |
| `css/styles.css` | Styles, light and dark |
| `js/circle-fit.js` | Center location, average radius and scoring (no DOM; also runs in Node) |
| `js/app.js` | Drawing input, rendering, result card |
| `tests/circle-fit.test.js` | Unit tests |
