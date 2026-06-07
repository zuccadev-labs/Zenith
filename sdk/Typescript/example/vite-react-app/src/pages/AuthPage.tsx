import React, { useState } from 'react';
import {
  Container, Typography, Box, TextField, Button, Paper, Alert,
  CircularProgress, Divider, Chip, InputAdornment, IconButton, LinearProgress
} from '@mui/material';
import { useZenithUser } from '@zuccadev-labs/zenith/react';
import { LogIn, UserPlus, Eye, EyeOff, CheckCircle, XCircle } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';

// ─── Password strength indicator ─────────────────────────────────────────────

interface PasswordRule { label: string; test: (pw: string) => boolean }

const PASSWORD_RULES: PasswordRule[] = [
  { label: "At least 12 characters", test: (pw) => pw.length >= 12 },
  { label: "Uppercase letter (A-Z)",  test: (pw) => /[A-Z]/.test(pw) },
  { label: "Number (0-9)",            test: (pw) => /[0-9]/.test(pw) },
  { label: "Symbol (!@#$...)",        test: (pw) => /[^a-zA-Z0-9]/.test(pw) },
];

function passwordStrength(pw: string): number {
  if (!pw) return 0;
  const passed = PASSWORD_RULES.filter(r => r.test(pw)).length;
  return Math.round((passed / PASSWORD_RULES.length) * 100);
}

