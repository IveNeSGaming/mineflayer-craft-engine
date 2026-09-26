'use strict'

const { resolveItem, inventoryCounts } = require('../utils/items')
const { toVec3 } = require('../utils/positions')
const { sleep, waitForEvent } = require('../utils/async')
const { error } = require('../core/errors')

class CraftingManager {
  constructor (bot, recipeRegistry, planner, engine) {
    this.bot = bot
    this.recipeRegistry = recipeRegistry
    this.planner = planner
    this.engine = engine
  }

  async craft (options) {
    if (!options || !options.item) throw new TypeError('craft() requires item')
    const item = resolveItem(this.bot, options.item)
    const amount = options.amount ?? 1
    const recursive = options.recursive === true
    const tablePosition = options.table || options.craftingTable || null
    const tableAvailable = Boolean(tablePosition) || options.tableAvailable === true
    const before = this.countInventory(item.id)

    if (recursive) {
      const executePlan = async (outputCount) => {
        const plan = this.planner.simulateRecursive(item.id, outputCount, inventoryCounts(this.bot), {
          tableAvailable,
          baseItemIds: options.baseItemIds
        })
        for (const step of plan.steps) {
          await this.executeRecipe(step.item, step.recipe, step.outputCount, {
            ...options,
            amount: step.outputCount,
            table: step.recipe.requiresTable ? tablePosition : null,
            recursive: false
          })
        }
        return plan.steps.length
      }

      if (amount === 'all') {
        const batchSize = Math.max(1, Number(options.batchSize || 2304))
        while (true) {
          const possible = this.planner.maxRecursiveOutput(item.id, batchSize, inventoryCounts(this.bot), {
            tableAvailable,
            baseItemIds: options.baseItemIds
          })
          if (possible <= 0) break
          const steps = await executePlan(possible)
          if (steps <= 0) break
        }
      } else {
        await executePlan(Number(amount))
      }
    } else {
      const recipe = options.recipe || this.planner.chooseRecipe(item.id, { tableAvailable })
      const mismatch = this.planner.findDeclaredMismatch(item, recipe)
      if (mismatch) this.engine.emit('recipeMismatch', mismatch)
      await this.executeRecipe(item, recipe, amount, { ...options, table: tablePosition })
    }

    const after = this.countInventory(item.id)
    return {
      item: item.name,
      requested: amount,
      crafted: Math.max(0, after - before),
      mode: options.mode || 'adaptive'
    }
  }

  async executeRecipe (item, recipe, amount, options) {
    const mode = options.mode || 'adaptive'
    const before = this.countInventory(item.id)
    const desiredOutput = amount === 'all' ? Infinity : Number(amount)
    if (desiredOutput !== Infinity && (!Number.isFinite(desiredOutput) || desiredOutput <= 0)) return 0

    if (['fast', 'adaptive'].includes(mode)) {
      try {
        const crafted = await this.fastRecipeBookCraft(item, recipe, desiredOutput, options)
        if (crafted > 0 || desiredOutput === 0) return crafted
        throw error('FAST_NO_PROGRESS', `Fast craft made no progress for ${item.name}`)
      } catch (fastError) {
        this.engine.emit('fastFallback', { item: item.name, error: fastError })
        if (mode === 'fast' && options.fallback === false) throw fastError
      }
    }

    const alreadyCrafted = Math.max(0, this.countInventory(item.id) - before)
    const remaining = desiredOutput === Infinity ? 'all' : Math.max(0, desiredOutput - alreadyCrafted)
    if (remaining === 0) return alreadyCrafted
    const safeCrafted = await this.safeCraft(item, recipe, remaining, options)
    return alreadyCrafted + safeCrafted
  }

  async safeCraft (item, recipe, desiredOutput, options) {
    const tableBlock = recipe.requiresTable ? this.resolveCraftingTable(options.table) : null
    const maxOps = this.planner.maxOperations(recipe)
    const operations = desiredOutput === 'all' || desiredOutput === Infinity
      ? maxOps
      : Math.min(maxOps, this.planner.operationsForOutput(recipe, desiredOutput))
    if (operations <= 0) throw error('MISSING_MATERIAL', `Not enough materials to craft ${item.name}`)

    const before = this.countInventory(item.id)
    await this.bot.craft(recipe, operations, tableBlock)
    const crafted = Math.max(0, this.countInventory(item.id) - before)
    if (crafted <= 0) throw error('CRAFT_NO_PROGRESS', `Safe craft made no progress for ${item.name}`)
    return crafted
  }

  async fastRecipeBookCraft (item, recipe, desiredOutput, options) {
    if (!this.bot._client || typeof this.bot._client.write !== 'function') {
      throw error('PROTOCOL_UNAVAILABLE', 'Raw protocol client is unavailable')
    }
    if (!this.bot.supportFeature || !this.bot.supportFeature('stateIdUsed')) {
      throw error('FAST_UNSUPPORTED', `Fast crafting is currently supported for stateId-era clients (1.17.1+)`)
    }

    const maxOps = this.planner.maxOperations(recipe)
    if (maxOps <= 0) throw error('MISSING_MATERIAL', `Not enough materials to craft ${item.name}`)

    const targetOps = desiredOutput === Infinity
      ? maxOps
      : Math.min(maxOps, this.planner.operationsForOutput(recipe, desiredOutput))
    if (targetOps <= 0) return 0

    const { window, opened } = await this.openCraftingWindow(recipe, options.table, options.windowTimeoutMs || 5000)
    const recipeId = this.recipeRegistry.resolveRecipeId(item.name, recipe, options.recipeId)
    const before = this.countWindowInventory(window, item.id)
    const resultSlot = 0
    let crafted = 0

    try {
      const expectedOutput = targetOps * Math.max(1, Number(recipe.result?.count || 1))
      const makeAll = desiredOutput === Infinity || targetOps === maxOps
      const maxPasses = Math.max(1, Number(options.maxFastPasses || Math.min(256, targetOps)))
      let passes = 0

      while (passes < maxPasses) {
        const previous = this.countWindowInventory(window, item.id)
        try {
          await this.requestAndCollect(window, resultSlot, item.id, recipeId, makeAll, options)
        } catch (cause) {
          const partial = this.countWindowInventory(window, item.id) - before
          if (partial > 0) break
          throw cause
        }

        passes++
        const current = this.countWindowInventory(window, item.id)
        const gained = current - previous
        const total = current - before

        if (gained <= 0) break
        if (total >= expectedOutput) break
        if (!makeAll && passes >= targetOps) break
      }

      crafted = Math.max(0, this.countWindowInventory(window, item.id) - before)
    } finally {
      if (opened && options.closeWindow !== false && this.bot.currentWindow === window) {
        this.bot.closeWindow(window)
      }
    }

    if (crafted <= 0) throw error('FAST_NO_PROGRESS', `Recipe-book crafting produced no ${item.name}`, { recipeId })
    return crafted
  }

