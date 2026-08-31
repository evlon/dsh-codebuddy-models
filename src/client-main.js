/**
 * dsh-codebuddy-models browser half (client): registers a "CodeBuddy" entry in
 * the dsh web Settings sidebar (`settings.section`) with a model-management
 * form bound to the `llm-codebuddy` settings namespace.
 *
 * The harness's Models settings page cannot render our namespace (its
 * `layoutOf` only knows `llm-deepseek` / `llm-pi-ai` and shows a "edit
 * settings.yaml" hint for everything else), so this plugin ships its own
 * editor. It reads and writes the same `llm-codebuddy` namespace the host half
 * registers through `installSettingsSection`, so edits land in the same
 * document and take effect live (`applies: live`).
 *
 * Bundled by `scripts/build-client.mjs` into `lib/client.js` as a
 * `window.__ModuleLoader__.load({ id, factory })` self-contained module.
 * `react` is externalized (injected by the dsh module system). Pure
 * React.createElement, no JSX. Styles use `--dsw-alias-*` theme tokens.
 *
 * @module dsh-codebuddy-models/client
 */

import React from 'react'
import { FORM_DEFAULTS, mergeFormSection, normalizeModels, validateModels } from './client-schema.js'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'settingsScope', 'connection', 'locale']

/** Settings namespace (matches the host half's `settingsNamespace`). */
const NS = 'llm-codebuddy'

/**
 * Plugin version, stamped at build time by `scripts/build-client.mjs` from
 * package.json (esbuild `define`). The browser half cannot read package.json,
 * so the constant falls back to 'dev' when a build forgot to inject it.
 */
const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : 'dev'

const FIELD_STYLE = { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px', maxWidth: '560px' }
const LABEL_STYLE = { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const INPUT_STYLE = {
  padding: '6px 8px', borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)', fontSize: '13px', boxSizing: 'border-box',
}
const TEXTAREA_STYLE = Object.assign({}, INPUT_STYLE, { minHeight: '56px', resize: 'vertical' })
const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '8px' }
const HINT_STYLE = { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', margin: '2px 0 0' }

/** Bind the settings scope for a namespace; returns undefined until ready. */
function bindScope(ctx, namespace) {
  const settingsScope = ctx.get('settingsScope')
  if (settingsScope === undefined) return undefined
  try {
    return settingsScope.bind({ namespace })
  } catch {
    return undefined
  }
}

/** Read the section snapshot (value first, then base). */
function sectionOf(scope) {
  if (scope === undefined) return undefined
  const snap = scope.getSnapshot()
  return snap.value ?? snap.base ?? undefined
}

function TextField(props) {
  const { label, value, onChange, textarea, placeholder, hint, type } = props
  const el = textarea
    ? React.createElement('textarea', { style: TEXTAREA_STYLE, value: value ?? '', placeholder, onChange: (e) => onChange(e.target.value) })
    : React.createElement('input', { style: INPUT_STYLE, value: value ?? '', placeholder, type: type ?? 'text', onChange: (e) => onChange(e.target.value) })
  return React.createElement('div', { style: FIELD_STYLE },
    React.createElement('label', { style: LABEL_STYLE }, label),
    el,
    hint ? React.createElement('div', { style: HINT_STYLE }, hint) : null)
}

function NumberField(props) {
  const { label, value, onChange, placeholder, hint } = props
  return React.createElement('div', { style: FIELD_STYLE },
    React.createElement('label', { style: LABEL_STYLE }, label),
    React.createElement('input', {
      style: INPUT_STYLE, type: 'number', value: value ?? '', placeholder, min: 1, step: 1,
      onChange: (e) => {
        const raw = e.target.value
        if (raw === '') { onChange(undefined); return }
        const n = Number.parseInt(raw, 10)
        onChange(Number.isNaN(n) ? 0 : n)
      },
    }),
    hint ? React.createElement('div', { style: HINT_STYLE }, hint) : null)
}

/** Normalize a models array for the form (drop unknown keys). */

function SaveBar(props) {
  const { onSave, saved, error, onReset } = props
  return React.createElement('div', null,
    error !== undefined ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', marginBottom: '8px' } }, error) : null,
    React.createElement('div', { style: Object.assign({}, ROW_STYLE, { justifyContent: 'space-between', flexWrap: 'wrap' }) },
      React.createElement('div', { style: ROW_STYLE },
        React.createElement('button', {
          style: { padding: '6px 16px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)', cursor: 'pointer', fontSize: '13px' },
          onClick: onSave,
        }, '保存'),
        saved ? React.createElement('span', { style: { color: 'var(--dsw-alias-state-success-primary)', fontSize: '12px' } }, '✓ 已保存') : null),
      onReset !== undefined
        ? React.createElement('button', {
            style: { padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: '12px' },
            onClick: onReset,
          }, '恢复默认')
        : null))
}

/** Write one form patch to the settings scope, skipping undefined/null. */
async function applyScope(scope, patch) {
  if (scope === undefined) return
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue
    await scope.set(field, value)
  }
}

