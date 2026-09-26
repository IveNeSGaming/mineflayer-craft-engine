'use strict'

function normalizeItemName (name) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('Item name must be a non-empty string')
  return name.trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
}

function resolveItem (bot, selector) {
  if (typeof selector === 'number') {
    const item = bot.registry.items[selector]
    if (!item) throw new Error(`Unknown item id: ${selector}`)
    return item
  }
  if (selector && typeof selector === 'object') {
    if (selector.id != null) return resolveItem(bot, selector.id)
    if (selector.name) return resolveItem(bot, selector.name)
  }
  const name = normalizeItemName(selector)
  const item = bot.registry.itemsByName[name]
  if (!item) throw new Error(`Unknown item: ${selector}`)
  return item
}

function itemMatches (stack, selector, bot) {
  if (!stack) return false
  if (typeof selector === 'function') return Boolean(selector(stack))
  if (Array.isArray(selector)) return selector.some(value => itemMatches(stack, value, bot))
  if (typeof selector === 'number') return stack.type === selector
  if (typeof selector === 'string') return stack.name === normalizeItemName(selector)
  if (!selector || typeof selector !== 'object') return false
  if (selector.id != null && stack.type !== selector.id) return false
  if (selector.name && stack.name !== normalizeItemName(selector.name)) return false
  if (selector.metadata != null && stack.metadata !== selector.metadata) return false
  if (selector.displayName && stack.displayName !== selector.displayName) return false
  if (selector.displayNameIncludes && !String(stack.displayName || '').includes(selector.displayNameIncludes)) return false
  const lore = extractLore(stack)
  if (selector.loreIncludes && !lore.some(line => line.includes(selector.loreIncludes))) return false
  if (selector.nbtPredicate && !selector.nbtPredicate(stack.nbt, stack)) return false
  return true
}

function extractLore (stack) {
  try {
    const lore = stack?.nbt?.value?.display?.value?.Lore?.value?.value
    if (!Array.isArray(lore)) return []
    return lore.map(value => {
      try {
        const parsed = JSON.parse(value)
        return parsed.text || value
      } catch {
        return String(value)
      }
    })
  } catch {
    return []
  }
}

function countItem (windowOrItems, selector, bot) {
  const items = Array.isArray(windowOrItems)
    ? windowOrItems
    : typeof windowOrItems?.items === 'function'
      ? windowOrItems.items()
      : []
  return items.reduce((sum, item) => sum + (itemMatches(item, selector, bot) ? item.count : 0), 0)
}

function inventoryCounts (bot) {
  const counts = new Map()
  for (const item of bot.inventory.items()) counts.set(item.type, (counts.get(item.type) || 0) + item.count)
  return counts
}

function cloneCounts (counts) {
  return new Map(counts instanceof Map ? counts : Object.entries(counts).map(([k, v]) => [Number(k), v]))
}

function countFreeInventorySlots (bot) {
  let free = 0
  for (let slot = bot.inventory.inventoryStart; slot < bot.inventory.inventoryEnd; slot++) {
    if (!bot.inventory.slots[slot]) free++
  }
  return free
}

function itemCountDelta (before, after, itemId) {
  return (after.get(itemId) || 0) - (before.get(itemId) || 0)
}

module.exports = {
  normalizeItemName,
  resolveItem,
  itemMatches,
  extractLore,
  countItem,
  inventoryCounts,
  cloneCounts,
  countFreeInventorySlots,
  itemCountDelta
}
