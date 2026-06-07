import React from 'react';
import { ThemeProvider, createTheme, CssBaseline, AppBar, Toolbar, Typography, Button, Box, Chip } from "@mui/material";
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import { useZenithUser } from "@zuccadev-labs/zenith/react";
import { Key } from 'lucide-react';

import Dashboard from './pages/Dashboard';
import Chat from './pages/Chat';
import AuthPage from './pages/AuthPage';
import MediaRoom from './pages/MediaRoom';
import APIKeysPage from './pages/APIKeysPage';
import Web3Login from './pages/Web3Login';
import CloudForms from './pages/CloudForms';
import TriggersDemo from './pages/TriggersDemo';

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#6366f1' },
    secondary: { main: '#8b5cf6' },
    background: { default: '#0f172a', paper: '#1e293b' },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
  },
  shape: { borderRadius: 10 },
  components: {
    MuiButton: { styleOverrides: { root: { textTransform: 'none', fontWeight: 600 } } },
  },
});

function Navigation() {
  const { user, setUser } = useZenithUser();
  const handleLogout = async () => {
    const { ZenithUser } = await import('@zuccadev-labs/zenith');
    await ZenithUser.logOut();
    setUser(null);
  };

  return (
    <AppBar
      position="static"
      elevation={0}
      sx={{
        background: 'rgba(15,23,42,0.8)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(99,102,241,0.2)',
      }}
    >
      <Toolbar>
        <Typography
          variant="h6"
          component={Link}
          to="/"
          sx={{
            flexGrow: 1,
            textDecoration: 'none',
            color: 'inherit',
            fontWeight: 800,
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            letterSpacing: '-0.5px',
          }}
        >
          ⚡ Zenith
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Button color="inherit" component={Link} to="/" size="small">Dashboard</Button>
          {user ? (
            <>
              <Button color="inherit" component={Link} to="/chat" size="small">Live Chat</Button>
              <Button color="inherit" component={Link} to="/cloudforms" size="small">Cloud Forms</Button>
              <Button color="inherit" component={Link} to="/triggers" size="small">Triggers Demo</Button>
              <Button color="inherit" component={Link} to="/apikeys" size="small" startIcon={<Key size={14} />}>
                API Keys
              </Button>
              <Chip
                label={user.get("username")}
                size="small"
                sx={{ mx: 1, background: 'rgba(99,102,241,0.2)', color: '#a5b4fc', fontWeight: 600 }}
              />
              <Button
                variant="outlined"
                color="error"
                size="small"
                onClick={handleLogout}
                sx={{ borderRadius: 2 }}
              >
                Logout
              </Button>
            </>
          ) : (
            <>
              <Button
                id="nav-login-btn"
                variant="contained"
                component={Link}
                to="/auth"
                size="small"
                sx={{ borderRadius: 2, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', mr: 1 }}
              >
                Login
              </Button>
              <Button
                variant="outlined"
                component={Link}
                to="/web3"
                size="small"
                sx={{ borderRadius: 2, borderColor: '#8b5cf6', color: '#a5b4fc' }}
              >
                Web3 Login
              </Button>
            </>
          )}
        </Box>
      </Toolbar>
    </AppBar>
  );
}

function App() {
  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <Router>
        {/*
         * Shell layout — enterprise pattern:
         *   Root Box  : 100vh flex-column, overflow hidden (no body scroll)
         *   Navigation: flex-shrink:0 — takes only what it needs (~64px AppBar)
         *   Content   : flex:1 — fills ALL remaining height
         *
         * This gives every Route page an exact, stable container height.
         * Chat uses flex:1 on its root so sidebar flex layout works correctly.
         */}
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
          <Navigation />
          <Box sx={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/auth" element={<AuthPage />} />
              <Route path="/web3" element={<Web3Login />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="/cloudforms" element={<CloudForms />} />
              <Route path="/triggers" element={<TriggersDemo />} />
              <Route path="/apikeys" element={<APIKeysPage />} />
              <Route path="/media/video" element={<MediaRoom mode="hop_by_hop" />} />
              <Route path="/media/secure" element={<MediaRoom mode="strict_sframe" />} />
            </Routes>
          </Box>
        </Box>
      </Router>
    </ThemeProvider>
  );
}

export default App;
