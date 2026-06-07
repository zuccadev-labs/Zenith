import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material'
import { ZenithProvider } from '@zuccadev-labs/zenith/react'
import { Web3Provider } from './providers/Web3Provider.tsx'

// ─── Dev-only: suppress known browser-extension console noise ────────────────
//
// MetaMask (and similar wallet extensions) inject content scripts that emit
// EventEmitter MaxListeners warnings and ObjectMultiplex stream errors into
// the page's DevTools console. These originate in the extension sandbox —
// NOT in our application code — and cannot be fixed from our codebase.
//
// This proxy silences those specific patterns in development so they don't
// pollute logs and make real errors harder to spot. It is a NO-OP in
// production (import.meta.env.DEV === false → tree-shaken by Vite).
//
// Patterns suppressed:
//   - MaxListenersExceededWarning (EventEmitter from MetaMask streams)
//   - ObjectMultiplex orphaned/malformed (MetaMask stream multiplexer)
//   - Element Cloner content script loaded (third-party DOM extension)
//
// Reference: https://github.com/MetaMask/object-multiples/issues/14
if (import.meta.env.DEV) {
  const EXTENSION_NOISE_PATTERNS = [
    /MaxListenersExceededWarning/,
    /ObjectMultiplex/,
    /Element Cloner content script/,
    /orphaned data for stream/,
    /malformed chunk without name/,
  ];

  const isExtensionNoise = (...args: unknown[]): boolean =>
    args.some(arg =>
      typeof arg === 'string' &&
      EXTENSION_NOISE_PATTERNS.some(re => re.test(arg))
    );

  const _warn = console.warn.bind(console);
  const _error = console.error.bind(console);

  console.warn = (...args: unknown[]) => {
    if (!isExtensionNoise(...args)) _warn(...args);
  };
  console.error = (...args: unknown[]) => {
    if (!isExtensionNoise(...args)) _error(...args);
  };
}
// ─────────────────────────────────────────────────────────────────────────────


const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#90caf9',
    },
    background: {
      default: '#0a1929',
      paper: '#132f4c',
    },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: 'rgba(19, 47, 76, 0.4)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
        },
      },
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <ZenithProvider 
        appId={import.meta.env.VITE_ZENITH_APP_ID || "myAppId1"} 
        serverURL={`${window.location.origin}/parse`}
      >
        <Web3Provider>
          <App />
        </Web3Provider>
      </ZenithProvider>
    </ThemeProvider>
  </React.StrictMode>,
)
