'use strict'

const { EventEmitter } = require('events')
const { resolveItem, inventoryCounts, itemMatches, countItem } = require('../utils/items')
const { sleep, waitForEvent } = require('../utils/async')
const { error } = require('../core/errors')

class ProductionJob extends EventEmitter {
  constructor (engine, options) {
    super()
    this.engine = engine
    this.bot = engine.bot
    this.options = normalizeProductionOptions(options)
    this.cancelled = false
    this.paused = false
    this.state = 'idle'
    this.cycles = 0
    this.totalCrafted = 0
    this.startedAt = null
    this.endedAt = null
    this.lastError = null
    this.checkpoint = null
  }

  setState (state, details = {}) {
    this.state = state
    const event = { state, job: this, ...details }
    this.emit('state', event)
    this.engine.emit('state', event)
  }

  pause () {
    this.paused = true
    this.setState('paused')
  }

  resume () {
    this.paused = false
    this.emit('_resume')
  }

  stop () {
    this.cancelled = true
    this.emit('_resume')
    this.setState('stopping')
  }

  status () {
    return {
      state: this.state,
      cycles: this.cycles,
      totalCrafted: this.totalCrafted,
      cancelled: this.cancelled,
      paused: this.paused,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      checkpoint: this.checkpoint,
      error: this.lastError?.message || null
    }
  }

