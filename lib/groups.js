/**
 * Group options for the picker.
 *
 * In the deployed New API fork, `/api/pricing.usable_group` is
 * `group id -> description`; `group_ratio` is the independent multiplier map.
 * `/api/group/` is an admin-only endpoint, so a user's key-management PAT must
 * not call it. Keep the upstream group id as the title, the provided value as
 * its second line, and never synthesize a description.
 */

/**
 * @param {object} input
 * @param {Record<string, unknown>} [input.usableGroup] `/api/pricing` usable_group
 * @param {Record<string, number>} [input.groupRatio] `/api/pricing` group_ratio
 * @param {Record<string, { name?: string, desc?: string }>} [input.groupMeta] optional extra metadata
 * @returns {Array<{ id: string, name: string, desc: string, ratio: number | null }>}
 */
export function normalizeGroups({ usableGroup, groupRatio, groupMeta } = {}) {
  const ratios = groupRatio !== null && typeof groupRatio === 'object' ? groupRatio : {}
  const meta = groupMeta !== null && typeof groupMeta === 'object' ? groupMeta : {}
  const source = usableGroup !== null && typeof usableGroup === 'object' ? usableGroup : {}
  const ids = new Set([...Object.keys(source), ...Object.keys(meta)])
  const rows = []
  for (const id of ids) {
    const raw = source[id]
    const detailed = raw !== null && typeof raw === 'object' ? raw : undefined
    const description = typeof raw === 'string' ? raw : ''
    const fromMeta = meta[id]
    rows.push({
      id,
      name: firstText(fromMeta?.name, detailed?.name, id),
      desc: firstText(fromMeta?.desc, detailed?.desc, description),
      ratio: Number.isFinite(ratios[id]) ? ratios[id] : null,
    })
  }
  rows.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  return rows
}

/** The secondary line exactly follows the API's group description. */
export function groupSecondary(group) {
  if (typeof group?.desc === 'string' && group.desc.trim() !== '') return group.desc.trim()
  return ''
}

/** Fold extra metadata rows into an id-keyed lookup. */
export function groupMetaFromRows(rows) {
  const meta = {}
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue
    const id = firstText(row.id, row.group, row.name, '')
    if (id === '') continue
    const name = firstText(row.display_name, row.label, row.name, '')
    const desc = firstText(row.desc, row.description, row.remark, '')
    meta[id] = {
      ...(name === '' || name === id ? {} : { name }),
      ...(desc === '' ? {} : { desc }),
    }
  }
  return meta
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}
