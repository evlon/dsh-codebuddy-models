/**
 * CodeBuddy / WorkBuddy desktop credential reading and auto-refresh.
 *
 * Re-implements (in TypeScript, no Python) the credential half of the
 * `codebuddy2openai` converter: locate the locally-logged-in desktop auth
 * file, parse it, refresh the access token against the CodeBuddy backend when
 * it nears expiry, and build the authenticated headers used by the adapter.
 *
 * The plugin never performs login or stores passwords — it only reads the
 * auth file that the installed desktop app keeps, and writes it back only to
 * persist a refreshed token (atomically), exactly like the desktop app itself.
 *
 * @module dsh-codebuddy-models/credentials
 */

import { promises as fs, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** CodeBuddy backend origin. */
export const BACKEND = 'https://copilot.tencent.com'
/** Fallback X-Domain header value when the auth record has no domain. */
export const DEFAULT_DOMAIN = 'www.codebuddy.cn'
/** Uvicorn/gateway-style user agent used for backend requests. */
export const USER_AGENT = 'dsh-codebuddy-models/0.1.6'

/** Headers needed to authenticate one backend request. */
export interface CodeBuddyAuthHeaders {
  authorization: string
  'x-user-id': string
  'x-enterprise-id': string
  'x-tenant-id': string
  'x-domain': string
  'user-agent': string
  'content-type': string
  accept: string
}

/** The subset of the desktop auth record the plugin needs. */
export interface AuthSession {
  /** Bearer access token. */
  accessToken: string
  /** Token used to obtain a fresh access token. */
  refreshToken: string
  /** Epoch-millisecond access-token expiry. */
  expiresAt: number
  /** Optional login domain, e.g. `www.codebuddy.cn`. */
  domain?: string
}

/** The subset of the desktop account record the plugin needs. */
export interface AccountSession {
  uid?: string
  enterpriseId?: string
  nickname?: string
}

/** The shape of the desktop `*.info` auth file. */
export interface CodeBuddyInfoFile {
  auth?: Partial<AuthSession> & { refreshToken?: string }
  account?: AccountSession
}

/**
 * Locate every candidate auth directory for the current platform.
 * @returns directories searched, in priority order.
 */
export function authDirs(): string[] {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    return [path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  const xdg = process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share')
  return [path.join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
}

/**
 * Find every `*.info` auth file across the candidate directories, newest first
 * (by filesystem mtime). A user with several CodeBuddy accounts keeps several
 * `.info` files; directory order is arbitrary, so picking the first entry used
 * to select a stale login. Sorting by mtime prefers the account most recently
 * touched by the desktop client — the one currently in use.
 * @returns absolute paths, newest first.
 */
export function findAuthFiles(): string[] {
  const found: Array<{ file: string; mtimeMs: number }> = []
  for (const dir of authDirs()) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.info')) continue
      const file = path.join(dir, entry)
      let mtimeMs = 0
      try {
        mtimeMs = statSync(file).mtimeMs
      } catch {
        mtimeMs = 0
      }
      found.push({ file, mtimeMs })
    }
  }
  // Stable newest-first order; ties fall back to path order (deterministic).
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file))
  return found.map((entry) => entry.file)
}

/**
 * Find the most recently modified `*.info` auth file.
 * @returns the absolute path of the file, or `undefined` when none is found.
 */
export function findAuthFile(): string | undefined {
  return findAuthFiles()[0]
}

/** Read a JSON file with tolerant BOM handling. */
async function readJson(file: string): Promise<unknown> {
  const raw = await fs.readFile(file, 'utf-8')
  return JSON.parse(raw.replace(/^\uFEFF/, ''))
}

/** Write a JSON object atomically (temp file + rename). */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
  await fs.rename(tmp, file)
}

/**
 * A thread/await-safe credential manager over one auth file.
 *
 * The file is cached by mtime; external writes (e.g. a desktop re-login) are
 * picked up on the next request. Token refresh is guarded by an in-process
 * lock so concurrent model calls never refresh or write twice.
 */
export class CredentialManager {
  private readonly path: string
  private tail: Promise<void> = Promise.resolve()
  private cached: CodeBuddyInfoFile | undefined
  private mtime = 0

  constructor(file: string) {
    this.path = file
  }

  /** True when no usable auth file could be read yet. */
  get file(): string {
    return this.path
  }

  private async loadIfStale(): Promise<void> {
    const stat = await fs.stat(this.path).catch(() => undefined)
    if (stat === undefined) {
      this.cached = undefined
      this.mtime = 0
      return
    }
    if (this.cached !== undefined && stat.mtimeMs === this.mtime) return
    this.cached = (await readJson(this.path)) as CodeBuddyInfoFile
    this.mtime = stat.mtimeMs
  }