  async run () {
    this.startedAt = new Date().toISOString()
    const target = resolveItem(this.bot, this.options.target.item)
    const discoveredBaseItems = [...this.options.baseItems]

    for (const source of this.options.sources) {
      const type = source.type || 'inventory'
      const hasExplicitItems = source.item != null || Array.isArray(source.items) || source.product != null
      if (!hasExplicitItems && ['chest', 'barrel', 'shulker', 'ender_chest', 'container'].includes(type)) {
        const contents = await this.engine.containers.inspect(source.position || source.pos || source.chest, source)
        for (const stack of contents) if (!discoveredBaseItems.includes(stack.type)) discoveredBaseItems.push(stack.type)
      }
    }

    let directIngredients = []
    try {
      const directRecipe = this.engine.planner.chooseRecipe(target.id, {
        counts: inventoryCounts(this.bot),
        tableAvailable: Boolean(this.options.craftingTable)
      })
      directIngredients = this.engine.planner.requirements(directRecipe)
      for (const requirement of directIngredients) {
        if (!discoveredBaseItems.includes(requirement.id)) discoveredBaseItems.push(requirement.id)
      }

      const automaticShopIngredients = detectAutomaticShopIngredients({
        planner: this.engine.planner,
        bot: this.bot,
        target,
        sources: this.options.sources,
        tableAvailable: Boolean(this.options.craftingTable)
      })
      if (automaticShopIngredients.length) {
        this.engine.emit('shopIngredientsDetected', {
          target: target.name,
          ingredients: automaticShopIngredients.map(requirement => ({
            id: requirement.id,
            name: this.bot.registry.items[requirement.id]?.name,
            count: requirement.count
          }))
        })
      }
    } catch (cause) {
      this.engine.emit('shopIngredientDetectionFailed', { target: target.name, error: cause })
    }

    const baseItemIds = discoveredBaseItems.map(selector => resolveItem(this.bot, selector).id)
    const productionSelectors = [
      target.name,
      ...baseItemIds.map(id => this.bot.registry.items[id]?.name).filter(Boolean),
      ...directIngredients.map(requirement => this.bot.registry.items[requirement.id]?.name).filter(Boolean),
      ...this.options.keep,
      ...this.options.protect
    ]

    const requested = this.options.target.amount
    let remaining = requested === 'all' ? Infinity : Number(requested)
    if (remaining !== Infinity && (!Number.isFinite(remaining) || remaining <= 0)) {
      throw new TypeError('target.amount must be a positive number or all')
    }

    this.setState('running', { target: target.name })
    this.engine.emit('jobStart', { job: this, target: target.name, amount: requested })

    try {
      if (this.options.preflight) {
        this.setState('preflight')
        await this.flushExistingOutput(target, 'startup')
        await this.bufferUnrelatedItems(productionSelectors, 'startup')
      }

      while (!this.cancelled && remaining > 0 && this.cycles < this.options.maxCycles) {
        if (!await this.waitIfPaused()) break
        await this.ensureAlive()

        if (this.options.flushOutputEachCycle) await this.flushExistingOutput(target, 'cycle-start')
        if (this.options.bufferEachCycle) await this.bufferUnrelatedItems(productionSelectors, 'cycle-start')

        this.cycles++
        const configuredBatch = resolveCycleBatchSize({
          value: this.options.batchSize,
          planner: this.engine.planner,
          bot: this.bot,
          target,
          tableAvailable: Boolean(this.options.craftingTable)
        })
        const cycleRequested = remaining === Infinity
          ? configuredBatch
          : Math.min(remaining, configuredBatch)

        this.setState('planning', { cycle: this.cycles, requested: cycleRequested })
        const countsBeforeAcquire = inventoryCounts(this.bot)
        const requirements = this.engine.planner.leafRequirements(target.id, cycleRequested, {
          counts: countsBeforeAcquire,
          tableAvailable: Boolean(this.options.craftingTable),
          baseItemIds
        })

        this.setState('acquiring', { requirements })
        await this.engine.sources.acquireRequirements(requirements, this.options.sources, { required: false })

        const possible = this.engine.planner.maxRecursiveOutput(
          target.id,
          cycleRequested,
          inventoryCounts(this.bot),
          { tableAvailable: Boolean(this.options.craftingTable), baseItemIds }
        )

        if (possible <= 0) {
          // A previous interrupted run may have left finished output in inventory.
          const flushed = await this.flushExistingOutput(target, 'no-materials')
          if (flushed > 0) {
            if (this.options.cycleDelayMs > 0) await sleep(this.options.cycleDelayMs)
            continue
          }

          this.engine.emit('materialsMissing', { job: this, target: target.name, requirements })
          if (this.options.repeat) {
            this.setState('waiting_materials')
            await sleep(this.options.repeatDelayMs)
            continue
          }
          break
        }

        this.setState('crafting', { amount: possible })
        if (this.options.craftingTable) await this.engine.containers.goTo(this.options.craftingTable, 2)
        const craftResult = await this.engine.crafting.craft({
          item: target.name,
          amount: possible,
          table: this.options.craftingTable,
          mode: this.options.mode,
          recursive: this.options.recursive,
          recipeId: this.options.recipeId,
          fallback: this.options.fallback,
          fastTimeoutMs: this.options.fastTimeoutMs,
          closeWindow: true,
          baseItemIds
        })

        const crafted = craftResult.crafted
        if (crafted <= 0) {
          const flushed = await this.flushExistingOutput(target, 'no-craft-progress')
          if (flushed > 0) continue
          if (this.options.repeat) {
            this.setState('waiting_no_progress')
            await sleep(this.options.repeatDelayMs)
            continue
          }
          break
        }

        this.totalCrafted += crafted
        if (remaining !== Infinity) remaining = Math.max(0, remaining - crafted)
        this.engine.metrics.craftedItems += crafted
        this.engine.metrics.cycles++
        this.engine.emit('craftComplete', { job: this, item: target.name, amount: crafted })

        // Store every finished target stack currently in inventory, not only the
        // number created by this cycle. This also clears output left by a crash.
        await this.flushExistingOutput(target, 'after-craft')

        if (this.options.leftovers) {
          this.setState('cleaning')
          await this.engine.destinations.clean(this.options.leftovers, {
            keep: this.options.keep,
            protect: [target.name, ...this.options.protect]
          })
        }

        if (this.options.bufferEachCycle) await this.bufferUnrelatedItems(productionSelectors, 'cycle-end')

        this.checkpoint = {
          target: target.name,
          requested,
          remaining: remaining === Infinity ? 'all' : remaining,
          totalCrafted: this.totalCrafted,
          cycles: this.cycles,
          timestamp: new Date().toISOString()
        }
        this.engine.lastCheckpoint = this.checkpoint
        this.engine.emit('checkpoint', this.checkpoint)

        if (remaining > 0 && this.options.cycleDelayMs > 0) await sleep(this.options.cycleDelayMs)
      }

      this.setState(this.cancelled ? 'stopped' : 'completed')
      return {
        item: target.name,
        requested,
        totalCrafted: this.totalCrafted,
        cycles: this.cycles,
        stopped: this.cancelled,
        checkpoint: this.checkpoint
      }
    } catch (cause) {
      this.lastError = cause
      this.setState('failed', { error: cause })
      this.engine.emit('jobError', { job: this, error: cause })
      throw cause
    } finally {
      this.endedAt = new Date().toISOString()
      this.engine.emit('jobComplete', { job: this, status: this.status() })
    }
  }

  async flushExistingOutput (target, reason) {
    if (!this.options.output) return 0
    const existing = countItem(this.bot.inventory.items(), target.name, this.bot)
    if (existing <= 0) return 0

    this.setState(reason === 'after-craft' ? 'storing_output' : 'flushing_output', {
      amount: existing,
      reason
    })
    const moved = await this.engine.destinations.send(this.options.output, target.name, 'all')
    this.engine.emit('outputStored', {
      job: this,
      item: target.name,
      amount: moved,
      reason,
      preexisting: reason !== 'after-craft'
    })
    return moved
  }

  async bufferUnrelatedItems (protectedSelectors, reason) {
    const buffer = this.options.inventoryBuffer
    if (!buffer) return 0

    const predicate = stack => !protectedSelectors.some(selector => itemMatches(stack, selector, this.bot))
    const count = this.bot.inventory.items()
      .filter(predicate)
      .reduce((sum, stack) => sum + stack.count, 0)
    if (count <= 0) return 0

    this.setState('buffering_inventory', { amount: count, reason })
    const moved = await this.engine.destinations.clean(buffer, {
      keep: protectedSelectors,
      protect: []
    })
    this.engine.emit('inventoryBuffered', { job: this, amount: moved, reason, destination: buffer })
    return moved
  }

