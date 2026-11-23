/**
 * Bounded JSON HTTP with an exact-origin credential fence.
 *
 * Every authenticated request must name the origin it is allowed to reach.
 * The comparison uses protocol + host + port, because comparing only the
 * hostname would send a key to a different service on the same host.
 * Redirects are never followed: a 3xx is a failure, not a hop.
 */

export class HttpError extends Error {
  /**
   * @param {string} message safe diagnostic; never contains a credential or body
   * @param {{ status?: number, code?: string }} [detail]
   */
  constructor(message, detail = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = detail.status
    this.code = detail.code ?? 'HTTP'
  }
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/** Effective port for an absolute URL. */
export function portOf(url) {
  if (url.port !== '') return url.port
  if (url.protocol === 'https:') return '443'
  if (url.protocol === 'http:') return '80'
  return ''
}

/** Whether `candidate` is the same origin as `base` (protocol, host, port). */
export function sameOrigin(candidate, base) {
  if (candidate.protocol !== base.protocol) return false
  if (portOf(candidate) !== portOf(base)) return false
  return candidate.hostname.toLowerCase() === base.hostname.toLowerCase()
}

/** Loopback hosts may use plain HTTP; everything else must be TLS. */
export function isLoopback(hostname) {
  const name = hostname.toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1'
}

/**
 * Validate one absolute URL against a fixed origin.
 * @param {string} raw URL text.
 * @param {string} origin required origin, e.g. `https://nikoapi.xyz`.
 * @returns {URL}
 */
export function requireUrl(raw, origin) {
  let url
  let base
  try {
    url = new URL(raw)
    base = new URL(origin)
  } catch {
    throw new HttpError('invalid URL', { code: 'BAD_URL' })
  }
  if (url.username !== '' || url.password !== '') throw new HttpError('URL must not carry credentials', { code: 'BAD_URL' })
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new HttpError('only HTTPS (or loopback HTTP) is allowed', { code: 'BAD_SCHEME' })
  }
  if (!sameOrigin(url, base)) throw new HttpError('request left the configured origin', { code: 'CROSS_ORIGIN' })
  return url
}

/**
 * One JSON request.
 * @param {object} request
 * @param {string} request.url absolute URL.
 * @param {string} request.origin allowed origin.
 * @param {string} [request.method]
 * @param {Record<string,string>} [request.headers]
 * @param {unknown} [request.json] JSON body.
 * @param {number} [request.timeoutMs]
 * @param {number} [request.maxBytes]
 * @param {AbortSignal} [request.signal]
 * @param {typeof fetch} [request.fetch]
 * @returns {Promise<{ status: number, body: any, text: string, authenticated: boolean }>}
 */
export async function requestJson(request) {
  const url = requireUrl(request.url, request.origin)
  const fetchImpl = request.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new HttpError('no fetch implementation', { code: 'NO_FETCH' })
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  const onAbort = () => { controller.abort() }
  request.signal?.addEventListener('abort', onAbort, { once: true })
  const headers = { accept: 'application/json', ...request.headers }
  let body
  if (request.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(request.json)
  }
  try {
    const response = await fetchImpl(url, {
      method: request.method ?? 'GET',
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status >= 300 && response.status < 400) {
      throw new HttpError('upstream redirect refused', { status: response.status, code: 'REDIRECT' })
    }
    const text = await readBounded(response, maxBytes)
    let parsed
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new HttpError('upstream returned non-JSON', { status: response.status, code: 'BAD_JSON' })
      }
    }
    return { status: response.status, body: parsed, text, authenticated: response.headers.get('auth-version') !== null }
  } catch (error) {
    if (error instanceof HttpError) throw error
    if (error?.name === 'AbortError') throw new HttpError('upstream request timed out or was cancelled', { code: 'TIMEOUT' })
    throw new HttpError('upstream request failed', { code: 'NETWORK' })
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onAbort)
  }
}

async function readBounded(response, maxBytes) {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new HttpError('upstream response exceeded the size limit', { code: 'TOO_LARGE' })
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}