  /** The currently-valid session, refreshing first if near expiry. */
  async session(forceRefresh = false): Promise<{ auth: AuthSession; account: AccountSession }> {
    return this.withLock(async () => {
      await this.loadIfStale()
      const info = this.cached
      if (info === undefined) throw new Error(`无法读取 CodeBuddy 登录文件：${this.path}`)
      const auth = info.auth ?? {}
      const account = info.account ?? {}
      if (typeof auth.accessToken !== 'string' || auth.accessToken.length === 0) {
        throw new Error('CodeBuddy 登录文件缺少 accessToken，请先在桌面端重新登录')
      }
      const expiresAt = typeof auth.expiresAt === 'number' ? auth.expiresAt : 0
      // refresh 60s before expiry, or unconditionally when forced (an auth
      // failure just proved the stored token is no longer accepted).
      const nearExpiry = Date.now() + 60_000 >= expiresAt
      if (nearExpiry || forceRefresh) {
        await this.refresh(info)
      }
      const freshAuth = info.auth ?? auth
      return {
        auth: {
          accessToken: freshAuth.accessToken as string,
          refreshToken: (freshAuth.refreshToken ?? '') as string,
          expiresAt: typeof freshAuth.expiresAt === 'number' ? freshAuth.expiresAt : 0,
          domain: freshAuth.domain,
        },
        account,
      }
    })
  }

  /**
   * Force a token refresh against the backend and persist the result, even when
   * the stored token has not yet reached its expiry window. Used as the fallback
   * when the backend rejected the current token with 401/403: the refreshToken
   * may still be valid even though the accessToken is not.
   * @returns true on success.
   * @throws when the refresh endpoint rejects the stored refreshToken.
   */
  async forceRefresh(): Promise<boolean> {
    await this.withLock(async () => {
      await this.loadIfStale()
      const info = this.cached
      if (info === undefined) throw new Error(`无法读取 CodeBuddy 登录文件：${this.path}`)
      const auth = info.auth ?? {}
      if (typeof auth.refreshToken !== 'string' || auth.refreshToken.length === 0) {
        throw new Error('CodeBuddy 登录文件缺少 refreshToken，请先在桌面端重新登录')
      }
      await this.refresh(info)
    })
    return true
  }

  /** Build the authenticated headers for one backend request. */
  async getHeaders(): Promise<CodeBuddyAuthHeaders> {
    const { auth, account } = await this.session()
    return {
      authorization: `Bearer ${auth.accessToken}`,
      'x-user-id': account.uid ?? '',
      'x-enterprise-id': account.enterpriseId ?? '',
      'x-tenant-id': account.enterpriseId ?? '',
      'x-domain': auth.domain ?? DEFAULT_DOMAIN,
      'user-agent': USER_AGENT,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    }
  }

  /** A short human-readable account summary for diagnostics. */
  async summary(): Promise<Record<string, unknown>> {
    try {
      const { auth, account } = await this.session()
      return {
        uid: account.uid,
        nickname: account.nickname,
        tokenExpiresAt: auth.expiresAt,
        tokenExpired: Date.now() >= auth.expiresAt,
      }
    } catch (error) {
      return { error: (error as Error).message }
    }
  }

  /** Serialize a single asynchronous critical section (refresh). */
  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Call the backend refresh endpoint and persist the new auth block. */
  private async refresh(info: CodeBuddyInfoFile): Promise<void> {
    const auth = info.auth ?? {}
    const account = info.account ?? {}
    const headers = this.buildHeadersFrom(auth, account)
    headers['x-refresh-token'] = auth.refreshToken ?? ''
    headers['x-auth-refresh-source'] = 'plugin'
    let response: Response
    try {
      response = await fetch(`${BACKEND}/v2/plugin/auth/token/refresh`, {
        method: 'POST',
        headers,
        body: '{}',
      })
    } catch (error) {
      throw new Error(`刷新 CodeBuddy token 网络失败：${(error as Error).message}`)
    }
    const data = (await response.json().catch(() => undefined)) as
      | { code?: number; data?: Partial<AuthSession>; msg?: string }
      | undefined
    if (data?.code !== 0 || data.data === undefined) {
      throw new Error(`刷新 CodeBuddy token 失败：${data?.msg ?? 'unknown'}`)
    }
    const next = data.data
    const merged: AuthSession = {
      accessToken: next.accessToken ?? auth.accessToken ?? '',
      refreshToken: next.refreshToken ?? auth.refreshToken ?? '',
      expiresAt: next.expiresAt ?? Date.now(),
      domain: next.domain ?? auth.domain,
    }
    if (merged.expiresAt <= Date.now() && merged.expiresAt > 0) {
      throw new Error('刷新 CodeBuddy token 返回了已过期 token')
    }
    info.auth = merged
    await writeJsonAtomic(this.path, info)
    this.cached = info
    this.mtime = (await fs.stat(this.path)).mtimeMs
  }