  async waitIfPaused () {
    while (this.paused && !this.cancelled) {
      await waitForEvent(this, '_resume', { timeout: 24 * 60 * 60 * 1000 })
    }
    return !this.cancelled
  }

  async ensureAlive () {
    if (!this.engine.dead) return
    if (!this.options.resumeAfterDeath) throw error('BOT_DEAD', 'Bot died during production')
    this.setState('waiting_respawn')
    await waitForEvent(this.bot, 'spawn', { timeout: this.options.respawnTimeoutMs })
    this.engine.dead = false
    await sleep(this.options.afterRespawnDelayMs)
  }
}

function normalizeProductionOptions (options = {}) {
  const target = options.target || { item: options.item, amount: options.amount ?? 'all' }
  if (!target?.item) throw new TypeError('production() requires target.item or item')

  const sources = options.sources ? [...options.sources] : []
  if (options.sourceChest) {
    sources.push({
      type: 'chest',
      position: options.sourceChest,
      item: options.sourceItem
    })
  }
  if (!sources.some(source => source.type === 'inventory')) sources.unshift({ type: 'inventory' })

  const output = options.output || (options.outputChest ? { type: 'chest', position: options.outputChest } : null)
  const leftovers = options.leftovers || (options.leftoversChest ? { type: 'chest', position: options.leftoversChest } : null)
  const inventoryBuffer = options.inventoryBuffer || options.buffer || options.temporaryChest || null

  const inferredBaseItems = [...(options.baseItems || [])]
  for (const source of sources) {
    const values = source.items || (source.item != null ? [source.item] : source.product != null ? [source.product] : [])
    for (const value of values) {
      if ((typeof value === 'string' || typeof value === 'number') && !inferredBaseItems.includes(value)) inferredBaseItems.push(value)
    }
  }

  const batchSize = options.batchSize == null ? 2304 : options.batchSize
  if (!['inventory', 'max'].includes(batchSize) && (!Number.isFinite(Number(batchSize)) || Number(batchSize) <= 0)) {
    throw new TypeError('batchSize must be a positive number, inventory, or max')
  }

  return {
    target: { item: target.item, amount: target.amount ?? 'all' },
    sources,
    craftingTable: options.craftingTable || options.table || null,
    output,
    leftovers,
    inventoryBuffer,
    keep: options.keep || [],
    protect: options.protect || [],
    baseItems: inferredBaseItems,
    recursive: options.recursive !== false,
    preflight: options.preflight !== false,
    flushOutputEachCycle: options.flushOutputEachCycle !== false,
    bufferEachCycle: options.bufferEachCycle !== false,
    repeat: options.repeat === true,
    repeatDelayMs: options.repeatDelayMs ?? 2000,
    cycleDelayMs: options.cycleDelayMs ?? 50,
    batchSize,
    maxCycles: options.maxCycles == null ? Infinity : Math.max(1, Number(options.maxCycles)),
    mode: options.mode || 'adaptive',
    recipeId: options.recipeId,
    fallback: options.fallback !== false,
    fastTimeoutMs: options.fastTimeoutMs || 2500,
    resumeAfterDeath: options.resumeAfterDeath !== false,
    respawnTimeoutMs: options.respawnTimeoutMs || 60000,
    afterRespawnDelayMs: options.afterRespawnDelayMs || 500
  }
}

function resolveCycleBatchSize ({ value, planner, bot, target, tableAvailable }) {
  if (!['inventory', 'max'].includes(value)) return Math.max(1, Number(value))

  try {
    const recipe = planner.chooseRecipe(target.id, { counts: inventoryCounts(bot), tableAvailable })
    const requirements = planner.requirements(recipe)
    if (requirements.length !== 1) return 64

    const requirement = requirements[0]
    const inventoryStart = Number(bot.inventory.inventoryStart ?? 9)
    const inventoryEnd = Number(bot.inventory.inventoryEnd ?? 45)
    const slots = Math.max(1, inventoryEnd - inventoryStart)
    const material = bot.registry.items[requirement.id]
    const stackSize = Math.max(1, Number(material?.stackSize || 64))
    const outputPerOperation = Math.max(1, Number(recipe.result?.count || 1))
    const rawCapacity = slots * stackSize
    return Math.max(1, Math.floor(rawCapacity / Math.max(1, requirement.count)) * outputPerOperation)
  } catch {
    return 64
  }
}

function detectAutomaticShopIngredients ({ planner, bot, target, sources, tableAvailable }) {
  const hasAutomaticShop = (sources || []).some(source => {
    if ((source.type || 'inventory') !== 'shop') return false
    const hasExplicitProduct = source.product != null || source.item != null || Array.isArray(source.items)
    return !hasExplicitProduct && source.autoIngredients !== false
  })
  if (!hasAutomaticShop) return []
  const directRecipe = planner.chooseRecipe(target.id, {
    counts: inventoryCounts(bot),
    tableAvailable
  })
  return planner.requirements(directRecipe)
}

module.exports = {
  ProductionJob,
  normalizeProductionOptions,
  detectAutomaticShopIngredients,
  resolveCycleBatchSize
}
