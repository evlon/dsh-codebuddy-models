/**
 * Pure helpers shared by the CodeBuddy client settings form. Kept free of React
 * so unit tests can exercise the model-catalog normalization and validation
 * without a DOM or the dsh module system.
 *
 * @module dsh-codebuddy-models/client-schema
 */

/** Field-shape the host Config exposes under `models`. */
export const MODEL_FIELDS = ['id', 'name', 'description', 'contextWindow', 'maxTokens']

/** Normalize a models value for the form (drop unknown keys, keep only objects). */
export function normalizeModels(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((m) => typeof m === 'object' && m !== null && !Array.isArray(m))
    .map((m) => {
      const out = {}
      for (const k of MODEL_FIELDS) if (m[k] !== undefined) out[k] = m[k]
      return out
    })
}

/** Validate a models array; returns the first error message or undefined. */
export function validateModels(models) {
  const seen = new Set()
  for (let i = 0; i < models.length; i++) {
    const m = models[i]
    const id = typeof m.id === 'string' ? m.id.trim() : ''
    if (id === '') return `第 ${i + 1} 个模型的 ID 不能为空。`
    if (seen.has(id)) return `模型 ID "${id}" 重复。`
    seen.add(id)
    if (m.name !== undefined && (typeof m.name !== 'string' || m.name.length === 0)) return `模型 "${id}" 的显示名称不能为空。`
    for (const cap of ['contextWindow', 'maxTokens']) {
      if (m[cap] !== undefined && (typeof m[cap] !== 'number' || !Number.isInteger(m[cap]) || m[cap] <= 0)) return `模型 "${id}" 的容量必须是正整数。`
    }
  }
  return undefined
}

/** Default form values (match host Config defaults). */
export const FORM_DEFAULTS = {
  baseURL: '',
  defaultContextWindow: 1000000,
  maxTokens: 64000,
  streamIdleTimeoutMs: 300000,
  models: [],
}

/** Merge a settings section into the form (undefined → defaults). */
export function mergeFormSection(section) {
  const base = Object.assign({}, FORM_DEFAULTS)
  if (section === undefined) return base
  for (const [k, v] of Object.entries(section)) {
    if (v === undefined || v === null) continue
    base[k] = v
  }
  return base
}
