/** NikoAPI settings: group descriptions, multiple keys, per-key model selection. */
window.__ModuleLoader__.load({
  id: 'dsh-nikoapi',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'nikoapi'
    const ENDPOINT = '/nikoapi/api'
    const zh = {
      nav: 'NikoAPI', title: 'NikoAPI', subtitle: '连接账号，按 Key 分组接入模型',
      tabKeys: 'Key 与分组', tabModels: '模型', tabCost: '费用联动', connected: '已连接', notConnected: '未连接',
      connection: '连接设置', reconnect: '更新凭据', tokenLabel: '管理访问令牌', tokenPlaceholder: '粘贴 NikoAPI 管理访问令牌',
      tokenHint: '需要 api_key:read 与 api_key:reveal；修改远端分组另需 api_key:write。凭据单向保存，不回显。',
      save: '保存', cancel: '取消', searchKeys: '搜索 Key 名称', refresh: '刷新', myKeys: '我的 Key', keyCount: '{count} 个 Key',
      hidden: '凭据已隐藏', unlimited: '不限 Key 额度', keyQuota: 'Key 剩余 {value} quota',
      keyCacheAt: '上次同步：{time}', keyCacheEmpty: '尚无 Key 缓存，点击刷新读取。',
      costAutomatic: '检测到 cost-meter 后自动联动；仅注册已确认且路由有效的模型。',
      costConflicts: '保留手工价格或其他计算器：{count}', costUnavailable: '等待有效费率或模型路由：{count}',
      waiting: '等待 cost-meter 或已确认模型', pending: '等待有效模型路由或费率', stale: '使用上次有效费率，刷新未完成',
      group: '分组', groupAuto: '自动分组', autoHint: '由服务端自动路由', inherit: '继承账号分组',
      searchGroups: '搜索分组…', noGroups: '没有匹配的分组', groupUnknown: '倍率未知', groupSelected: '当前分组',
      ratio: '{value}x', writeDenied: '缺少 api_key:write 权限，分组暂为只读。', groupSaved: '分组已保存，已自动刷新已确认模型费率。',
      groupHint: '选择分组会修改 NikoAPI 远端 Key；保存失败时保留原值。',
      selectedKeys: '已选 {count} 个 Key', preview: '确认', needKeys: '先到“Key 与分组”勾选 Key 并确认。',
      noKeys: '没有匹配的 Key', selectAll: '全选', clearAll: '取消全选',
      selectVisible: '全选当前结果', clearVisible: '取消当前结果', selectKey: '选择 Key：{name}',
      partialKeys: '{count} 个 Key 读取失败，请查看提示。', keyLimit: '最多选择 {count} 个 Key。',
      searchModels: '搜索模型或 Key 名称', modelCount: '{count} 个模型项', selectedModels: '已选 {count} 个模型项',
      noModels: '没有匹配的模型', loading: '加载中…', addModels: '配置模型列表', saveModels: '配置模型列表',
      confirmHint: '同名模型按 Key 分别接入；每个渠道使用对应 Key 与分组，不改变当前会话的默认模型。',
      priceTokens: '{currency} {input} / 百万输入 · {output} / 百万输出', priceCall: '{currency} {value} / 次',
      unknownPrice: '价格未知', dynamicPrice: 'NikoAPI 动态计价 · 按请求用量', zeroPrice: '按本地策略计价 · ¥0', reference: '参考价', priceUnknownReason: '缺少可准确转换的费率',
      registered: '已接入 {count} 个模型项', registrationFailed: '模型接入失败：{message}', saved: '已保存',
      unregistered: '尚未接入模型', registerAgain: '重新接入已保存模型', removeRegistration: '移除已接入模型',
      selected: '已选择', enabled: '已启用', disabled: '已禁用', expired: '已过期', exhausted: '已耗尽', unknown: '未知',
      failed: '操作失败：{message}', unavailable: 'NikoAPI 服务暂不可用，请刷新或重启 DSH 后重试。',
      costPlugin: '费用插件', costReady: '已安装 · 服务可用', costMissing: '未启用或服务不可用',
      costMissingHint: 'dsh-cost-meter 尚不可用，无法建立联动。', costUnsupported: '费用插件缺少所需接口。',
      interval: '费率刷新间隔（分钟）', intervalHint: '自动刷新已确认模型的费率；Key 列表由刷新按钮更新。',
      costScope: '计算器只接管已确认且路由有效的精确模型；同步时保留手工价格，配置变更最迟在下次费率同步时识别。', costStatus: '当前状态',
      unbound: '未绑定', bound: '已绑定', boundPartial: '已绑定（部分模型费率未知）', paused: '联动已暂停', syncError: '同步失败',
      refreshCost: '手动刷新', saveSettings: '保存设置',
      versionMismatch: '插件正在更新，请重启 DSH 并刷新页面后重试。',
    }
    const en = {
      nav: 'NikoAPI', title: 'NikoAPI', subtitle: 'Connect an account and add models by key group',
      tabKeys: 'Keys and groups', tabModels: 'Models', tabCost: 'Cost link', connected: 'Connected', notConnected: 'Not connected',
      connection: 'Connection', reconnect: 'Update credential', tokenLabel: 'Management token', tokenPlaceholder: 'Paste a NikoAPI management token',
      tokenHint: 'Requires api_key:read and api_key:reveal. Changing a remote group also requires api_key:write. Credentials are write-only.',
      save: 'Save', cancel: 'Cancel', searchKeys: 'Search key names', refresh: 'Refresh', myKeys: 'My keys', keyCount: '{count} keys',
      hidden: 'Credential hidden', unlimited: 'Unlimited key quota', keyQuota: 'Key remaining: {value} quota',
      keyCacheAt: 'Last synchronized: {time}', keyCacheEmpty: 'No Key cache yet. Refresh to load it.',
      costAutomatic: 'Automatically linked when cost-meter is detected; only confirmed models with verified routes are registered.',
      costConflicts: 'Manual prices or other calculators preserved: {count}', costUnavailable: 'Waiting for a valid rate or model route: {count}',
      waiting: 'Waiting for cost-meter or confirmed models', pending: 'Waiting for a valid model route or rate', stale: 'Using last valid rates; refresh incomplete',
      group: 'Group', groupAuto: 'Auto group', autoHint: 'Routed automatically by the server', inherit: 'Inherit account group',
      searchGroups: 'Search groups…', noGroups: 'No matching groups', groupUnknown: 'Ratio unknown', groupSelected: 'Current group',
      ratio: '{value}x', writeDenied: 'api_key:write is missing; groups are read-only.', groupSaved: 'Group saved. Confirmed model rates were refreshed automatically.',
      groupHint: 'Choosing a group changes the remote NikoAPI key. Failure keeps the previous value.',
      selectedKeys: '{count} keys selected', preview: 'Confirm', needKeys: 'Select keys in Keys and groups, then confirm.',
      noKeys: 'No matching keys', selectAll: 'Select all', clearAll: 'Clear all',
      selectVisible: 'Select visible results', clearVisible: 'Clear visible results', selectKey: 'Select key: {name}',
      partialKeys: '{count} keys could not be read. See the details.', keyLimit: 'Select up to {count} keys.',
      searchModels: 'Search models or key names', modelCount: '{count} model entries', selectedModels: '{count} model entries selected',
      noModels: 'No matching models', loading: 'Loading…', addModels: 'Configure model list', saveModels: 'Configure model list',
      confirmHint: 'Matching model names stay separate per key. Each route uses that key and group; the current session default stays unchanged.',
      priceTokens: '{currency} {input} / M input · {output} / M output', priceCall: '{currency} {value} / call',
      unknownPrice: 'Price unknown', dynamicPrice: 'NikoAPI dynamic billing · per-request usage', zeroPrice: 'Local policy rate · ¥0', reference: 'Reference', priceUnknownReason: 'No accurately convertible rate',
      registered: '{count} model entries connected', registrationFailed: 'Model connection failed: {message}', saved: 'Saved',
      unregistered: 'No models connected yet', registerAgain: 'Reconnect saved models', removeRegistration: 'Remove connected models',
      selected: 'Selected', enabled: 'Enabled', disabled: 'Disabled', expired: 'Expired', exhausted: 'Exhausted', unknown: 'Unknown',
      failed: 'Failed: {message}', unavailable: 'NikoAPI is unavailable. Refresh or restart DSH and try again.',
      costPlugin: 'Cost plugin', costReady: 'Installed · service available', costMissing: 'Not enabled or service unavailable',
      costMissingHint: 'dsh-cost-meter is unavailable; a link cannot be established.', costUnsupported: 'The cost plugin lacks the required API.',
      interval: 'Rate refresh interval (minutes)', intervalHint: 'Refreshes rates for confirmed models automatically. Use Refresh to update the Key directory.',
      costScope: 'Calculators cover confirmed models on exact routes; manual prices are preserved at sync checks and detected no later than the next rate sync.', costStatus: 'Current status',
      unbound: 'Not linked', bound: 'Linked', boundPartial: 'Linked (some rates are unknown)', paused: 'Link paused', syncError: 'Sync failed',
      refreshCost: 'Refresh now', saveSettings: 'Save settings',
      versionMismatch: 'Plugin update in progress. Restart DSH and refresh this page.',
    }
    let translate = (key, values = {}) => {
      const dictionary = document.documentElement.lang.toLowerCase().startsWith('zh') ? zh : en
      return (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, field) => String(values[field] ?? ''))
    }
    const t = (key, values) => translate(key, values)
    const CSS = `
.nk-root{container-type:inline-size;display:flex;flex-direction:column;gap:14px;min-width:0;max-width:100%;font-size:14px;color:var(--dsw-alias-label-primary)}
.nk-root *{box-sizing:border-box}.nk-root button,.nk-root input{font:inherit}.nk-root button{cursor:pointer}.nk-root button:disabled{cursor:not-allowed;opacity:.55}
.nk-root button:focus-visible,.nk-root input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nk-title{font-size:20px;font-weight:600;line-height:28px}.nk-muted{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.nk-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}.nk-strong{font-weight:600;overflow-wrap:anywhere;min-width:0}
.nk-tabs{display:flex;border-bottom:1px solid var(--dsw-alias-border-l1);gap:4px}.nk-tab{flex:1;min-width:0;min-height:44px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding:8px 4px;overflow-wrap:anywhere}.nk-tab[aria-selected=true]{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.nk-stack{display:flex;flex-direction:column;gap:12px;min-width:0}.nk-row{display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap}.nk-grow{flex:1 1 160px;min-width:0}.nk-card{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);min-width:0}
.nk-input{min-width:0;width:100%;min-height:44px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit}.nk-search{flex:1 1 160px}
.nk-btn{min-width:0;min-height:44px;padding:8px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;overflow-wrap:anywhere}.nk-btn:hover:not(:disabled),.nk-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}.nk-btn[data-primary=true]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-color);border-color:transparent}
.nk-foot{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px;min-width:0}.nk-foot .nk-btn{max-width:100%}
.nk-list{display:flex;flex-direction:column;gap:8px;min-width:0;max-height:440px;overflow:auto;padding:2px}.nk-key{display:flex;flex:0 0 auto;align-items:flex-start;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;min-width:0}.nk-key[data-selected=true]{border-color:var(--dsw-alias-brand-primary)}.nk-key-body{flex:1;min-width:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:8px 12px}.nk-key-body>.nk-row{grid-column:1/-1}.nk-key-body>.nk-note{align-self:center}.nk-key-body>.nk-picker{grid-column:2}
.nk-check{display:inline-flex;align-items:center;gap:6px;min-height:44px;min-width:44px;flex:none;cursor:pointer}.nk-check input{width:18px;height:18px;margin:0;accent-color:var(--dsw-alias-brand-primary)}.nk-key>.nk-check{justify-content:center;min-width:32px}.nk-check-text{overflow-wrap:anywhere;min-width:0}.nk-model{display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1);min-width:0}.nk-model .nk-check{align-items:flex-start;width:100%}.nk-model .nk-check input{margin-top:3px;flex:none}.nk-model-body{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.nk-badge{flex:none;border-radius:6px;padding:2px 7px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}.nk-ok{color:var(--dsw-alias-state-success-primary)}.nk-warn{color:var(--dsw-alias-state-warning-primary)}.nk-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;font-size:13px;line-height:1.6}.nk-success{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;font-size:13px}
.nk-picker{display:flex;flex-direction:column;gap:6px;min-width:0;width:100%}.nk-group-trigger{display:flex;align-items:center;gap:8px;justify-content:space-between;text-align:left;width:100%;border:1px solid var(--dsw-alias-border-l2)}.nk-group-label{min-width:0;overflow-wrap:anywhere;flex:1}.nk-group-panel{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);min-width:0}.nk-group-options{display:flex;flex-direction:column;max-height:250px;overflow-y:auto;min-width:0;overscroll-behavior:contain}.nk-group-option{display:flex;gap:10px;align-items:flex-start;width:100%;min-height:64px;padding:12px 10px;border:0;border-radius:7px;text-align:left;background:transparent;color:inherit}.nk-group-option:hover,.nk-group-option[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover)}.nk-group-copy{flex:1;min-width:0}.nk-group-name{display:block;font-weight:500;overflow-wrap:anywhere;line-height:22px}.nk-group-desc{display:block;font-size:13px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;white-space:pre-wrap;line-height:20px}.nk-ratio{display:inline-flex;align-items:center;justify-content:center;flex:none;align-self:flex-start;padding:0 7px;line-height:20px;border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);border-radius:999px;font-size:12px;white-space:nowrap}.nk-group-options .nk-ratio{margin-top:2px}
@container (max-width:480px){.nk-list{gap:10px}.nk-key{gap:8px;padding:10px}.nk-key-body{display:flex;flex-direction:column;gap:10px}.nk-group-trigger{min-height:44px}}
@container (max-width:360px){.nk-foot{align-items:stretch}.nk-foot>.nk-btn{width:100%}.nk-key{padding:8px;gap:8px}.nk-card{padding:10px}.nk-key .nk-grow{flex-basis:130px}.nk-key-body{gap:10px}}
`
    async function call(method, params = {}, signal) {
      let result
      try {
        const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }), credentials: 'same-origin', signal })
        result = await response.json()
      } catch (error) { if (error?.name === 'AbortError') throw error; throw new Error(t('unavailable')) }
      if (result?.ok === true) return result.data
      const error = new Error(result?.error?.message ?? t('unavailable'))
      error.code = result?.error?.code
      throw error
    }
    const badge = text => h('span', { className: 'nk-badge' }, text)
    const btn = (text, props = {}) => h('button', { type: 'button', className: 'nk-btn', ...props }, text)
    const pairId = (keyId, modelId) => JSON.stringify([keyId, modelId])
    const isSelectable = key => key.status === 'enabled'
    const groupTitle = (id, groups) => id === 'auto' ? t('groupAuto') : groups.find(group => group.id === id)?.id ?? (id || t('inherit'))
    const priceText = price => price?.kind === 'perMillion'
      ? `${price.reference ? `${t('reference')} · ` : ''}${t('priceTokens', { currency: price.currency, input: price.input, output: price.output })}`
      : price?.kind === 'perCall' ? `${price.reference ? `${t('reference')} · ` : ''}${t('priceCall', { currency: price.currency, value: price.perCall })}`
        : price?.kind === 'nikoExpression' ? `${price.reference ? `${t('reference')} · ` : ''}${t('dynamicPrice')}`
          : price?.kind === 'nikoZero' ? t('zeroPrice') : t('unknownPrice')

    function SelectCheckbox({ checked, mixed = false, children, ...props }) {
      const ref = React.useRef(null)
      React.useEffect(() => { if (ref.current) ref.current.indeterminate = mixed }, [mixed])
      return h('label', { className: 'nk-check' }, h('input', { ...props, ref, type: 'checkbox', checked, 'aria-checked': mixed ? 'mixed' : checked }), children ? h('span', { className: 'nk-check-text' }, children) : null)
    }
    function GroupPicker({ value, groups, disabled, onChange, keyName }) {
      const [open, setOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const root = React.useRef(null)
      const search = React.useRef(null)
      const trigger = React.useRef(null)
      const listId = React.useId()
      const options = [
        { id: 'auto', name: t('groupAuto'), desc: '', ratio: null, title: t('groupAuto') },
        ...groups.filter(group => group.id !== 'auto').map(group => ({ ...group, title: group.id, auto: false })),
      ]
      const visible = options.filter(group => `${group.title ?? group.name}\n${group.name}\n${group.desc}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      const current = options.find(group => group.id === value)
      React.useEffect(() => {
        if (!open) return
        search.current?.focus()
        const outside = event => { if (!root.current?.contains(event.target)) setOpen(false) }
        document.addEventListener('pointerdown', outside)
        return () => document.removeEventListener('pointerdown', outside)
      }, [open])
      const close = () => { setOpen(false); trigger.current?.focus() }
      const choose = group => { close(); if (group.id !== value) void onChange(group.id) }
      return h('div', { className: 'nk-picker', ref: root, onBlur: event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false) }, onKeyDown: event => {
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!open) { setOpen(true); return }
          const options = [...root.current.querySelectorAll('[role="option"]')]
          const index = options.indexOf(document.activeElement)
          const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
          options[next]?.focus()
        }
      } },
        h('button', {
          type: 'button', ref: trigger, className: 'nk-btn nk-group-trigger', disabled,
          'aria-label': `${t('group')} · ${keyName}`, 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-controls': listId,
          onClick: () => { setOpen(previous => !previous); setQuery('') },
        },
          h('span', { className: 'nk-group-label' }, `${t('group')}：${current?.title ?? (value === 'auto' ? t('groupAuto') : value || t('inherit'))}`),
          current?.ratio !== null && current?.ratio !== undefined ? h('span', { className: 'nk-ratio' }, t('ratio', { value: current.ratio })) : null,
          h('span', { 'aria-hidden': true }, open ? '⌃' : '⌄')),
        open ? h('div', { className: 'nk-group-panel' },
          h('input', { ref: search, className: 'nk-input', type: 'search', value: query, placeholder: t('searchGroups'), 'aria-label': t('searchGroups'), onChange: event => setQuery(event.target.value) }),
          h('div', { id: listId, role: 'listbox', 'aria-label': t('group'), className: 'nk-group-options' },
            visible.length === 0
              ? h('div', { className: 'nk-muted', role: 'status' }, t('noGroups'))
              : visible.map(group => h('button', {
                key: group.id, type: 'button', role: 'option', 'aria-selected': group.id === value,
                className: 'nk-group-option', onClick: () => choose(group),
              },
                h('span', { className: 'nk-group-copy' },
                  h('span', { className: 'nk-group-name' }, group.title),
                  group.desc ? h('span', { className: 'nk-group-desc' }, group.desc) : null),
                h('span', { className: 'nk-ratio' }, group.auto ? t('autoHint') : group.ratio === null ? t('groupUnknown') : t('ratio', { value: group.ratio })),
              )),
          ),
        ) : null,
      )
    }

    function Section() {
      const [tab, setTab] = React.useState('keys')
      const [info, setInfo] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [modelSnapshot, setModelSnapshot] = React.useState(null)
      const mounted = React.useRef(true)
      const pending = React.useRef(false)
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
      const run = React.useCallback(async work => {
        if (pending.current) return undefined
        pending.current = true; setBusy(true); setError(''); setNotice('')
        try { return await work() }
        catch (failure) { if (mounted.current && failure?.name !== 'AbortError') setError(t('failed', { message: failure.message })); return undefined }
        finally { pending.current = false; if (mounted.current) setBusy(false) }
      }, [])
      const reload = React.useCallback(async () => { const next = await call('describe'); if (mounted.current) setInfo(next); return next }, [])
      React.useEffect(() => { void run(reload) }, [reload, run])
      const preview = async keys => {
        const result = await run(async () => {
          const selected = await call('selectKeys', { keys })
          if (selected.failed?.length) throw new Error(selected.failed.map(row => `${row.name}: ${row.message}`).join('；'))
          setInfo(selected)
          if (keys.length === 0) { setModelSnapshot(null); return { cleared: true } }
          return call('previewModels', { force: true })
        })
        if (!result) return
        if (result.cleared) { setNotice(t('saved')); return }
        setModelSnapshot(result); setTab('models')
      }
      const tabs = [['keys', 'tabKeys'], ['models', 'tabModels'], ['cost', 'tabCost']]
      return h('div', { className: 'nk-root', 'data-nikoapi-ui': 'multi-key-groups' }, h('style', null, CSS),
        h('div', null, h('div', { className: 'nk-title' }, t('title')), h('div', { className: 'nk-muted' }, t('subtitle'))),
        h('div', { className: 'nk-tabs', role: 'tablist' }, tabs.map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab', className: 'nk-tab', 'aria-selected': tab === id, disabled: busy, onClick: () => setTab(id) }, t(label)))),
        error ? h('div', { className: 'nk-error', role: 'alert' }, error) : null,
        notice ? h('div', { className: 'nk-success', role: 'status' }, notice) : null,
        !info ? h('div', { className: 'nk-muted' }, busy ? t('loading') : t('unavailable'))
          : h('div', { role: 'tabpanel', className: 'nk-stack' }, tab === 'keys'
            ? h(KeysTab, { info, busy, run, setInfo, setNotice, onPreview: preview, invalidate: () => setModelSnapshot(null) })
            : tab === 'models' ? h(ModelsTab, { info, busy, run, setInfo, setNotice, snapshot: modelSnapshot, setSnapshot: setModelSnapshot })
              : h(CostTab, { info, busy, run, setInfo, setNotice })),
      )
    }
    function keysFromCache(info) {
      const rows = new Map((info.keyDirectory?.keys ?? []).map(key => [key.id, key]))
      for (const key of info.connection.keys ?? []) rows.set(key.id, { ...rows.get(key.id), ...key })
      return [...rows.values()]
    }
    function KeysTab({ info, busy, run, setInfo, setNotice, onPreview, invalidate }) {
      const [keys, setKeys] = React.useState(() => keysFromCache(info))
      const [groups, setGroups] = React.useState(() => info.keyDirectory?.groups ?? [])
      const [query, setQuery] = React.useState('')
      const [selected, setSelected] = React.useState(() => new Set((info.connection.keys ?? []).map(key => key.id)))
      const [editing, setEditing] = React.useState(false)
      const [token, setToken] = React.useState('')
      const [writeBlocked, setWriteBlocked] = React.useState(false)
      const [loaded, setLoaded] = React.useState(() => info.keyDirectory?.complete === true)
      const accept = data => {
        if (!Array.isArray(data.selectedKeys)) throw new Error(t('versionMismatch'))
        setKeys(data.keys ?? []); setGroups(data.groups ?? []); setLoaded(data.complete === true)
        setSelected(new Set(data.selectedKeys.map(key => key.id)))
      }
      const load = React.useCallback(async () => {
        const data = await call('listKeys'); accept(data); setInfo(await call('describe')); return data
      }, [setInfo])
      React.useEffect(() => {
        const directory = info.keyDirectory
        setKeys(keysFromCache(info))
        setGroups(directory?.groups ?? [])
        setLoaded(directory?.complete === true)
      }, [info.keyDirectory, info.connection.keys])
      const connect = async () => {
        const result = await run(async () => {
          const credential = token; setToken('')
          const data = await call('connect', { managementToken: credential }); accept(data); setWriteBlocked(false)
          const fresh = await call('describe'); setInfo(fresh); invalidate(); return fresh
        })
        if (result) { setEditing(false); setNotice(t('saved')) }
      }
      const visible = keys.filter(key => key.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      const eligible = visible.filter(isSelectable)
      const all = eligible.length > 0 && eligible.every(key => selected.has(key.id))
      const chosen = keys.filter(key => selected.has(key.id)).map(({ id }) => ({ id }))
      const toggle = id => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
      const toggleVisible = () => setSelected(previous => { const next = new Set(previous); eligible.forEach(key => { if (all) next.delete(key.id); else next.add(key.id) }); return next })
      const changeGroup = async (key, group) => {
        const result = await run(async () => {
          try {
            const data = await call('setGroup', { keyId: key.id, group })
            setKeys(current => current.map(row => row.id === key.id ? data.key : row)); invalidate()
            setInfo(await call('describe')); return data
          } catch (error) { if (error.code === 'scope_missing') setWriteBlocked(true); throw error }
        })
        if (result) setNotice(t('groupSaved'))
      }
      return h(React.Fragment, null,
        h('div', { className: 'nk-card' }, h('div', { className: 'nk-row' }, h('div', { className: 'nk-grow' },
          h('div', { className: 'nk-strong' }, t(info.connection.managementToken.configured ? 'connected' : 'notConnected')),
          h('div', { className: 'nk-note' }, info.site.origin)), btn(t(info.connection.managementToken.configured ? 'reconnect' : 'connection'), { disabled: busy, onClick: () => setEditing(value => !value) })),
          editing ? h('div', { className: 'nk-stack' }, h('label', null, t('tokenLabel'), h('input', { className: 'nk-input', type: 'password', autoComplete: 'off', placeholder: t('tokenPlaceholder'), value: token, onChange: event => setToken(event.target.value) })), h('div', { className: 'nk-note' }, t('tokenHint')),
            h('div', { className: 'nk-row' }, btn(t('save'), { disabled: busy || !token.trim(), onClick: connect }), btn(t('cancel'), { disabled: busy, onClick: () => { setEditing(false); setToken('') } }))) : null),
        h('div', { className: 'nk-row' }, h('input', { className: 'nk-input nk-search', type: 'search', placeholder: t('searchKeys'), 'aria-label': t('searchKeys'), value: query, onChange: event => setQuery(event.target.value) }), btn(t('refresh'), { disabled: busy || !info.connection.managementToken.configured, onClick: () => void run(load) })),
        h('div', { className: 'nk-row' }, h('div', { className: 'nk-strong nk-grow' }, t('myKeys')), h('span', { className: 'nk-note' }, t('keyCount', { count: info.keyDirectory?.total ?? visible.length }))),
        h(SelectCheckbox, { checked: all, mixed: !all && eligible.some(key => selected.has(key.id)), disabled: busy || eligible.length === 0, onChange: toggleVisible }, t(query ? all ? 'clearVisible' : 'selectVisible' : all ? 'clearAll' : 'selectAll')),
        h('div', { className: 'nk-note' }, info.keyDirectory?.at ? t('keyCacheAt', { time: new Date(info.keyDirectory.at).toLocaleString() }) : t('keyCacheEmpty')),
         writeBlocked ? h('div', { className: 'nk-warn' }, t('writeDenied')) : null,
        !loaded && busy ? h('div', { className: 'nk-muted' }, t('loading')) : null,
        h('div', { className: 'nk-list' }, visible.length ? visible.map(key => h('div', { key: key.id, className: 'nk-key', 'data-selected': selected.has(key.id), 'data-key-id': key.id },
          h(SelectCheckbox, { checked: selected.has(key.id), disabled: busy || !isSelectable(key) && !selected.has(key.id), 'aria-label': t('selectKey', { name: key.name }), onChange: () => toggle(key.id) }),
          h('div', { className: 'nk-key-body' }, h('div', { className: 'nk-row' }, h('div', { className: 'nk-strong nk-grow' }, key.name), badge(t(key.status in zh ? key.status : 'unknown'))),
            h('div', { className: 'nk-note' }, `${t('hidden')} · ${key.unlimitedQuota ? t('unlimited') : t('keyQuota', { value: key.remainQuota ?? '—' })}`),
            h(GroupPicker, { value: key.group, groups, disabled: busy || writeBlocked, keyName: key.name, onChange: group => changeGroup(key, group) })))) : h('div', { className: 'nk-muted' }, t('noKeys'))),
        h('div', { className: 'nk-note' }, t('groupHint')),
        h('div', { className: 'nk-foot' }, h('span', { className: 'nk-note' }, t('selectedKeys', { count: selected.size })), btn(t('preview'), { 'data-primary': true, disabled: busy || chosen.length === 0 && (info.connection.keys ?? []).length === 0, onClick: () => onPreview(chosen) })),
      )
    }
    function ModelsTab({ info, busy, run, setInfo, setNotice, snapshot, setSnapshot }) {
      const [query, setQuery] = React.useState('')
      const [checked, setChecked] = React.useState(() => new Set((snapshot?.confirmed ?? info.confirmed ?? []).map(row => pairId(row.keyId, row.modelId))))
      const [registration, setRegistration] = React.useState(info.modelRegistration)
      const load = React.useCallback(async (force = false) => {
        const data = await call('previewModels', { force })
        if (!Array.isArray(data.keys)) throw new Error(t('versionMismatch'))
        setSnapshot(data)
        setChecked(new Set(data.confirmed.map(row => pairId(row.keyId, row.modelId))))
        setInfo(await call('describe'))
      }, [setSnapshot, setInfo])
      React.useEffect(() => { if (!snapshot && info.connection.keys?.length) void run(() => load(false)) }, [snapshot, info.connection.keys?.length, load, run])
      if (!info.connection.keys?.length) return h('div', { className: 'nk-muted' }, t('needKeys'))
      if (!snapshot) return h('div', { className: 'nk-muted' }, t('loading'))
      const needle = query.toLocaleLowerCase()
      const keys = snapshot.keys.map(key => ({ ...key, visible: key.models.filter(model => `${model.modelId}\n${model.name}\n${key.name}`.toLocaleLowerCase().includes(needle)) }))
      const visiblePairs = keys.flatMap(key => key.visible.map(model => pairId(key.id, model.modelId)))
      const all = visiblePairs.length > 0 && visiblePairs.every(id => checked.has(id))
      const anyChecked = checked.size > 0
      const togglePairs = (pairs, select) => setChecked(previous => { const next = new Set(previous); pairs.forEach(id => { if (select) next.add(id); else next.delete(id) }); return next })
      const toggleOne = id => setChecked(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
      const confirm = async () => {
        const selections = snapshot.keys.map(key => ({ keyId: key.id, modelIds: key.models.filter(model => checked.has(pairId(key.id, model.modelId))).map(model => model.modelId) }))
        const data = await run(async () => { const next = await call('confirmModels', { selections }); setInfo(await call('describe')); return next })
        if (!data) return
        setSnapshot({ ...snapshot, confirmed: data.confirmed }); setRegistration(data.registration)
        if (data.registration.registered) setNotice(t('registered', { count: data.registration.count }))
      }
      return h(React.Fragment, null,
        h('div', { className: 'nk-row' }, h('div', { className: 'nk-strong nk-grow' }, t('selectedKeys', { count: snapshot.keys.length })), badge(t('modelCount', { count: snapshot.keys.reduce((sum, key) => sum + key.models.length, 0) }))),
        h('div', { className: 'nk-row' }, h('input', { className: 'nk-input nk-search', type: 'search', placeholder: t('searchModels'), 'aria-label': t('searchModels'), value: query, onChange: event => setQuery(event.target.value) }), btn(t('refresh'), { disabled: busy, onClick: () => void run(() => load(true)) })),
        h(SelectCheckbox, { checked: all, mixed: !all && visiblePairs.some(id => checked.has(id)), disabled: busy || visiblePairs.length === 0, onChange: () => togglePairs(visiblePairs, !all) }, t(query ? all ? 'clearVisible' : 'selectVisible' : all ? 'clearAll' : 'selectAll')),
        h('div', { className: 'nk-stack', 'data-niko-model-list': true }, keys.filter(key => key.visible.length || key.error || !query).map(key => {
          const pairs = key.visible.map(model => pairId(key.id, model.modelId))
          const keyAll = pairs.length > 0 && pairs.every(id => checked.has(id))
          return h('div', { key: key.id, className: 'nk-card', 'data-model-key': key.id },
            h('div', { className: 'nk-row' }, h('div', { className: 'nk-grow' }, h('div', { className: 'nk-strong' }, key.name), h('div', { className: 'nk-note' }, `${t('group')}：${groupTitle(key.group, snapshot.groups ?? [])}`)),
              h(SelectCheckbox, { checked: keyAll, mixed: !keyAll && pairs.some(id => checked.has(id)), disabled: busy || !pairs.length, onChange: () => togglePairs(pairs, !keyAll) }, t(keyAll ? 'clearAll' : 'selectAll'))),
            key.error ? h('div', { className: 'nk-error' }, key.error) : null,
            ...key.visible.map(model => h('div', { className: 'nk-model', key: model.modelId }, h(SelectCheckbox, { checked: checked.has(pairId(key.id, model.modelId)), disabled: busy, onChange: () => toggleOne(pairId(key.id, model.modelId)) },
              h('span', { className: 'nk-model-body' }, h('span', { className: 'nk-strong' }, model.modelId), h('span', { className: 'nk-muted' }, priceText(model.price)), model.price?.reference ? h('span', { className: 'nk-note' }, t('reference')) : null)))),
            !key.visible.length && !key.error ? h('div', { className: 'nk-muted' }, t('noModels')) : null)
        })),
        h('div', { className: 'nk-note' }, t('confirmHint')),
        h('div', { className: 'nk-foot' }, h('span', { className: 'nk-note' }, t('selectedModels', { count: checked.size })), btn(checked.size === 0 && (info.confirmed ?? []).length ? t('saveModels') : t('addModels'), { 'data-primary': true, disabled: busy || (!anyChecked && !(info.confirmed ?? []).length), onClick: confirm })),
        registration?.lastStatus === 'error' ? h('div', { className: 'nk-error', role: 'alert' }, t('registrationFailed', { message: registration.lastMessage })) : h('div', { className: 'nk-note' }, registration?.registered ? t('registered', { count: registration.count }) : t('unregistered')),
      )
    }
    function CostTab({ info, busy, run, setInfo, setNotice }) {
      const [minutes, setMinutes] = React.useState(String(info.cost.refreshMinutes))
      const available = info.cost.available === true
      const save = async () => {
        const result = await run(async () => { const data = await call('saveCostBinding', { refreshMinutes: Number(minutes) }); setInfo(await call('describe')); return data })
        if (result) setNotice(t('saved'))
      }
      const status = { bound: 'bound', 'bound-partial': 'boundPartial', 'bound-stale': 'stale', waiting: 'waiting', pending: 'pending', error: 'syncError' }[info.cost.status] ?? 'unbound'
      return h(React.Fragment, null,
        h('div', { className: 'nk-card' }, h('div', { className: 'nk-strong' }, t('costPlugin')), h('div', null, 'dsh-cost-meter'), h('div', { className: 'nk-muted' }, t(available ? 'costReady' : 'costMissing')), !available ? h('div', { className: 'nk-note' }, t(info.cost.reason === 'unsupported' ? 'costUnsupported' : 'costMissingHint')) : null),
        h('div', { className: 'nk-note' }, t('costAutomatic')),
        h('div', { className: 'nk-note' }, t('costConflicts', { count: info.cost.conflicts?.length ?? 0 })),
        h('label', { className: 'nk-stack' }, t('interval'), h('input', { className: 'nk-input', type: 'number', min: 1, max: 1440, disabled: busy || !available, value: minutes, onChange: event => setMinutes(event.target.value) })),
        h('div', { className: 'nk-note' }, t('intervalHint')),
        h('div', { className: 'nk-note' }, t('costScope')), h('div', { className: 'nk-note' }, t('costUnavailable', { count: info.cost.unavailable?.length ?? 0 })),
        h('div', { className: 'nk-card' }, h('div', { className: 'nk-strong' }, t('costStatus')), h('div', null, t(status)), info.cost.message ? h('div', { className: 'nk-note' }, info.cost.message) : null),
        h('div', { className: 'nk-foot' }, btn(t('refreshCost'), { disabled: busy || !available, onClick: () => void run(async () => { await call('refresh'); setInfo(await call('describe')); setNotice(t('saved')) }) }), btn(t('saveSettings'), { 'data-primary': true, disabled: busy, onClick: save })),
      )
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'nikoapi: dictionaries')
        translate = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'nikoapi', order: 60, label: () => t('nav') }, Section))
      },
    }
  },
})