function strengthColor(score: number): "error" | "warning" | "info" | "success" {
  if (score < 25) return "error";
  if (score < 50) return "warning";
  if (score < 100) return "info";
  return "success";
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateForm(
  isLogin: boolean,
  username: string,
  password: string,
  email: string
): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!username.trim()) {
    errors.username = "Username is required.";
  } else if (username.trim().length < 3) {
    errors.username = "Username must be at least 3 characters.";
  } else if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
    errors.username = "Username can only contain letters, numbers, and underscores.";
  }

  if (!password) {
    errors.password = "Password is required.";
  } else if (!isLogin) {
    // Only validate complexity on sign-up
    const failed = PASSWORD_RULES.filter(r => !r.test(password));
    if (failed.length > 0) {
      errors.password = `Password must meet all complexity requirements.`;
    }
  }

  if (!isLogin && email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "Enter a valid email address.";
  }

  return errors;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AuthPage() {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<{ code?: number; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const { setUser } = useZenithUser();
  const navigate = useNavigate();
  const location = useLocation();

  const pwStrength = !isLogin ? passwordStrength(password) : 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setApiError(null);

    // Client-side validation first
    const errors = validateForm(isLogin, username, password, email);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setLoading(true);
    try {
      const { ZenithUser } = await import('@zuccadev-labs/zenith');
      let u: any;
      if (isLogin) {
        u = await ZenithUser.logIn(username.trim(), password);
      } else {
        const newUser = new ZenithUser();
        newUser.username = username.trim();
        newUser.password = password;
        if (email.trim()) newUser.email = email.trim();
        u = await newUser.signUp();
      }
      setUser(u);
      const from = location.state?.from || "/";
      navigate(from);
    } catch (err: any) {
      if (err.code !== undefined) {
        setApiError({ code: err.code, message: err.message });
      } else {
        setApiError({ message: err.message || "Authentication failed. Please try again." });
      }
    } finally {
      setLoading(false);
    }
  };

  const switchMode = () => {
    setIsLogin(prev => !prev);
    setFieldErrors({});
    setApiError(null);
    setPassword("");
    setEmail("");
  };

  return (
    <Container maxWidth="xs" sx={{ mt: 8, mb: 4 }}>
      <Paper
        elevation={4}
        sx={{
          p: 4,
          borderRadius: 3,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          background: 'linear-gradient(145deg, #1a1a2e 0%, #16213e 100%)',
          border: '1px solid rgba(99,102,241,0.2)',
        }}
      >
        {/* Header */}
        <Box sx={{ mb: 1, textAlign: 'center' }}>
          <Typography variant="h4" fontWeight={800} sx={{ color: '#e2e8f0' }}>
            {isLogin ? 'Welcome Back' : 'Create Account'}
          </Typography>
          <Typography variant="body2" sx={{ color: 'rgba(226,232,240,0.5)', mt: 0.5 }}>
            {isLogin ? 'Sign in to continue to your dashboard' : 'Register a new developer account'}
          </Typography>
        </Box>

        <Divider sx={{ width: '100%', my: 2, borderColor: 'rgba(99,102,241,0.2)' }} />

        {/* API Error */}
        {apiError && (
          <Alert
            severity="error"
            sx={{ width: '100%', mb: 2, '& .MuiAlert-message': { fontFamily: 'monospace' } }}
          >
            {apiError.code !== undefined && (
              <Chip
                label={`Error ${apiError.code}`}
                size="small"
                color="error"
                variant="outlined"
                sx={{ mr: 1, fontWeight: 700, fontSize: '0.7rem' }}
              />
            )}
            {apiError.message}
          </Alert>
        )}

        {/* Form */}
        <Box component="form" onSubmit={handleSubmit} sx={{ width: '100%' }} noValidate>
          {/* Username */}
          <TextField
            id="auth-username"
            margin="normal"
            fullWidth
            label="Username"
            autoFocus
            autoComplete="username"
            value={username}
            onChange={e => { setUsername(e.target.value); setFieldErrors(prev => ({ ...prev, username: "" })); }}
            error={!!fieldErrors.username}
            helperText={fieldErrors.username}
            slotProps={{ inputLabel: { style: { color: 'rgba(226,232,240,0.6)' } } }}
          />

          {/* Email — only on signup */}
          {!isLogin && (
            <TextField
              id="auth-email"
              margin="normal"
              fullWidth
              label="Email (optional)"
              type="email"
              autoComplete="email"
              value={email}
              onChange={e => { setEmail(e.target.value); setFieldErrors(prev => ({ ...prev, email: "" })); }}
              error={!!fieldErrors.email}
              helperText={fieldErrors.email}
              slotProps={{ inputLabel: { style: { color: 'rgba(226,232,240,0.6)' } } }}
            />
          )}

          {/* Password */}
          <TextField
            id="auth-password"
            margin="normal"
            fullWidth
            label="Password"
            type={showPassword ? "text" : "password"}
            autoComplete={isLogin ? "current-password" : "new-password"}
            value={password}
            onChange={e => { setPassword(e.target.value); setFieldErrors(prev => ({ ...prev, password: "" })); }}
            error={!!fieldErrors.password}
            helperText={fieldErrors.password}
            slotProps={{
              inputLabel: { style: { color: 'rgba(226,232,240,0.6)' } },
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={() => setShowPassword(v => !v)}
                      edge="end"
                      size="small"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />

          {/* Password strength — only on signup */}
          {!isLogin && password.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <LinearProgress
                variant="determinate"
                value={pwStrength}
                color={strengthColor(pwStrength)}
                sx={{ borderRadius: 4, height: 6 }}
              />
              <Box sx={{ mt: 0.5, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {PASSWORD_RULES.map(rule => {
                  const ok = rule.test(password);
                  return (
                    <Box key={rule.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}>
                      {ok
                        ? <CheckCircle size={11} color="#4ade80" />
                        : <XCircle size={11} color="#f87171" />
                      }
                      <Typography variant="caption" sx={{ color: ok ? '#4ade80' : '#f87171', fontSize: '0.65rem' }}>
                        {rule.label}
                      </Typography>
                    </Box>
                  );
                })}
              </Box>
            </Box>
          )}

          {/* Submit */}
          <Button
            id="auth-submit-btn"
            type="submit"
            fullWidth
            variant="contained"
            disabled={loading}
            sx={{
              mt: 3, mb: 1.5, py: 1.5, borderRadius: 2,
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              fontWeight: 700, letterSpacing: 0.5,
              '&:hover': { background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' },
            }}
            startIcon={loading ? <CircularProgress size={18} color="inherit" /> : isLogin ? <LogIn size={18} /> : <UserPlus size={18} />}
          >
            {loading ? (isLogin ? "Signing In..." : "Creating Account...") : (isLogin ? "Sign In" : "Sign Up")}
          </Button>

          <Button id="auth-toggle-btn" fullWidth variant="text" onClick={switchMode} sx={{ color: 'rgba(226,232,240,0.5)', fontSize: '0.8rem' }}>
            {isLogin ? "Don't have an account? Sign Up" : "Already have an account? Sign In"}
          </Button>
        </Box>
      </Paper>
    </Container>
  );
}
