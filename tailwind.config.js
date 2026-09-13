/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,html}'],
  theme: {
    extend: {
      colors: {
        ink: '#0A0E12', // app background
        panel: '#101820', // panel surfaces, one step up from ink
        panel2: '#161F29', // nested/inset surfaces
        line: '#20303A', // hairline borders and dividers
        text: '#E7EEF2', // primary text
        muted: '#7E93A0', // secondary/label text
        accent: '#39F0C0', // primary HUD teal -- tracking / nominal state
        accent2: '#2A8BFF', // secondary blue -- anchor points / info
        warn: '#FFB020', // amber -- pending/warning state
        danger: '#FF4D6D', // coral-red -- active alert state
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 24px -4px rgba(57, 240, 192, 0.35)',
      },
    },
  },
  plugins: [],
};