  private buildHeadersFrom(auth: Partial<AuthSession>, account: AccountSession): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${auth.accessToken ?? ''}`,
      'x-user-id': account.uid ?? '',
      'x-enterprise-id': account.enterpriseId ?? '',
      'x-tenant-id': account.enterpriseId ?? '',
      'x-domain': auth.domain ?? DEFAULT_DOMAIN,
      'user-agent': USER_AGENT,
    }
  }
}

/** Load the first available auth file into a manager, or return undefined. */
export function openCredentialManager(): CredentialManager | undefined {
  const file = findAuthFile()
  return file === undefined ? undefined : new CredentialManager(file)
}

/**
 * A credential resolver over the set of local CodeBuddy login files.
 *
 * It holds the current {@link CredentialManager} (newest `.info` first) and
 * exposes two operations the adapter drives:
 *
 * - {@link getHeaders} resolves the authenticated headers for the current file,
 *   lazily opening the newest candidate on first use.
 * - {@link invalidateCurrent} deletes the current (stale) `.info` file and
 *   falls through to the next candidate. A user with several CodeBuddy accounts
 *   keeps several `.info` files; when the backend rejects one with 401/403 the
 *   file is superseded, so removing it leaves only the currently-valid login.
 *   Returns true when a different candidate is now in play (the adapter should
 *   retry), false when none remain.
 *
 * This replaces the previous single-file singleton: instead of pinning one
 * arbitrary directory entry forever, the resolver re-scans after each
 * invalidation and always uses the newest surviving file.
 */
export class CredentialResolver {
  private manager: CredentialManager | undefined
  /**
   * Optional fixed candidate list (newest first). When omitted, candidates are
   * re-scanned from {@link findAuthFiles} on each open. Tests inject an explicit
   * list to avoid depending on the platform `%LOCALAPPDATA%` layout.
   */
  private readonly fixed: string[] | undefined

  constructor(fixedCandidates?: string[]) {
    this.fixed = fixedCandidates
  }

  /** The path of the credential currently in use, if any. */
  get currentFile(): string | undefined {
    return this.manager?.file
  }

  private candidates(): string[] {
    if (this.fixed === undefined) return findAuthFiles()
    // In fixed mode, drop entries that have since been deleted (e.g. by
    // invalidateCurrent) so the resolver advances to the next surviving file.
    return this.fixed.filter((file) => {
      try {
        statSync(file)
        return true
      } catch {
        return false
      }
    })
  }

  private openNext(): CredentialManager | undefined {
    const file = this.candidates()[0]
    this.manager = file === undefined ? undefined : new CredentialManager(file)
    return this.manager
  }

  /** Resolve headers for the current (or next newest) login file. */
  async getHeaders(): Promise<CodeBuddyAuthHeaders> {
    if (this.manager === undefined) this.openNext()
    if (this.manager === undefined) {
      throw new Error('dsh-codebuddy-models: 未找到 CodeBuddy 登录凭据。请在桌面端登录 CodeBuddy / WorkBuddy。')
    }
    return this.manager.getHeaders()
  }

  /** A short human-readable summary of the current credential, for diagnostics. */
  async summary(): Promise<Record<string, unknown>> {
    if (this.manager === undefined) this.openNext()
    return this.manager === undefined ? { error: 'no credential' } : this.manager.summary()
  }

  /**
   * Discard the current (stale) login file and switch to the next candidate.
   *
   * Deletes the `.info` file so it is not re-picked on later scans, then
   * re-opens the newest survivor. The next {@link getHeaders} therefore uses the
   * remaining (presumably valid) account.
   * @returns true when a different credential is now selected, false when none
   *   remain (the file is still deleted in that case).
   */
  async invalidateCurrent(): Promise<boolean> {
    const stale = this.manager?.file
    if (stale !== undefined) {
      try {
        await fs.unlink(stale)
      } catch (error) {
        // Deletion is best-effort; even if the file cannot be removed, fall
        // through to the next candidate by opening it directly.
        void error
      }
    }
    const before = stale
    this.openNext()
    const after = this.manager?.file
    return after !== undefined && after !== before
  }
}
