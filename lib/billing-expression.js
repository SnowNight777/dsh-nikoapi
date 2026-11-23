const zeroUsageVars = new Set(['cc1h', 'cc12h', 'img', 'img_cr', 'img_o', 'ai', 'ao', 'image_count'])
const tokenVars = new Set(['p', 'c', 'len', 'cr', 'cc', ...zeroUsageVars])
const billedTokenVars = new Set(['p', 'c', 'cr', 'cc'])
const functionNames = new Set(['tier', 'fixed', 'u', 'param', 'header', 'has', 'hour', 'minute', 'weekday', 'month', 'day', 'max', 'min', 'abs', 'ceil', 'floor', 'when'])
const maxExpressionLength = 16_384
const maxTokens = 4_096
const maxDepth = 64
const compiled = new Map()

export class NikoBillingExpressionError extends Error {
  constructor(code, message) { super(message); this.name = 'NikoBillingExpressionError'; this.code = code }
}

function fail(code, message) { throw new NikoBillingExpressionError(code, message) }
function finite(value) { return typeof value === 'number' && Number.isFinite(value) }

function tokenize(source) {
  if (typeof source !== 'string' || source.length === 0 || source.length > maxExpressionLength) fail('invalid_expression', 'expression is empty or exceeds the size limit')
  const rows = []
  let i = 0
  while (i < source.length) {
    const char = source[i]
    if (/\s/.test(char)) { i++; continue }
    const pair = source.slice(i, i + 2)
    const triple = source.slice(i, i + 3)
    if (['|||', '&&', '||', '==', '!=', '<=', '>='].includes(triple) || ['&&', '||', '==', '!=', '<=', '>='].includes(pair)) {
      rows.push(triple === '|||' ? { kind: 'separator', value: triple } : { kind: 'operator', value: triple.length === 2 ? triple : pair })
      i += triple === '|||' ? 3 : 2
    } else if ('+-*/%<>!?:(),'.includes(char)) {
      rows.push({ kind: 'operator', value: char }); i++
    } else if (char === '"') {
      const start = i++
      let escaped = false
      while (i < source.length) {
        const current = source[i++]
        if (escaped) escaped = false
        else if (current === '\\') escaped = true
        else if (current === '"') break
      }
      if (source[i - 1] !== '"') fail('invalid_expression', 'unterminated string literal')
      let value
      try { value = JSON.parse(source.slice(start, i)) } catch { fail('invalid_expression', 'invalid string literal') }
      rows.push({ kind: 'literal', value })
    } else if (/[0-9.]/.test(char)) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i))
      if (!match) fail('invalid_expression', 'invalid numeric literal')
      const value = Number(match[0])
      if (!finite(value)) fail('invalid_expression', 'numeric literal must be finite')
      rows.push({ kind: 'literal', value }); i += match[0].length
    } else if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))[0]
      rows.push({ kind: 'identifier', value: match }); i += match.length
    } else fail('invalid_expression', `unsupported character at offset ${i}`)
    if (rows.length > maxTokens) fail('invalid_expression', 'expression has too many tokens')
  }
  rows.push({ kind: 'end', value: '' })
  return rows
}

const precedence = new Map([['||', 1], ['&&', 2], ['==', 3], ['!=', 3], ['<', 4], ['<=', 4], ['>', 4], ['>=', 4], ['+', 5], ['-', 5], ['*', 6], ['/', 6], ['%', 6]])

