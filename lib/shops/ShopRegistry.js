'use strict'

const { normalizeItemName, itemMatches, countItem, extractLore } = require('../utils/items')
const { waitForEvent, sleep } = require('../utils/async')
const { error } = require('../core/errors')

function clickTuple (kind) {
  switch (kind) {
    case 'shift-left': return [0, 1]
    case 'shift-right': return [1, 1]
    case 'right': return [1, 0]
    case 'left':
    default: return [0, 0]
  }
}

class ShopRegistry {
  constructor (bot, engine) {
    this.bot = bot
    this.engine = engine
    this.adapters = new Map()
    // Xarid xarajatini kuzatish uchun FAQAT jarayon xotirasida (in-memory)
    // — hech qanday faylga yozilmaydi, bot qayta ishga tushsa nolga
    // qaytadi. Bu ataylab shunday: byudjet — bitta uzluksiz production
    // sessiyasi uchun xavfsizlik chegarasi, tarixiy hisobot emas.
    this.spend = new Map()
    this.register('command-gui', createCommandGuiAdapter())
  }

  register (id, adapter) {
    if (typeof id !== 'string' || !id) throw new TypeError('Shop adapter id must be a string')
    if (!adapter || typeof adapter.purchase !== 'function') throw new TypeError('Shop adapter requires purchase(context)')
    this.adapters.set(id, adapter)
    return adapter
  }

  get (id) {
    const adapter = this.adapters.get(id)
    if (!adapter) throw error('SHOP_ADAPTER_NOT_FOUND', `Unknown shop adapter: ${id}`)
    return adapter
  }

  budgetKeyFor (source) {
    return source.budgetKey || source.command || source.openCommand ||
      (typeof source.adapter === 'string' ? source.adapter : null) || 'default'
  }

  getSpend (budgetKey) {
    return this.spend.get(budgetKey) || 0
  }

  resetSpend (budgetKey) {
    if (budgetKey == null) this.spend.clear()
    else this.spend.delete(budgetKey)
  }

  async purchase (source, itemSelector, amount) {
    const adapter = typeof source.adapter === 'object'
      ? source.adapter
      : this.get(source.adapter || 'command-gui')

    /*
     * Byudjet (source.costPerUnit + source.maxSpend) ixtiyoriy — narx
     * server tomonidan avtomatik aniqlanmaydi (bu serverdan-serverga
     * har xil bo'lardi va chatni tahlil qilish nozik/ishonchsiz bo'lardi),
     * shuning uchun foydalanuvchi o'zi narxni belgilaydi. Byudjet
     * tugagan bo'lsa, xaridga umuman urinilmaydi va so'ralgan miqdor
     * qolgan byudjetga moslab qisqartiriladi.
     */
    const budgetKey = this.budgetKeyFor(source)
    const costPerUnit = Number(source.costPerUnit) || 0
    const maxSpend = source.maxSpend != null ? Number(source.maxSpend) : null
    let effectiveAmount = amount

    if (costPerUnit > 0 && maxSpend != null) {
      const spentSoFar = this.getSpend(budgetKey)
      const remainingBudget = Math.max(0, maxSpend - spentSoFar)
      // A click buys a whole `amountPerClick` bundle, so only whole bundles
      // the remaining budget can pay for are affordable. Otherwise a request
      // for 5 items with amountPerClick 64 would spend 64 * costPerUnit.
      const amountPerClick = Math.max(1, Math.floor(Number(source.amountPerClick) || 1))
      const affordable = Math.floor(Math.floor(remainingBudget / costPerUnit) / amountPerClick) * amountPerClick

      if (affordable <= 0) {
        this.engine.emit('shopBudgetExceeded', { source, budgetKey, spent: spentSoFar, maxSpend })
        return 0
      }

      const requestedUnits = effectiveAmount === 'all' || effectiveAmount === Infinity
        ? Infinity
        : Math.ceil(Math.max(0, Number(effectiveAmount)) / amountPerClick) * amountPerClick
      if (requestedUnits > affordable) effectiveAmount = affordable
    }

    const before = countItem(this.bot.inventory.items(), itemSelector, this.bot)
    const result = await adapter.purchase({
      bot: this.bot,
      engine: this.engine,
      source,
      item: itemSelector,
      amount: effectiveAmount,
      helpers: { waitForEvent, sleep, itemMatches, countItem, clickTuple }
    })
    const after = countItem(this.bot.inventory.items(), itemSelector, this.bot)
    const acquired = Math.max(0, after - before)
    if (source.verify !== false && acquired <= 0 && !result?.acquired) {
      throw error('SHOP_NO_PROGRESS', `Shop did not provide ${selectorToName(itemSelector)}`)
    }
    const finalAcquired = result?.acquired ?? acquired

    if (costPerUnit > 0 && finalAcquired > 0) {
      this.spend.set(budgetKey, this.getSpend(budgetKey) + finalAcquired * costPerUnit)
    }

    return finalAcquired
  }
}