/** The main settings page: model management bound to `llm-codebuddy`. */
function CodeBuddySettingsPage(props) {
  const ctx = props.ctx
  const [scope] = React.useState(() => bindScope(ctx, NS))
  const [form, setForm] = React.useState(() => mergeFormSection(undefined))
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState(undefined)
  const [liveModels, setLiveModels] = React.useState(undefined) // undefined = loading
  const [liveFailures, setLiveFailures] = React.useState(undefined)

  React.useEffect(() => {
    const update = () => setForm(mergeFormSection(sectionOf(scope)))
    update()
    if (scope !== undefined) return scope.subscribe(update)
    return undefined
  }, [scope])

  // Live enterprise model directory: fetched on demand from the host's LLM
  // model API (which the adapter resolves from the enterprise builtin-models
  // directory). Nothing runtime-derived is persisted to settings.
  React.useEffect(() => {
    const conn = ctx.get('connection')
    if (conn === undefined || conn.api === undefined) return undefined
    let alive = true
    const load = () => {
      conn.api.llm.models({}).then((res) => {
        if (!alive) return
        if (res.result?.ok !== true) { setLiveModels([]); setLiveFailures('模型目录加载失败'); return }
        const groups = Array.isArray(res.result.value?.groups) ? res.result.value.groups : []
        const group = groups.find((g) => g.id === 'codebuddy')
        const list = (group !== undefined && Array.isArray(group.models)) ? group.models : []
        setLiveModels(list)
        setLiveFailures(undefined)
      }).catch(() => {
        if (alive) { setLiveModels([]); setLiveFailures('模型目录加载失败') }
      })
    }
    load()
    return () => { alive = false }
  }, [ctx])

  const set = (field) => (value) => {
    setForm((prev) => Object.assign({}, prev, { [field]: value }))
    setSaved(false)
    setError(undefined)
  }

  const save = () => {
    const models = normalizeModels(form.models)
    const failure = validateModels(models)
    if (failure !== undefined) { setError(failure); return }
    const patch = {
      baseURL: form.baseURL,
      defaultContextWindow: form.defaultContextWindow,
      maxTokens: form.maxTokens,
      streamIdleTimeoutMs: form.streamIdleTimeoutMs,
      models,
    }
    // An empty baseURL means "use the default endpoint"; do not persist an
    // empty string (an empty baseURL would yield a relative request URL).
    if (typeof form.baseURL === 'string' && form.baseURL.trim() === '') {
      try { scope.unset('baseURL') } catch { /* not set */ }
      delete patch.baseURL
    }
    applyScope(scope, patch).then(() => { setSaved(true); setError(undefined) }).catch(() => { setSaved(false); setError('保存失败，请重试。') })
  }

  const reset = () => {
    if (scope === undefined) return
    for (const field of ['baseURL', 'defaultContextWindow', 'maxTokens', 'streamIdleTimeoutMs', 'models']) {
      try { scope.unset(field) } catch { /* not set, ignore */ }
    }
    setForm(mergeFormSection(undefined))
    setSaved(false)
    setError(undefined)
  }

  const updateModel = (index, field, value) => {
    setForm((prev) => {
      const models = normalizeModels(prev.models)
      while (models.length <= index) models.push({})
      const next = Object.assign({}, models[index])
      if (value === undefined || value === null || value === '') delete next[field]
      else next[field] = value
      models[index] = next
      return Object.assign({}, prev, { models })
    })
    setSaved(false)
    setError(undefined)
  }
  const addModel = () => set('models')([...normalizeModels(form.models), {}])
  const removeModel = (index) => set('models')(normalizeModels(form.models).filter((_, i) => i !== index))

  const models = normalizeModels(form.models)
  const liveList = liveModels === undefined ? undefined : liveModels
  const liveUsable = Array.isArray(liveList) && liveList.length > 0

  return React.createElement('div', null,
    React.createElement('div', { style: Object.assign({}, ROW_STYLE, { marginBottom: '4px', gap: '10px' }) },
      React.createElement('h3', { style: { margin: '0', color: 'var(--dsw-alias-label-primary)' } }, 'CodeBuddy 模型'),
      React.createElement('span', {
        style: {
          fontSize: '11px',
          padding: '1px 7px',
          borderRadius: '999px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-secondary)',
          lineHeight: '16px',
          whiteSpace: 'nowrap',
        },
      }, 'v' + PLUGIN_VERSION)),
    React.createElement('p', { style: HINT_STYLE },
      '模型目录自动从你的 CodeBuddy 企业账号获取（仅企业账号可用，启动时获取、不保存）。此处可调整请求参数；保存后即时生效（live）。'),
    React.createElement(TextField, {
      label: 'API 地址（baseURL）', value: form.baseURL, onChange: set('baseURL'),
      placeholder: 'https://copilot.tencent.com',
      hint: '后端 origin，会拼接 /v2/chat/completions。',
    }),
    React.createElement(NumberField, { label: '默认上下文窗口（defaultContextWindow）', value: form.defaultContextWindow, onChange: set('defaultContextWindow'), placeholder: '1000000' }),
    React.createElement(NumberField, { label: '默认最大输出（maxTokens）', value: form.maxTokens, onChange: set('maxTokens'), placeholder: '64000' }),
    React.createElement(NumberField, { label: '流空闲超时（streamIdleTimeoutMs，毫秒）', value: form.streamIdleTimeoutMs, onChange: set('streamIdleTimeoutMs'), placeholder: '300000' }),

    React.createElement('div', { style: FIELD_STYLE },
      React.createElement('label', { style: LABEL_STYLE }, '企业模型目录（自动获取 · 只读）'),
      liveModels === undefined
        ? React.createElement('p', { style: HINT_STYLE }, '正在获取企业模型目录…')
        : liveUsable
          ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' } },
              liveList.map((m) => React.createElement(EnterpriseModelRow, { key: m.id, model: m })))
          : React.createElement('p', { style: HINT_STYLE },
              (liveFailures !== undefined ? liveFailures + '。' : '') +
              '暂未获取到企业模型列表（未登录 CodeBuddy 桌面端 / 非企业账号 / 网络异常）。模型选择器将只显示默认的 auto 模型。')),

    React.createElement('details', { style: { marginBottom: '12px' } },
      React.createElement('summary', { style: { cursor: 'pointer', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } },
        '高级：回退模型目录（models）'),
      React.createElement('p', { style: HINT_STYLE },
        '企业账号会自动获取模型列表，正常无需编辑这里；仅在自动获取不可用（未登录 / 个人账号 / 网络异常）时，模型选择器才使用这份手动目录。'),
      models.length === 0
        ? React.createElement('p', { style: HINT_STYLE }, '模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。')
        : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            models.map((m, i) => React.createElement(ModelRow, {
              key: i, model: m, index: i,
              onId: (v) => updateModel(i, 'id', v),
              onName: (v) => updateModel(i, 'name', v),
              onDescription: (v) => updateModel(i, 'description', v),
              onContext: (v) => updateModel(i, 'contextWindow', v === '' ? undefined : Number.parseInt(v, 10)),
              onMaxTokens: (v) => updateModel(i, 'maxTokens', v === '' ? undefined : Number.parseInt(v, 10)),
              onRemove: () => removeModel(i),
            }))),
      React.createElement('button', {
        type: 'button',
        style: { padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: '12px', marginTop: '4px' },
        onClick: addModel,
      }, '＋ 添加模型')),

    React.createElement(SaveBar, { onSave: save, saved, error, onReset: reset }))
}

