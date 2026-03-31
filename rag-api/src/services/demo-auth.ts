/**
 * Demo Auth Service
 *
 * Device authorization flow (RFC 8628) for CLI→Browser→API key exchange.
 * Users register with email+username+password. Each account gets 1 project + 1 API key.
 * All data stored in Redis with TTLs.
 */

import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { cacheService } from './cache';
import { generateKey } from '../middleware/auth';
import { logger } from '../utils/logger';

// --- Interfaces ---

export interface DeviceSession {
  deviceCode: string;
  userCode: string;
  status: 'pending' | 'completed' | 'expired';
  apiKey?: string;
  projectName?: string;
  apiUrl?: string;
  expiresAt: number;
  interval: number;
}

export interface DemoUser {
  id: string;
  email: string;
  username: string;
  passwordHash: string;
  projectName: string;
  apiKey: string;
  apiKeyId: string;
  createdAt: string;
}

export interface DemoSession {
  token: string;
  userId: string;
  username: string;
  expiresAt: number;
}

// --- Constants ---

const DEVICE_TTL = 900; // 15 minutes
const SESSION_TTL = 86400; // 24 hours
const USER_TTL = 2592000; // 30 days
const POLL_INTERVAL = 5; // seconds
const BCRYPT_ROUNDS = 10;

const KEY_PREFIX = {
  device: 'reka:demo:device:',
  user: 'reka:demo:user:',
  username: 'reka:demo:username:',
  session: 'reka:demo:session:',
};

// --- Device Flow ---

export async function createDeviceSession(apiUrl: string): Promise<DeviceSession> {
  const deviceCode = randomBytes(20).toString('hex');
  const userCode = `REKA-${randomBytes(2).toString('hex').toUpperCase()}`;

  const session: DeviceSession = {
    deviceCode,
    userCode,
    status: 'pending',
    apiUrl,
    expiresAt: Date.now() + DEVICE_TTL * 1000,
    interval: POLL_INTERVAL,
  };

  await cacheService.set(`${KEY_PREFIX.device}${deviceCode}`, session, DEVICE_TTL);
  // Reverse lookup: userCode → deviceCode
  await cacheService.set(`${KEY_PREFIX.device}code:${userCode}`, deviceCode, DEVICE_TTL);

  logger.info(`Device session created: ${userCode}`);
  return session;
}

export async function getDeviceSession(deviceCode: string): Promise<DeviceSession | null> {
  return cacheService.get<DeviceSession>(`${KEY_PREFIX.device}${deviceCode}`);
}

export async function completeDeviceSession(
  userCode: string,
  user: DemoUser,
  apiUrl: string
): Promise<boolean> {
  const deviceCode = await cacheService.get<string>(`${KEY_PREFIX.device}code:${userCode}`);
  if (!deviceCode) return false;

  const session = await cacheService.get<DeviceSession>(`${KEY_PREFIX.device}${deviceCode}`);
  if (!session || session.status !== 'pending') return false;

  session.status = 'completed';
  session.apiKey = user.apiKey;
  session.projectName = user.projectName;
  session.apiUrl = apiUrl;

  await cacheService.set(`${KEY_PREFIX.device}${deviceCode}`, session, DEVICE_TTL);
  logger.info(`Device session completed: ${userCode} → ${user.projectName}`);
  return true;
}

// --- User Management ---

export async function signup(
  email: string,
  username: string,
  password: string
): Promise<{ user: DemoUser; token: string }> {
  // Check existing
  const existingEmail = await cacheService.get<DemoUser>(`${KEY_PREFIX.user}${email}`);
  if (existingEmail) {
    throw new Error('Email already registered');
  }

  const existingUsername = await cacheService.get<string>(`${KEY_PREFIX.username}${username}`);
  if (existingUsername) {
    throw new Error('Username already taken');
  }

  // Create user
  const id = randomBytes(8).toString('hex');
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const projectName = `demo-${username}`;

  // Generate API key for the project
  const keyEntry = generateKey(projectName, `demo-${username}`);

  const user: DemoUser = {
    id,
    email,
    username,
    passwordHash,
    projectName,
    apiKey: keyEntry.key,
    apiKeyId: keyEntry.id,
    createdAt: new Date().toISOString(),
  };

  await cacheService.set(`${KEY_PREFIX.user}${email}`, user, USER_TTL);
  await cacheService.set(`${KEY_PREFIX.username}${username}`, email, USER_TTL);

  // Create session
  const token = await createSession(user);

  logger.info(`Demo user created: ${username} (${email}), project: ${projectName}`);
  return { user, token };
}

export async function login(
  email: string,
  password: string
): Promise<{ user: DemoUser; token: string }> {
  const user = await cacheService.get<DemoUser>(`${KEY_PREFIX.user}${email}`);
  if (!user) {
    throw new Error('Invalid email or password');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new Error('Invalid email or password');
  }

  const token = await createSession(user);

  logger.info(`Demo user login: ${user.username}`);
  return { user, token };
}

// --- Session Management ---

async function createSession(user: DemoUser): Promise<string> {
  const token = randomBytes(16).toString('hex');
  const session: DemoSession = {
    token,
    userId: user.id,
    username: user.username,
    expiresAt: Date.now() + SESSION_TTL * 1000,
  };

  await cacheService.set(`${KEY_PREFIX.session}${token}`, session, SESSION_TTL);
  return token;
}

export async function validateSession(token: string): Promise<DemoSession | null> {
  const session = await cacheService.get<DemoSession>(`${KEY_PREFIX.session}${token}`);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    await cacheService.del(`${KEY_PREFIX.session}${token}`);
    return null;
  }
  return session;
}

export async function deleteSession(token: string): Promise<void> {
  await cacheService.del(`${KEY_PREFIX.session}${token}`);
}

export async function getUserBySession(token: string): Promise<DemoUser | null> {
  const session = await validateSession(token);
  if (!session) return null;

  // Find user by scanning (username → email → user)
  const email = await cacheService.get<string>(`${KEY_PREFIX.username}${session.username}`);
  if (!email) return null;

  return cacheService.get<DemoUser>(`${KEY_PREFIX.user}${email}`);
}
