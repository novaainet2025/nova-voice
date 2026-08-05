import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/renderer/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f3f5ff',
          100: '#e5eaff',
          200: '#cdd7ff',
          300: '#acbcff',
          400: '#8da4ff',
          500: '#6d8bff',
          600: '#5b75e9',
          700: '#4b5fc6',
          800: '#3e4ea2',
          900: '#343f7f'
        },
        surface: {
          50: '#f8f9fa',
          100: '#f1f3f5',
          200: '#e9ecef',
          300: '#dee2e6',
          400: '#ced4da',
          500: '#adb5bd',
          600: '#868e96',
          700: '#495057',
          800: '#343a40',
          900: '#212529'
        }
      },
      animation: {
        'pulse-recording': 'pulse-recording 1.5s ease-in-out infinite',
        'waveform': 'waveform 0.5s ease-in-out infinite alternate'
      },
      keyframes: {
        'pulse-recording': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' }
        },
        'waveform': {
          '0%': { height: '4px' },
          '100%': { height: '24px' }
        }
      }
    }
  },
  plugins: []
}

export default config
