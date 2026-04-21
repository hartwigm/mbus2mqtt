import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { getLogger } from '../util/logger';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = 'mbus_sid';

interface Session {
  createdAt: number;
  expiresAt: number;
  ip: string;
}

export class AuthManager {
  private password: string;
  private logPath: string;
  private sessions = new Map<string, Session>();
  private logWarned = false;

  constructor(password: string, logPath: string) {
    this.password = password;
    this.logPath = logPath;
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    try {
      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      getLogger().warn(`auth log dir not writable (${this.logPath}): ${err}`);
    }
  }

  getClientIp(req: http.IncomingMessage): string {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
    return req.socket.remoteAddress || '-';
  }

  parseCookie(req: http.IncomingMessage): string | null {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const [k, v] = part.trim().split('=');
      if (k === COOKIE_NAME) return v;
    }
    return null;
  }

  isAuthenticated(req: http.IncomingMessage): boolean {
    const sid = this.parseCookie(req);
    if (!sid) return false;
    const sess = this.sessions.get(sid);
    if (!sess) return false;
    if (Date.now() > sess.expiresAt) {
      this.sessions.delete(sid);
      return false;
    }
    return true;
  }

  // Constant-time compare to blunt timing attacks on the password.
  verifyPassword(attempt: string): boolean {
    const a = Buffer.from(attempt, 'utf8');
    const b = Buffer.from(this.password, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  createSession(ip: string): { sid: string; cookie: string } {
    const sid = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    this.sessions.set(sid, { createdAt: now, expiresAt: now + SESSION_TTL_MS, ip });
    this.pruneExpired();
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    const cookie = `${COOKIE_NAME}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
    return { sid, cookie };
  }

  destroySession(req: http.IncomingMessage): { cookie: string; sid: string | null } {
    const sid = this.parseCookie(req);
    if (sid) this.sessions.delete(sid);
    return {
      sid,
      cookie: `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    };
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [sid, sess] of this.sessions) {
      if (sess.expiresAt < now) this.sessions.delete(sid);
    }
  }

  logAttempt(ip: string, event: 'LOGIN_SUCCESS' | 'LOGIN_FAILURE' | 'LOGOUT', detail = ''): void {
    const line = `${new Date().toISOString()} ${ip.padEnd(39)} ${event}${detail ? ' ' + detail : ''}\n`;
    fs.appendFile(this.logPath, line, err => {
      if (err && !this.logWarned) {
        this.logWarned = true;
        getLogger().warn(`auth log append failed (${this.logPath}): ${err.message}`);
      }
    });
  }
}