function parsePart(source) {
  const tokens = tokenize(source)
  let cursor = 0, nodes = 0
  const peek = () => tokens[cursor]
  const take = () => tokens[cursor++]
  const node = value => {
    if (++nodes > maxTokens) fail('invalid_expression', 'expression has too many nodes')
    const children = [value.left, value.right, value.test, value.yes, value.no, value.value?.type ? value.value : null, ...(value.args ?? [])].filter(Boolean)
    value.height = 1 + Math.max(0, ...children.map(child => child.height ?? 0))
    if (value.height > maxDepth) fail('invalid_expression', 'expression AST exceeds the nesting limit')
    return value
  }
  function primary(depth) {
    if (depth > maxDepth) fail('invalid_expression', 'expression nesting exceeds the limit')
    const token = take()
    if (token.kind === 'literal') return node({ type: 'literal', value: token.value })
    if (token.kind === 'identifier') {
      if (token.value === 'true' || token.value === 'false') return node({ type: 'literal', value: token.value === 'true' })
      if (peek().value !== '(') {
        if (!tokenVars.has(token.value)) fail('invalid_expression', `unknown identifier ${token.value}`)
        return node({ type: 'variable', name: token.value })
      }
      if (!functionNames.has(token.value)) fail('invalid_expression', `unsupported function ${token.value}`)
      take()
      const args = []
      if (peek().value !== ')') {
        do { args.push(expression(0, depth + 1)); if (peek().value !== ',') break; take() } while (true)
      }
      if (take().value !== ')') fail('invalid_expression', 'expected closing parenthesis')
      return node({ type: 'call', name: token.value, args })
    }
    if (token.value === '(') {
      const result = expression(0, depth + 1)
      if (take().value !== ')') fail('invalid_expression', 'expected closing parenthesis')
      return result
    }
    if (['+', '-', '!'].includes(token.value)) return node({ type: 'unary', op: token.value, value: primary(depth + 1) })
    fail('invalid_expression', 'expected a value')
  }
  function expression(min, depth) {
    let left = primary(depth)
    while (peek().kind === 'operator' && precedence.has(peek().value) && precedence.get(peek().value) >= min) {
      const op = take().value, p = precedence.get(op)
      left = node({ type: 'binary', op, left, right: expression(p + 1, depth + 1) })
    }
    if (min === 0 && peek().value === '?') {
      take()
      const yes = expression(0, depth + 1)
      if (take().value !== ':') fail('invalid_expression', 'expected colon in conditional expression')
      left = node({ type: 'conditional', test: left, yes, no: expression(0, depth + 1) })
    }
    return left
  }
  const tree = expression(0, 0)
  if (peek().kind !== 'end') fail('invalid_expression', 'unexpected trailing expression content')
  return tree
}

function walk(tree, visit) {
  visit(tree)
  if (tree.left) { walk(tree.left, visit); walk(tree.right, visit) }
  if (tree.value?.type) walk(tree.value, visit)
  if (tree.test) { walk(tree.test, visit); walk(tree.yes, visit); walk(tree.no, visit) }
  for (const child of tree.args ?? []) walk(child, visit)
}

function containsCall(tree, name) {
  let found = false
  walk(tree, part => { if (part.type === 'call' && part.name === name) found = true })
  return found
}

function validateFixed(tree) {
  const hasFixed = containsCall(tree, 'fixed')
  if (!hasFixed) return
  const allowed = part => {
    if (part.type === 'conditional') return allowed(part.yes) && allowed(part.no)
    if (part.type === 'binary' && part.op === '*') {
      const imageCount = part.left.type === 'variable' && part.left.name === 'image_count' || part.right.type === 'variable' && part.right.name === 'image_count'
      return imageCount && allowed(part.left.type === 'variable' && part.left.name === 'image_count' ? part.right : part.left)
    }
    if (part.type !== 'call' || part.name !== 'tier' || part.args.length !== 2 || part.args[0].type !== 'literal' || typeof part.args[0].value !== 'string') return false
    const price = part.args[1]
    if (price.type === 'call' && price.name === 'fixed' && price.args.length === 1 && price.args[0].type === 'literal' && finite(price.args[0].value) && price.args[0].value >= 0) return true
    return !containsCall(price, 'fixed')
  }
  if (!allowed(tree)) fail('unsupported_expression', 'fixed() must be the complete price of a tier leaf')
}

function truth(value) { return value === true || typeof value === 'number' && value !== 0 || typeof value === 'string' && value.length > 0 }
function safeNumber(value) { if (!finite(value)) fail('unsupported_context', 'expression requires a finite numeric value'); return value }

