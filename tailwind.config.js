/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#05070d',
          900: '#0a0e17',
          850: '#0f1420',
          800: '#141b2b',
          700: '#1d2740',
          600: '#2a3654',
        },
        seal: {
          DEFAULT: '#c8342c',
          bright: '#e8453a',
          dark: '#8f1f19',
        },
        jade: {
          DEFAULT: '#2fbf9f',
          dark: '#1c8a72',
        },
        gold: {
          DEFAULT: '#d8b26a',
        },
      },
      fontFamily: {
        song: ['"Noto Serif SC"', '"Songti SC"', 'STSong', 'SimSun', 'serif'],
      },
      boxShadow: {
        seal: '0 0 0 2px rgba(200,52,44,.55), 0 12px 40px -12px rgba(200,52,44,.6)',
      },
      keyframes: {
        stampin: {
          '0%': { transform: 'scale(2.4) rotate(-14deg)', opacity: '0' },
          '60%': { transform: 'scale(.94) rotate(-6deg)', opacity: '1' },
          '100%': { transform: 'scale(1) rotate(-6deg)', opacity: '1' },
        },
        pulseglow: {
          '0%,100%': { opacity: '.55' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        stampin: 'stampin .5s cubic-bezier(.2,1.3,.4,1) both',
        pulseglow: 'pulseglow 2.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
