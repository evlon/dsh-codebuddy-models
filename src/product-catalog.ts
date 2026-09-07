/**
 * Local scanning of the official CodeBuddy client's `product.json` model
 * catalog.
 *
 * The official CodeBuddy extension (`tencent-cloud.coding-copilot`) ships its
 * model directory statically in `product.json` — the same list the official
 * model picker renders — plus product toggles for custom/enterprise models.
 * This module finds that manifest under the locally-installed clients
 * (VSCode / VSCode Insiders, plus CodeBuddy-family candidates) and maps its
 * `models` array onto the {@link CodeBuddyOfficialModel} vocabulary, filtering
 * out non-chat rows (completion-only `supportsExtra` models).
 *
 * Nothing here hits the network; reading fails fast (no official client, a
 * changed manifest, an unreadable file) and callers fall back to their
 * configured catalog.
 *
 * @module dsh-codebuddy-models/product-catalog
 */

import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CodeBuddyOfficialModel } from './adapter.js'

/** The manifest file every official client ships at its extension root. */
const PRODUCT_FILE = 'product.json'
/** Directory-name prefix of the official CodeBuddy extension. */
const EXTENSION_PREFIX = 'tencent-cloud.coding-copilot-'
/** `product.json` productName marker for the official CodeBuddy product. */
const PRODUCT_NAME = 'CodeBuddy'
/** Entries with `supportsExtra` are completion/auxiliary rows, not chat models. */
const NON_CHAT = 'supportsExtra'
/** Default catalog freshness; the official list only changes on client updates. */
export const OFFICIAL_CATALOG_TTL_MS = 10 * 60_000

/** Candidate extension roots, most common first; unreadable roots are skipped. */
export function candidateRoots(): string[] {
  const home = os.homedir()
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  return [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.codebuddy', 'extensions'),
    path.join(local, 'CodeBuddyExtension', 'extensions'),
  ]
}

/** Wire model fields this module maps; unknowns are ignored per row. */
interface ProductModelWire {
  id?: unknown
  name?: unknown
  maxInputTokens?: unknown
  maxOutputTokens?: unknown
  descriptionZh?: unknown
  supportsImages?: unknown
  supportsExtra?: unknown
}

/** A directory candidate whose name carries the official extension prefix. */
interface Candidate {
  dir: string
  /** Version tuple derived from the directory name, for newest-wins ordering. */
  version: number[]
}

/** Parse the version tuple from an extension directory name. */
function versionOf(name: string): number[] {
  const rest = name.slice(EXTENSION_PREFIX.length)
  return rest
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isInteger(value))
}

/** Compare two version tuples (missing trailing segments compare as 0). */
function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

/** A positive safe integer wire value, or undefined. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Parse a product manifest's `models` array into chat-capable official
 * entries. Completion-only rows (`supportsExtra`) and rows without usable
 * capacity metadata are dropped; rows that survive map id/name/capacities
 * verbatim.
 * @param product - the parsed product.json value, when the manifest is readable.
 * @returns the official catalog in product order, or `undefined` when the
 *   value is not an official CodeBuddy manifest with a models array.
 */
export function parseOfficialModels(product: unknown): CodeBuddyOfficialModel[] | undefined {
  if (typeof product !== 'object' || product === null || Array.isArray(product)) return undefined
  const wire = product as { productName?: unknown; models?: unknown }
  if (wire.productName !== PRODUCT_NAME || !Array.isArray(wire.models)) return undefined
  const models: CodeBuddyOfficialModel[] = []
  const seen = new Set<string>()
  for (const row of wire.models) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const entry = row as ProductModelWire
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    if (entry.supportsExtra === true) continue
    const maxInputTokens = positiveInteger(entry.maxInputTokens)
    const maxOutputTokens = positiveInteger(entry.maxOutputTokens)
    if (maxInputTokens === undefined || maxOutputTokens === undefined) continue
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    models.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
      maxInputTokens,
      maxOutputTokens,
      ...(typeof entry.descriptionZh === 'string' && entry.descriptionZh.length > 0 ? { descriptionZh: entry.descriptionZh } : {}),
      ...(entry.supportsImages === true ? { supportsImages: true } : {}),
    })
  }
  return models.length > 0 ? models : undefined
}

/** The scanned product.json path and its parsed model catalog. */
export interface OfficialCatalogResult {
  /** Absolute path of the product.json that produced the catalog. */
  sourcePath: string
  /** Chat-capable models, in product order. */
  models: readonly CodeBuddyOfficialModel[]
}

/**
 * Locate the newest official CodeBuddy extension directory under the given
 * roots and read its product.json.
 * @param roots - extension roots to scan; defaults to the machine candidates.
 * @returns the validated official catalog and its source path, or undefined.
 */
export async function discoverOfficialCatalog(
  roots: readonly string[] = candidateRoots(),
): Promise<OfficialCatalogResult | undefined> {
  const candidates: Candidate[] = []
  for (const root of roots) {
    let entries: Dirent[]
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(EXTENSION_PREFIX)) continue
      candidates.push({ dir: path.join(root, entry.name), version: versionOf(entry.name) })
    }
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version))
  for (const candidate of candidates) {
    const file = path.join(candidate.dir, PRODUCT_FILE)
    let raw: string
    try {
      raw = await readFile(file, 'utf-8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const models = parseOfficialModels(parsed)
    if (models === undefined) continue
    return { sourcePath: file, models }
  }
  return undefined
}

/**
 * A cached official-catalog reader mirroring the previous directory cache:
 * scans once per TTL window, keeps the last good result on later failures,
 * and never throws — callers fall back to their static catalog.
 */
export class OfficialCatalogReader {
  private cached: OfficialCatalogResult | undefined
  private cachedAt = 0

  constructor(
    private readonly roots: readonly string[] = candidateRoots(),
    private readonly ttlMs: number = OFFICIAL_CATALOG_TTL_MS,
  ) {}

  /** Reset the cache so the next read rescans the extension roots. */
  clear(): void {
    this.cached = undefined
    this.cachedAt = 0
  }

  /** Read the catalog, refreshing the cache when stale or absent. */
  async read(): Promise<OfficialCatalogResult | undefined> {
    const now = Date.now()
    if (this.cached !== undefined && now - this.cachedAt < this.ttlMs) {
      return this.cached
    }
    const discovered = await discoverOfficialCatalog(this.roots)
    if (discovered === undefined) return this.cached // keep last good on failure
    this.cached = discovered
    this.cachedAt = now
    return discovered
  }
}