function evalTree(tree, env, trace) {
  if (tree.type === 'literal') return tree.value
  if (tree.type === 'variable') {
    if (!Object.hasOwn(env, tree.name)) fail('unsupported_context', `usage field ${tree.name} is unavailable for this request`)
    return env[tree.name]
  }
  if (tree.type === 'unary') {
    const value = evalTree(tree.value, env, trace)
    return tree.op === '!' ? !truth(value) : tree.op === '-' ? -safeNumber(value) : safeNumber(value)
  }
  if (tree.type === 'conditional') return evalTree(truth(evalTree(tree.test, env, trace)) ? tree.yes : tree.no, env, trace)
  if (tree.type === 'binary') {
    const left = evalTree(tree.left, env, trace)
    if (tree.op === '&&') return truth(left) && truth(evalTree(tree.right, env, trace))
    if (tree.op === '||') return truth(left) || truth(evalTree(tree.right, env, trace))
    const right = evalTree(tree.right, env, trace)
    if (tree.op === '==') return left === right
    if (tree.op === '!=') return left !== right
    if (tree.op === '<') return left < right
    if (tree.op === '<=') return left <= right
    if (tree.op === '>') return left > right
    if (tree.op === '>=') return left >= right
    const a = safeNumber(left), b = safeNumber(right)
    if (tree.op === '+') return a + b
    if (tree.op === '-') return a - b
    if (tree.op === '*') return a * b
    if (tree.op === '/') { if (b === 0) fail('invalid_result', 'division by zero'); return a / b }
    if (tree.op === '%') { if (b === 0) fail('invalid_result', 'modulo by zero'); return a % b }
  }
  if (tree.type === 'call') {
    const args = tree.args.map(arg => evalTree(arg, env, trace))
    switch (tree.name) {
      case 'tier':
        if (args.length !== 2 || typeof args[0] !== 'string') fail('invalid_expression', 'tier expects a label and a price')
        trace.matchedTier = args[0]; return safeNumber(args[1])
      case 'fixed':
        if (args.length !== 1 || safeNumber(args[0]) < 0) fail('invalid_expression', 'fixed expects one non-negative amount')
        trace.fixed = safeNumber(args[0]); return trace.fixed * 1_000_000
      case 'max': case 'min':
        if (args.length !== 2) fail('invalid_expression', `${tree.name} expects two arguments`)
        return tree.name === 'max' ? Math.max(safeNumber(args[0]), safeNumber(args[1])) : Math.min(safeNumber(args[0]), safeNumber(args[1]))
      case 'abs': case 'ceil': case 'floor':
        if (args.length !== 1) fail('invalid_expression', `${tree.name} expects one argument`)
        return Math[tree.name](safeNumber(args[0]))
      case 'u': case 'param': case 'header': fail('unsupported_context', `${tree.name}() values are not available in DSH usage records`)
      case 'has':
        if (args.length !== 2) fail('invalid_expression', 'has expects two arguments')
        return String(args[0] ?? '').includes(String(args[1]))
      case 'when': if (args.length !== 1) fail('invalid_expression', 'when expects one argument'); return args[0]
      case 'hour': case 'minute': case 'weekday': case 'month': case 'day': {
        if (args.length > 1) fail('invalid_expression', `${tree.name} expects at most one timezone`)
        let parts
        try { parts = new Intl.DateTimeFormat('en', { timeZone: typeof args[0] === 'string' ? args[0] : 'UTC', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(env.atMs)) }
        catch { fail('unsupported_context', 'timezone in billing expression is invalid') }
        const field = Object.fromEntries(parts.map(part => [part.type, part.value]))
        if (tree.name === 'hour') return Number(field.hour) % 24
        if (tree.name === 'minute') return Number(field.minute)
        if (tree.name === 'day') return Number(field.day)
        if (tree.name === 'month') return Number(field.month)
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(field.weekday)
      }
    }
  }
  fail('invalid_expression', 'expression could not be evaluated')
}

function usesTokenValue(tree) {
  let used = false
  walk(tree, node => { if (node.type === 'variable' && billedTokenVars.has(node.name)) used = true })
  return used
}
function checkedVector(vector) {
  if (!finite(vector.constant) || vector.constant < 0 || Object.values(vector.coefficients).some(value => !finite(value) || value < 0)) fail('unsupported_expression', 'native fee components must be finite and non-negative')
  return vector
}
function linearize(tree, env, trace) {
  if (tree.type === 'literal') return { constant: safeNumber(tree.value), coefficients: {} }
  if (tree.type === 'variable') {
    if (billedTokenVars.has(tree.name)) return { constant: 0, coefficients: { [tree.name]: 1 } }
    if (zeroUsageVars.has(tree.name)) return { constant: 0, coefficients: {} }
    fail('unsupported_expression', 'context variables may select a tier but cannot act as a native unit price')
  }
  if (tree.type === 'conditional') return linearize(truth(evalTree(tree.test, env, trace)) ? tree.yes : tree.no, env, trace)
  if (tree.type === 'call') {
    if (tree.name === 'tier') {
      const label = evalTree(tree.args[0], env, trace)
      if (typeof label !== 'string') fail('invalid_expression', 'tier label must be a string')
      trace.matchedTier = label
      return linearize(tree.args[1], env, trace)
    }
    if (tree.name === 'fixed') return { constant: safeNumber(evalTree(tree, env, trace)), coefficients: {} }
    if (usesTokenValue(tree)) fail('unsupported_expression', 'token-dependent math functions require an unavailable native fee decomposition')
    return { constant: safeNumber(evalTree(tree, env, trace)), coefficients: {} }
  }
  if (tree.type === 'unary') {
    const value = linearize(tree.value, env, trace), factor = tree.op === '-' ? -1 : tree.op === '+' ? 1 : null
    if (factor === null) return { constant: truth(evalTree(tree, env, trace)) ? 1 : 0, coefficients: {} }
    return scale(value, factor)
  }
  if (tree.type === 'binary') {
    if (['==', '!=', '<', '<=', '>', '>=', '&&', '||', '%'].includes(tree.op)) return { constant: safeNumber(evalTree(tree, env, trace)), coefficients: {} }
    const a = linearize(tree.left, env, trace), b = linearize(tree.right, env, trace)
    if (tree.op === '+') return add(a, b)
    if (tree.op === '-') return add(a, scale(b, -1))
    if (tree.op === '*') {
      if (Object.keys(a.coefficients).length && Object.keys(b.coefficients).length) fail('unsupported_expression', 'non-linear token pricing cannot be split into native fee rows')
      return Object.keys(a.coefficients).length ? scale(a, b.constant) : scale(b, a.constant)
    }
    if (tree.op === '/') {
      if (Object.keys(b.coefficients).length || b.constant === 0) fail('unsupported_expression', 'token pricing denominator must be a non-zero constant')
      return scale(a, 1 / b.constant)
    }
  }
  fail('unsupported_expression', 'billing expression cannot be represented by native fee rows')
}
function add(a, b) { const coefficients = { ...a.coefficients }; for (const [key, value] of Object.entries(b.coefficients)) coefficients[key] = (coefficients[key] ?? 0) + value; return { constant: a.constant + b.constant, coefficients } }
function scale(value, factor) { return { constant: value.constant * factor, coefficients: Object.fromEntries(Object.entries(value.coefficients).map(([key, amount]) => [key, amount * factor])) } }

function validatePriceBranch(tree, env, multiplier) {
  const trace = { fixed: null, matchedTier: '' }
  const vector = checkedVector(linearize(tree, env, trace))
  if (multiplier) {
    const value = evalTree(tree, env, trace)
    if (!finite(value) || value < 0 || Object.keys(vector.coefficients).length) fail('unsupported_expression', 'billing multipliers must be finite non-negative scalars')
  } else if (vector.constant !== 0 && trace.fixed === null) fail('unsupported_expression', 'constant request charges require fixed()')
}

function isScalarFactor(factor, price) {
  return usesTokenValue(price) && !usesTokenValue(factor) && !containsCall(factor, 'fixed')
}

function validateAllBranches(tree, env, multiplier = false) {
  if (tree.type === 'conditional') {
    validatePriceBranch(tree.yes, env, multiplier)
    validatePriceBranch(tree.no, env, multiplier)
    validateAllBranches(tree.test, env)
    validateAllBranches(tree.yes, env, multiplier)
    validateAllBranches(tree.no, env, multiplier)
  } else if (tree.type === 'binary') {
    // Bare numeric branches are valid as token-price factors, not as request charges.
    const product = tree.op === '*'
    validateAllBranches(tree.left, env, product && (multiplier || isScalarFactor(tree.left, tree.right)))
    validateAllBranches(tree.right, env, product && (multiplier || isScalarFactor(tree.right, tree.left)))
  } else if (tree.type === 'unary') validateAllBranches(tree.value, env)
  else if (tree.type === 'call') for (const arg of tree.args) validateAllBranches(arg, env)
}

export function analyzeNikoBillingExpression(expression) {
  if (typeof expression === 'string' && compiled.has(expression)) return compiled.get(expression)
  const result = compileExpression(expression)
  if (typeof expression === 'string' && expression.length <= maxExpressionLength) {
    if (compiled.size >= 128) compiled.delete(compiled.keys().next().value)
    compiled.set(expression, result)
  }
  return result
}

function compileExpression(expression) {
  try {
    if (typeof expression !== 'string' || expression.length > maxExpressionLength) fail('invalid_expression', 'invalid expression size')
    if (/^v\d+:/.test(expression) && !expression.startsWith('v1:')) fail('unsupported_expression', 'unknown billing expression version')
    const parts = (expression.startsWith('v1:') ? expression.slice(3) : expression).split('|||')
    if (parts.length > 2) fail('invalid_expression', 'only one request-rule section is allowed')
    const tree = parsePart(parts[0].trim())
    const rules = parts.length === 2 ? parsePart(parts[1].trim()) : null
    validateFixed(tree)
    if (rules && containsCall(rules, 'fixed')) fail('unsupported_expression', 'fixed() is not allowed in request-rule multipliers')
    const variables = new Set()
    let unsupported
    let zeroRequestContext = false
    walk(tree, node => {
      if (node.type === 'variable') variables.add(node.name)
      if (node.type === 'call' && ['u', 'param', 'header'].includes(node.name)) {
        if (node.name === 'u') zeroRequestContext = true
        unsupported = `${node.name}() requires request fields unavailable to the local usage ledger`
      }
    })
    if (rules) walk(rules, node => {
      if (node.type === 'variable') variables.add(node.name)
      if (node.type === 'call' && ['u', 'param', 'header'].includes(node.name)) {
        if (node.name === 'u') zeroRequestContext = true
        unsupported = `${node.name}() request rules are not available to the local usage ledger`
      }
    })
    const zeroByPolicy = zeroRequestContext || variables.has('image_count')
    const zeroOnCacheWrite = variables.has('cc1h') || variables.has('cc12h')
    if (!unsupported) {
      const env = { p: 1000, c: 300, len: 1500, cr: 100, cc: 50, cc1h: 0, cc12h: 0,
        img: 0, img_cr: 0, img_o: 0, ai: 0, ao: 0, image_count: 1, atMs: Date.UTC(2026, 0, 1, 12) }
      const trace = { fixed: null, matchedTier: '' }
      const initial = checkedVector(linearize(tree, env, trace))
      if (initial.constant !== 0 && trace.fixed === null) fail('unsupported_expression', 'constant request charges require fixed()')
      if (rules) checkedVector(linearize(rules, env, trace))
      validateAllBranches(tree, env)
      if (rules) validateAllBranches(rules, env)
    }
    return { supported: !unsupported, zeroByPolicy, zeroOnCacheWrite, reason: unsupported ?? '', tree, rules, variables, fixedPricing: containsCall(tree, 'fixed') }
  } catch (error) { return { supported: false, zeroByPolicy: false, reason: error?.message ?? 'billing expression is not supported', error } }
}

function zeroPolicyQuote(reason = 'request uses a billing field excluded by the local policy') {
  return { currency: 'CNY', cost: 0, matchedTier: 'zero-policy', billingUnit: 'request', zeroByPolicy: true,
    note: reason, rows: [{ bucket: 'modelRequests', tokens: 0, requests: 1, rate: 0, cost: 0, priced: true }] }
}

function requestPriceQuote(value) {
  const amount = Number(value)
  if (!finite(amount) || amount < 0) return null
  return { currency: 'CNY', cost: amount, matchedTier: 'request-price', billingUnit: 'request',
    rows: [{ bucket: 'modelRequests', tokens: 0, requests: 1, rate: amount, cost: amount, priced: true }] }
}

export function nikoBillingBreakdown(tokens, entry, atMs = Date.now()) {
  const requestPrice = requestPriceQuote(entry?.requestPriceCny)
  if (requestPrice !== null) return requestPrice
  const parsed = analyzeNikoBillingExpression(entry?.billingExpr)
  const safeTokens = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].map(key => {
    const value = Number(tokens?.[key] ?? 0)
    if (!finite(value) || value < 0) fail('invalid_usage', 'usage buckets must be finite and non-negative')
    return [key, value]
  }))
  if (entry?.zeroByPolicy === true || parsed.zeroByPolicy === true) return zeroPolicyQuote(parsed.reason)
  if (!parsed.supported) return null
  if (parsed.zeroOnCacheWrite && safeTokens.cacheWrite > 0) return zeroPolicyQuote('long TTL cache-write usage is excluded by the local zero-cost policy')
  const variables = parsed.variables
  const cacheRead = safeTokens.cacheRead
  const cacheWrite = safeTokens.cacheWrite
  const p = safeTokens.input + (variables.has('cr') ? 0 : cacheRead) + (variables.has('cc') ? 0 : cacheWrite)
  const c = safeTokens.output
  const env = { p, c, len: safeTokens.input + cacheRead + cacheWrite, cr: cacheRead, cc: cacheWrite, cc1h: 0, cc12h: 0, img: 0, img_cr: 0, img_o: 0, ai: 0, ao: 0, image_count: 1, atMs }
  const trace = { fixed: null, matchedTier: '' }
  try {
    let vector = linearize(parsed.tree, env, trace)
    let multiplier = 1
    if (parsed.rules) multiplier = safeNumber(evalTree(parsed.rules, env, trace))
    vector = scale(vector, multiplier)
    const expressionValue = safeNumber(evalTree(parsed.tree, env, { fixed: null, matchedTier: '' })) * multiplier
    if (expressionValue < 0 || !finite(expressionValue) || !finite(multiplier) || multiplier < 0) return null
    const quotaPerUnit = Number(entry.billingQuotaPerUnit)
    const groupRatio = Number(entry.billingGroupRatio)
    if (!finite(quotaPerUnit) || quotaPerUnit <= 0 || !finite(groupRatio) || groupRatio < 0) return null
    const quotaScale = quotaPerUnit * groupRatio / 1_000_000
    if (trace.fixed !== null) {
      const rawQuota = trace.fixed * multiplier * quotaPerUnit * groupRatio
      if (!finite(rawQuota) || rawQuota > 2_147_483_647) return null
      const amount = Math.round(rawQuota) / quotaPerUnit
      return { currency: 'CNY', cost: amount, matchedTier: trace.matchedTier, billingUnit: 'request', rows: [{ bucket: 'modelRequests', tokens: 0, requests: 1, rate: amount, cost: amount, priced: true }] }
    }
    const rows = []
    const addRow = (bucket, count, rate) => {
      if (count <= 0) return
      const cnyRate = rate * groupRatio
      rows.push({ bucket, tokens: count, rate: cnyRate, cost: count * cnyRate / 1_000_000, priced: true })
    }
    const pRate = vector.coefficients.p ?? 0
    addRow('input', safeTokens.input, pRate)
    if (!variables.has('cr')) addRow('cacheRead', cacheRead, pRate)
    if (!variables.has('cc')) addRow('cacheWrite', cacheWrite, pRate)
    addRow('cacheRead', variables.has('cr') ? cacheRead : 0, vector.coefficients.cr ?? 0)
    addRow('cacheWrite', variables.has('cc') ? cacheWrite : 0, vector.coefficients.cc ?? 0)
    const cRate = vector.coefficients.c ?? 0
    addRow('output', safeTokens.output, cRate)
    const rawQuota = expressionValue * quotaScale
    if (!finite(rawQuota) || rawQuota > 2_147_483_647) return null
    const cost = Math.round(rawQuota) / quotaPerUnit
    const rowCost = rows.reduce((sum, row) => sum + row.cost, 0)
    const rounding = cost - rowCost
    if (rows.length && rounding !== 0) {
      const largest = rows.reduce((a,b)=>a.cost >= b.cost ? a : b)
      largest.cost += rounding
      if (largest.cost < 0) return null
    }
    else if (!rows.length && cost > 0) rows.push({ bucket: 'modelRequests', tokens: 0, requests: 1, rate: cost, cost, priced: true })
    return { currency: 'CNY', cost, matchedTier: trace.matchedTier, billingUnit: 'token', rows }
  } catch { return null }
}
