/**
 * Demo Auth Routes
 *
 * Device authorization flow for CLI→Browser→API key exchange.
 * Mounted before authMiddleware — all routes are public or session-authenticated.
 */

import { Router, Request, Response } from 'express';
import config from '../config';
import {
  createDeviceSession,
  getDeviceSession,
  signup,
  login,
  completeDeviceSession,
  validateSession,
  getUserBySession,
  deleteSession,
} from '../services/demo-auth';

const router = Router();

/**
 * POST /api/auth/device
 * CLI calls this to start the device flow.
 */
router.post('/device', async (_req: Request, res: Response) => {
  try {
    const session = await createDeviceSession(config.DEMO_API_URL);
    const verificationUrl = `${config.DEMO_DASHBOARD_URL}/auth/device?code=${session.userCode}`;

    res.json({
      deviceCode: session.deviceCode,
      userCode: session.userCode,
      verificationUrl,
      expiresIn: Math.floor((session.expiresAt - Date.now()) / 1000),
      interval: session.interval,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/poll?device_code=xxx
 * CLI polls this until status is "completed".
 */
router.get('/poll', async (req: Request, res: Response) => {
  const { device_code } = req.query;
  if (!device_code || typeof device_code !== 'string') {
    return res.status(400).json({ error: 'device_code is required' });
  }

  const session = await getDeviceSession(device_code);
  if (!session) {
    return res.json({ status: 'expired' });
  }

  if (session.status === 'completed') {
    return res.json({
      status: 'completed',
      apiKey: session.apiKey,
      projectName: session.projectName,
      apiUrl: session.apiUrl,
    });
  }

  res.json({ status: 'pending' });
});

/**
 * POST /api/auth/signup
 * Register: email + username + password → session token
 */
router.post('/signup', async (req: Request, res: Response) => {
  const { email, username, password } = req.body;

  if (!email || !username || !password) {
    return res.status(400).json({ error: 'email, username, and password are required' });
  }

  if (username.length < 3 || username.length > 30) {
    return res.status(400).json({ error: 'Username must be 3-30 characters' });
  }

  if (!/^[a-z0-9_-]+$/i.test(username)) {
    return res
      .status(400)
      .json({ error: 'Username can only contain letters, numbers, dashes, underscores' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const { user, token } = await signup(email, username, password);
    res.json({
      token,
      username: user.username,
      projectName: user.projectName,
      apiKey: user.apiKey,
    });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

/**
 * POST /api/auth/login
 * Login: email + password → session token
 */
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const { user, token } = await login(email, password);
    res.json({
      token,
      username: user.username,
      projectName: user.projectName,
      apiKey: user.apiKey,
    });
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});

/**
 * POST /api/auth/complete-device
 * Browser calls this after login/signup to link device session to user.
 * Requires session token + userCode.
 */
router.post('/complete-device', async (req: Request, res: Response) => {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const user = await getUserBySession(token);
  if (!user) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const { userCode } = req.body;
  if (!userCode) {
    return res.status(400).json({ error: 'userCode is required' });
  }

  const completed = await completeDeviceSession(userCode, user, config.DEMO_API_URL);
  if (!completed) {
    return res.status(404).json({ error: 'Device session not found or expired' });
  }

  res.json({ success: true, projectName: user.projectName });
});

/**
 * GET /api/auth/me
 * Get current user info from session token.
 */
router.get('/me', async (req: Request, res: Response) => {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const user = await getUserBySession(token);
  if (!user) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  res.json({
    username: user.username,
    email: user.email,
    projectName: user.projectName,
    apiKeyPrefix: user.apiKey.slice(0, 20) + '...',
    createdAt: user.createdAt,
  });
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', async (req: Request, res: Response) => {
  const token = extractToken(req);
  if (token) {
    await deleteSession(token);
  }
  res.json({ success: true });
});

function extractToken(req: Request): string | undefined {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
}

export default router;
