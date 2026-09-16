import { definePocketConfig } from "@pocketjs/framework/config";

// A paint-only loop on the same UI thread as glyph commits and rendering.
// It keeps moving during loading, pause, failure and idle; it is not progress.
export default definePocketConfig({
  theme: {
    keyframes: {
      "frame-motion": {
        from: { translateX: 0 },
        "50%": { translateX: 64 },
        to: { translateX: 0 },
      },
    },
    animation: {
      "frame-motion": {
        value: "frame-motion 2400ms linear both",
        loop: "2400ms",
      },
    },
  },
});
