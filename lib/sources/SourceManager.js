'use strict'

const { resolveItem, normalizeItemName } = require('../utils/items')
const { error } = require('../core/errors')

class SourceManager {
  constructor (bot, containerManager, shopRegistry, engine) {
    this.bot = bot
    this.containers = containerManager
    this.shops = shopRegistry
    this.engine = engine
  }

  async acquire (itemSelector, amount, sources = [], options = {}) {
    const item = resolveItem(this.bot, itemSelector)
    const requested = amount === 'all' || amount === Infinity ? Infinity : Math.max(0, Number(amount))
    const before = this.bot.inventory.count(item.id, null)
    let missing = requested
    if (missing === 0) return { item: item.name, acquired: 0, total: before, missing: 0 }

    for (const source of sources) {
      if (missing <= 0) break
      if (!source || source.enabled === false) continue
      const type = source.type || 'inventory'
      let moved = 0

      try {
        if (type === 'inventory') {
          moved = 0
        } else if (isRangeSource(source)) {
          moved = await this.containers.withdrawRange(
            source,
            source.item || item.name,
            missing,
            source
          )
        } else if (['chest', 'barrel', 'shulker', 'ender_chest', 'container'].includes(type)) {
          const position = source.position || source.pos || source.chest
          moved = await this.containers.withdraw(position, source.item || item.name, missing, source)
        } else if (type === 'shop') {
          moved = await this.shops.purchase(source, source.product || item.name, missing)
        } else if (type === 'custom' && typeof source.acquire === 'function') {
          moved = Number(await source.acquire({ bot: this.bot, engine: this.engine, item, amount: missing })) || 0
        } else {
          throw error('SOURCE_TYPE_UNSUPPORTED', `Unsupported source type: ${type}`)
        }
      } catch (cause) {
        this.engine.emit('sourceError', { source, item: item.name, error: cause })
        const optional = options.required === false || source.required === false || source.optional === true
        if (!optional) throw cause
        continue
      }

      this.engine.emit('sourceUsed', { source, item: item.name, moved })
      if (missing !== Infinity) missing -= moved
    }

    const after = this.bot.inventory.count(item.id, null)
    const acquired = Math.max(0, after - before)
    return {
      item: item.name,
      acquired,
      total: after,
      missing: requested === Infinity ? null : Math.max(0, requested - acquired)
    }
  }

  async acquireRequirements (requirements, sources, options = {}) {
    const results = []
    for (const requirement of requirements) {
      const itemSources = (sources || []).filter(source => {
        if (!source.items && !source.item) return true
        const allowed = Array.isArray(source.items) ? source.items : [source.item]
        return allowed.some(value => selectorMatchesRequirement(value, requirement))
      })
      const result = await this.acquire(requirement.id, requirement.count, itemSources, options)
      results.push(result)
      if (options.required !== false && result.missing > 0) {
        throw error('SOURCE_SHORTAGE', `Could not acquire ${result.missing} ${requirement.name}`, { requirement, result })
      }
    }
    return results
  }
}

/** 'minecraft:emerald', 'Emerald', 388 and { name: 'emerald' } all match emerald. */
function selectorMatchesRequirement (value, requirement) {
  if (value == null) return false
  if (typeof value === 'number') return value === requirement.id
  if (typeof value === 'string') {
    try {
      return normalizeItemName(value) === requirement.name
    } catch {
      return false
    }
  }
  if (typeof value === 'object') {
    if (value.id != null) return value.id === requirement.id
    if (value.name) return selectorMatchesRequirement(value.name, requirement)
    // displayName/lore-only selectors cannot be mapped to a requirement id.
    return false
  }
  return false
}

function isRangeSource (source) {
  const type = source?.type || ''
  return Boolean(
    (source?.start && source?.end) ||
    ['range', 'container-range', 'container_range', 'chest-range', 'chest_range'].includes(type)
  )
}

module.exports = { SourceManager, isRangeSource, selectorMatchesRequirement }