/** One read-only enterprise model row (snapshot display). */
function EnterpriseModelRow(props) {
  const { model } = props
  const cell = { display: 'flex', flexDirection: 'column', gap: '2px' }
  const idStyle = { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' }
  const subStyle = { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }
  const caps = []
  if (typeof model.maxInputTokens === 'number') caps.push('输入 ' + formatNumber(model.maxInputTokens))
  if (typeof model.maxOutputTokens === 'number') caps.push('输出 ' + formatNumber(model.maxOutputTokens))
  const description = typeof model.descriptionZh === 'string' && model.descriptionZh !== ''
    ? model.descriptionZh
    : (typeof model.description === 'string' && model.description !== '' ? model.description : undefined)
  return React.createElement('div', {
    style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px', padding: '6px 8px' },
  },
    React.createElement('div', { style: ROW_STYLE },
      React.createElement('span', { style: idStyle }, model.id),
      model.status !== undefined && model.status !== 'enabled'
        ? React.createElement('span', { style: Object.assign({}, subStyle, { color: 'var(--dsw-alias-state-warn-primary)' }) }, model.status)
        : null),
    React.createElement('div', { style: cell },
      typeof model.name === 'string' && model.name !== '' && model.name !== model.id
        ? React.createElement('span', { style: subStyle }, model.name)
        : null,
      caps.length > 0 ? React.createElement('span', { style: subStyle }, caps.join(' · ')) : null,
      description !== undefined ? React.createElement('span', { style: subStyle }, description) : null))
}

/** Format a capacity with K/M suffixes for display. */
function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value)
  if (value >= 1000000 && value % 1000000 === 0) return String(value / 1000000) + 'M'
  if (value >= 1000 && value % 1000 === 0) return String(value / 1000) + 'K'
  return String(value)
}