  async requestAndCollect (window, resultSlot, itemId, recipeId, makeAll, options) {
    const timeout = options.fastTimeoutMs || 2500
    const resultReady = this.waitForResult(window, resultSlot, itemId, timeout)
    this.bot._client.write('craft_recipe_request', {
      windowId: window.id,
      recipe: recipeId,
      makeAll
    })
    await resultReady

    const before = this.countWindowInventory(window, itemId)
    await this.bot.clickWindow(resultSlot, 0, 1)
    await this.waitForInventoryIncrease(window, itemId, before, timeout)
    await this.waitForStableInventory(window, itemId, options.stableMs || 80, timeout)
  }

  async openCraftingWindow (recipe, tablePosition, timeout) {
    if (!recipe.requiresTable) return { window: this.bot.inventory, opened: false }
    const table = this.resolveCraftingTable(tablePosition)

    if (this.bot.currentWindow?.type?.startsWith('minecraft:crafting')) {
      return { window: this.bot.currentWindow, opened: false }
    }

    this.bot.activateBlock(table)
    const [window] = await waitForEvent(this.bot, 'windowOpen', {
      timeout,
      predicate: opened => opened?.type?.startsWith('minecraft:crafting')
    })
    return { window, opened: true }
  }

  resolveCraftingTable (position) {
    if (!position) throw error('TABLE_REQUIRED', 'This recipe requires a crafting table position')
    const vec = toVec3(position)
    const block = this.bot.blockAt(vec)
    if (!block) throw error('TABLE_NOT_FOUND', `No block found at crafting table position ${vec}`)
    if (block.name !== 'crafting_table') {
      throw error('TABLE_NOT_FOUND', `Expected crafting_table at ${vec}, found ${block.name}`)
    }
    return block
  }

  waitForResult (window, slot, itemId, timeout) {
    if (window.slots[slot]?.type === itemId) return Promise.resolve(window.slots[slot])
    return new Promise((resolve, reject) => {
      const slotEvent = `setSlot:${window.id}`
      const itemsEvent = `setWindowItems:${window.id}`
      const timer = setTimeout(() => {
        cleanup()
        reject(error('FAST_TIMEOUT', `Timed out waiting for recipe result in window ${window.id}`))
      }, timeout)
      const onChange = () => {
        const result = window.slots[slot]
        if (result?.type !== itemId) return
        cleanup()
        resolve(result)
      }
      const onClose = closed => {
        if (closed?.id !== window.id) return
        cleanup()
        reject(error('WINDOW_CLOSED', 'Crafting window closed while waiting for recipe result'))
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.bot.removeListener(slotEvent, onChange)
        this.bot.removeListener(itemsEvent, onChange)
        this.bot.removeListener('windowClose', onClose)
      }
      this.bot.on(slotEvent, onChange)
      this.bot.on(itemsEvent, onChange)
      this.bot.on('windowClose', onClose)
    })
  }

  waitForInventoryIncrease (window, itemId, before, timeout) {
    if (this.countWindowInventory(window, itemId) > before) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const event = `setSlot:${window.id}`
      const itemsEvent = `setWindowItems:${window.id}`
      const timer = setTimeout(() => {
        cleanup()
        reject(error('FAST_TIMEOUT', `Timed out waiting for crafted item ${itemId} to enter inventory`))
      }, timeout)
      const cleanup = () => {
        clearTimeout(timer)
        this.bot.removeListener(event, check)
        this.bot.removeListener(itemsEvent, check)
      }
      const check = () => {
        if (this.countWindowInventory(window, itemId) <= before) return
        cleanup()
        resolve()
      }
      this.bot.on(event, check)
      this.bot.on(itemsEvent, check)
    })
  }

  async waitForStableInventory (window, itemId, stableMs, timeout) {
    const started = Date.now()
    let previous = this.countWindowInventory(window, itemId)
    let stableSince = Date.now()
    while (Date.now() - started < timeout) {
      await sleep(20)
      const current = this.countWindowInventory(window, itemId)
      if (current !== previous) {
        previous = current
        stableSince = Date.now()
      } else if (Date.now() - stableSince >= stableMs) {
        return current
      }
    }
    return previous
  }

  countWindowInventory (window, itemId) {
    if (!window || window === this.bot.inventory || window.id === 0) return this.bot.inventory.count(itemId, null)
    let total = 0
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
      const item = window.slots[slot]
      if (item?.type === itemId) total += item.count
    }
    return total
  }

  countInventory (itemId) {
    return this.bot.inventory.count(itemId, null)
  }
}

module.exports = { CraftingManager }