function createCommandGuiAdapter () {
  return {
    async purchase ({ bot, engine, source, item, amount, helpers }) {
      if (!source.command && !source.openCommand) throw new TypeError('command-gui shop requires command/openCommand')
      const command = source.command || source.openCommand
      const windowPromise = helpers.waitForEvent(bot, 'windowOpen', {
        timeout: source.windowTimeoutMs || 5000,
        predicate: window => {
          if (!window) return false
          if (source.titleIncludes && !String(window.title).toLowerCase().includes(String(source.titleIncludes).toLowerCase())) return false
          if (source.titleRegex && !(new RegExp(source.titleRegex).test(String(window.title)))) return false
          return true
        }
      })
      bot.chat(command)
      const [window] = await windowPromise

      try {
        const selector = source.product || item
        const selectorName = selectorToName(selector)
        // Only the shop's own slots are searched. The player-inventory part of
        // the window may already hold the product, and clicking it would move
        // the bot's own items instead of buying.
        const shopSlots = shopSlotsOf(window)
        let slot = mappedSlot(source.itemSlots, selectorName)
        if (slot == null) slot = source.itemSlot
        if (slot == null) {
          slot = shopSlots.findIndex(stack => helpers.itemMatches(stack, selector, bot))
        }
        if ((slot == null || slot < 0) && source.autoFind !== false) {
          slot = fuzzyShopSlot(shopSlots, selectorName)
        }
        if (slot == null || slot < 0) throw error('SHOP_ITEM_NOT_FOUND', `Product ${selectorName} not found in shop window ${window.title}`)

        const amountPerClick = Math.max(1, Number(source.amountPerClick || 1))
        const requestedClicks = amount === 'all' || amount === Infinity
          ? Math.max(1, Number(source.maxClicks || 1))
          : Math.max(1, Math.ceil(Number(amount) / amountPerClick))
        const maxClicks = source.maxClicks == null
          ? requestedClicks
          : Math.max(1, Number(source.maxClicks))
        const clicks = Math.min(requestedClicks, maxClicks)
        const [button, mode] = helpers.clickTuple(source.click || source.buyMode || 'left')
        const beforeCount = helpers.countItem(bot.inventory.items(), selector, bot)
        let performed = 0
        let stopReason = null
        const stopPatterns = (source.stopOnChatPatterns || [
          /cannot afford/i,
          /inventory is full/i,
          /your inventory is full/i
        ]).map(value => value instanceof RegExp ? value : new RegExp(String(value), 'i'))
        const onMessage = message => {
          if (source.stopOnChat === false) return
          const text = String(message || '')
          if (stopPatterns.some(pattern => pattern.test(text))) stopReason = text
        }
        bot.on('messagestr', onMessage)

        try {
          for (let index = 0; index < clicks; index++) {
            if (bot.currentWindow !== window || stopReason) break
            await bot.clickWindow(slot, button, mode)
            performed++

            if (source.confirmSlot != null) {
              if (source.confirmDelayMs) await helpers.sleep(source.confirmDelayMs)
              await bot.clickWindow(source.confirmSlot, 0, 0)
            }

            await helpers.sleep(source.clickDelayMs ?? 250)

            const acquired = helpers.countItem(bot.inventory.items(), selector, bot) - beforeCount
            if (amount !== 'all' && amount !== Infinity && acquired >= Number(amount)) break
            if (bot.inventory.emptySlotCount && bot.inventory.emptySlotCount() <= 0) break
          }
        } finally {
          bot.removeListener('messagestr', onMessage)
        }

        if (stopReason) engine?.emit?.('shopStopped', { source, item: selectorName, reason: stopReason, clicks: performed })
        await helpers.sleep(source.afterPurchaseDelayMs ?? 400)
        const acquired = Math.max(0, helpers.countItem(bot.inventory.items(), selector, bot) - beforeCount)
        return { clicks: performed, acquired, stopReason }
      } finally {
        if (source.closeWindow !== false && bot.currentWindow === window) bot.closeWindow(window)
      }
    }
  }
}

function selectorToName (selector) {
  if (typeof selector === 'string') return normalizeItemName(selector)
  if (selector && typeof selector === 'object' && selector.name) return normalizeItemName(selector.name)
  return String(selector)
}

function shopSlotsOf (window) {
  const slots = Array.isArray(window?.slots) ? window.slots : []
  const end = Number(window?.inventoryStart)
  return Number.isInteger(end) && end > 0 && end <= slots.length ? slots.slice(0, end) : slots
}

function mappedSlot (mapping, selectorName) {
  if (!mapping || typeof mapping !== 'object') return null
  if (mapping[selectorName] != null) return Number(mapping[selectorName])
  const namespaced = `minecraft:${selectorName}`
  if (mapping[namespaced] != null) return Number(mapping[namespaced])
  return null
}

function fuzzyShopSlot (slots, selectorName) {
  const words = selectorName.split('_').filter(Boolean)
  return slots.findIndex(stack => {
    if (!stack) return false
    if (stack.name === selectorName) return true
    const display = String(stack.displayName || '').toLowerCase().replace(/§./g, ' ')
    const lore = extractLore(stack).join(' ').toLowerCase().replace(/§./g, ' ')
    return words.every(word => display.includes(word) || lore.includes(word))
  })
}

module.exports = { ShopRegistry, createCommandGuiAdapter, clickTuple, selectorToName, mappedSlot, fuzzyShopSlot, shopSlotsOf }