/** One model row: id / name / description / contextWindow / maxTokens. */
function ModelRow(props) {
  const { model, index, onId, onName, onDescription, onContext, onMaxTokens, onRemove } = props
  const cell = { display: 'flex', flexDirection: 'column', gap: '4px' }
  const smallLabel = { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }
  return React.createElement('div', {
    style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' },
  },
    React.createElement('div', { style: ROW_STYLE },
      React.createElement('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', minWidth: '20px' } }, String(index + 1) + '.'),
      React.createElement('button', {
        type: 'button', title: '删除模型', 'aria-label': '删除模型 ' + String(index + 1),
        style: { marginLeft: 'auto', border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', padding: '2px 8px' },
        onClick: onRemove,
      }, '删除')),
    React.createElement('div', { style: cell },
      React.createElement('span', { style: smallLabel }, '模型 ID'),
      React.createElement('input', { style: INPUT_STYLE, value: typeof model.id === 'string' ? model.id : '', placeholder: 'deepseek-v4-flash', onChange: (e) => onId(e.target.value) })),
    React.createElement('div', { style: cell },
      React.createElement('span', { style: smallLabel }, '显示名称（可选）'),
      React.createElement('input', { style: INPUT_STYLE, value: typeof model.name === 'string' ? model.name : '', placeholder: '留空使用 ID', onChange: (e) => onName(e.target.value) })),
    React.createElement('div', { style: cell },
      React.createElement('span', { style: smallLabel }, '描述（可选）'),
      React.createElement('input', { style: INPUT_STYLE, value: typeof model.description === 'string' ? model.description : '', placeholder: '', onChange: (e) => onDescription(e.target.value) })),
    React.createElement('div', { style: Object.assign({}, ROW_STYLE, { gap: '12px' }) },
      React.createElement('div', { style: Object.assign({}, cell, { flex: 1 }) },
        React.createElement('span', { style: smallLabel }, '上下文窗口'),
        React.createElement('input', { style: INPUT_STYLE, type: 'number', value: typeof model.contextWindow === 'number' ? model.contextWindow : '', placeholder: '继承默认', onChange: (e) => onContext(e.target.value) })),
      React.createElement('div', { style: Object.assign({}, cell, { flex: 1 }) },
        React.createElement('span', { style: smallLabel }, '最大输出'),
        React.createElement('input', { style: INPUT_STYLE, type: 'number', value: typeof model.maxTokens === 'number' ? model.maxTokens : '', placeholder: '继承默认', onChange: (e) => onMaxTokens(e.target.value) }))))
}

/** Plugin entry: register the CodeBuddy settings section tab. */
export function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'codebuddy-models', order: 40, label: () => 'CodeBuddy 模型' },
    (props) => React.createElement(CodeBuddySettingsPage, Object.assign({ ctx }, props)),
  ))
}
