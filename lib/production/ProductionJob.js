'use strict'

const { EventEmitter } = require('events')
const { resolveItem, inventoryCounts, itemMatches, countItem } = require('../utils/items')
const { waitForEvent } = require('../utils/async')
const { error } = require('../core/errors')

const FINISHED_STATES = ['completed', 'failed', 'stopped']

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
    if (FINISHED_STATES.includes(this.state) || this.cancelled) return
    this.paused = true
    this.setState('paused')
  }

  resume () {
    if (!this.paused) return
    this.paused = false
    this.emit('_resume')
  }

  stop () {
    if (FINISHED_STATES.includes(this.state)) return
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
    const requested = this.options.target.amount
    let remaining = requested === 'all' ? Infinity : Number(requested)
    const tableAvailable = Boolean(this.options.craftingTable)

    this.setState('running', { target: target.name })
    this.engine.emit('jobStart', { job: this, target: target.name, amount: requested })

    try {
      const { baseItemIds, productionSelectors } = await this.discoverMaterials(target, tableAvailable)

      if (this.options.preflight) {
        this.setState('preflight')
        await this.flushExistingOutput(target, 'startup')
        await this.bufferUnrelatedItems(productionSelectors, 'startup')
      }

      while (!this.cancelled && remaining > 0 && this.cycles < this.options.maxCycles) {
        if (!await this.waitIfPaused()) break
        await this.ensureAlive()
        if (this.cancelled) break

        const deathsBefore = this.engine.deaths || 0
        try {
          if (this.options.flushOutputEachCycle) await this.flushExistingOutput(target, 'cycle-start')
          if (this.options.bufferEachCycle) await this.bufferUnrelatedItems(productionSelectors, 'cycle-start')

          this.cycles++
          const configuredBatch = resolveCycleBatchSize({
            value: this.options.batchSize,
            planner: this.engine.planner,
            bot: this.bot,
            target,
            tableAvailable
          })
          const wantedThisCycle = remaining === Infinity
            ? configuredBatch
            : Math.min(remaining, configuredBatch)
          const countsBeforeAcquire = inventoryCounts(this.bot)
          // Never plan more than the inventory can hold: a completely full
          // inventory leaves no slot for the first crafted item and safe
          // crafting then fails with "destination full".
          const cycleRequested = this.inventoryFitBatch(target, wantedThisCycle, countsBeforeAcquire, tableAvailable, baseItemIds)

          this.setState('planning', { cycle: this.cycles, requested: cycleRequested })
          const requirements = this.engine.planner.leafRequirements(target.id, cycleRequested, {
            counts: countsBeforeAcquire,
            tableAvailable,
            baseItemIds
          })

          this.setState('acquiring', { requirements })
          await this.engine.sources.acquireRequirements(requirements, this.options.sources, { required: false })
          // Optional sources swallow their own errors; a death while acquiring
          // must still interrupt the cycle instead of looking like "no materials".
          this.assertNoDeathSince(deathsBefore)

          const possible = this.engine.planner.maxRecursiveOutput(
            target.id,
            cycleRequested,
            inventoryCounts(this.bot),
            { tableAvailable, baseItemIds }
          )

          if (possible <= 0) {
            // A previous interrupted run may have left finished output in inventory.
            const flushed = await this.flushExistingOutput(target, 'no-materials')
            if (flushed > 0) {
              await this.pausableSleep(this.options.cycleDelayMs)
              continue
            }

            this.engine.emit('materialsMissing', { job: this, target: target.name, requirements })
            if (this.options.repeat) {
              this.setState('waiting_materials')
              await this.pausableSleep(this.options.repeatDelayMs)
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
          if (crafted <= 0) this.assertNoDeathSince(deathsBefore)
          if (crafted <= 0) {
            const flushed = await this.flushExistingOutput(target, 'no-craft-progress')
            if (flushed > 0) continue
            if (this.options.repeat) {
              this.setState('waiting_no_progress')
              await this.pausableSleep(this.options.repeatDelayMs)
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

          if (remaining > 0) await this.pausableSleep(this.options.cycleDelayMs)
        } catch (cause) {
          // Dying mid-cycle closes windows and aborts transfers. With
          // resumeAfterDeath the cycle is retried after respawn instead of
          // failing the whole job.
          const died = this.engine.dead || (this.engine.deaths || 0) !== deathsBefore
          if (!died || !this.options.resumeAfterDeath || this.cancelled) throw cause
          this.engine.emit('cycleInterrupted', { job: this, reason: 'death', cycle: this.cycles, error: cause })
        }
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

  /**
   * Works out which items are "base" materials (acquired from sources, never
   * crafted) and which inventory items must be protected from buffering.
   */
  async discoverMaterials (target, tableAvailable) {
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
        tableAvailable
      })
      directIngredients = this.engine.planner.requirements(directRecipe)

      // Direct ingredients only become base items when an automatic shop will
      // buy them (gold_block -> buy gold_ingot, not gold_nugget). Treating
      // them as base unconditionally broke recursive chains such as
      // oak_log (chest) -> oak_planks -> stick.
      const automaticShopIngredients = detectAutomaticShopIngredients({
        planner: this.engine.planner,
        bot: this.bot,
        target,
        sources: this.options.sources,
        tableAvailable
      })
      for (const requirement of automaticShopIngredients) {
        if (!discoveredBaseItems.includes(requirement.id)) discoveredBaseItems.push(requirement.id)
      }
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
    return { baseItemIds, productionSelectors }
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

  assertNoDeathSince (deathsBefore) {
    if (this.engine.dead || (this.engine.deaths || 0) !== deathsBefore) {
      throw error('CYCLE_INTERRUPTED', 'Bot died during the production cycle')
    }
  }

  /**
   * Largest output amount (<= wanted) whose missing leaf materials fit into
   * the free inventory space while keeping one slot free for crafted output.
   */
  inventoryFitBatch (target, wanted, counts, tableAvailable, baseItemIds) {
    const inventory = this.bot.inventory
    const start = Number(inventory.inventoryStart ?? 9)
    const end = Number(inventory.inventoryEnd ?? 45)
    if (!Array.isArray(inventory.slots) || !Number.isFinite(wanted) || wanted <= 1) return wanted

    let emptySlots = 0
    const partialRoom = new Map()
    for (let slot = start; slot < end; slot++) {
      const stack = inventory.slots[slot]
      if (!stack) {
        emptySlots++
        continue
      }
      const size = Number(stack.stackSize || this.bot.registry.items[stack.type]?.stackSize || 64)
      partialRoom.set(stack.type, (partialRoom.get(stack.type) || 0) + Math.max(0, size - stack.count))
    }
    const usableSlots = emptySlots - 1

    const fits = amount => {
      let leaves
      try {
        leaves = this.engine.planner.leafRequirements(target.id, amount, { counts, tableAvailable, baseItemIds })
      } catch {
        return true
      }
      let slots = 0
      for (const leaf of leaves) {
        const size = Math.max(1, Number(this.bot.registry.items[leaf.id]?.stackSize || 64))
        slots += Math.ceil(Math.max(0, leaf.count - (partialRoom.get(leaf.id) || 0)) / size)
      }
      return slots <= usableSlots
    }

    if (fits(wanted)) return wanted
    let low = 1
    let high = wanted - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (fits(mid)) low = mid
      else high = mid - 1
    }
    return low
  }

  /** Waits while paused. There is no time limit: a job may stay paused indefinitely. */
  async waitIfPaused () {
    while (this.paused && !this.cancelled) {
      await waitForEvent(this, '_resume', { timeout: 0 })
    }
    return !this.cancelled
  }

  /** Sleeps, but wakes up immediately when the job is stopped. */
  async pausableSleep (ms) {
    if (!(ms > 0) || this.cancelled) return
    let timer
    let onWake
    try {
      await new Promise(resolve => {
        timer = setTimeout(resolve, ms)
        onWake = () => { if (this.cancelled) resolve() }
        this.on('_resume', onWake)
      })
    } finally {
      clearTimeout(timer)
      this.removeListener('_resume', onWake)
    }
  }

  async ensureAlive () {
    if (!this.engine.dead) return
    if (!this.options.resumeAfterDeath) throw error('BOT_DEAD', 'Bot died during production')
    this.setState('waiting_respawn')
    await waitForEvent(this.bot, 'spawn', { timeout: this.options.respawnTimeoutMs })
    this.engine.dead = false
    await this.pausableSleep(this.options.afterRespawnDelayMs)
  }
}

function normalizeProductionOptions (options = {}) {
  const target = options.target || { item: options.item, amount: options.amount ?? 'all' }
  if (!target?.item) throw new TypeError('production() requires target.item or item')
  const amount = target.amount ?? 'all'
  if (amount !== 'all' && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
    throw new TypeError('target.amount must be a positive number or all')
  }

  const sources = options.sources ? [...options.sources] : []
  if (options.sourceChest) {
    sources.push({
      type: 'chest',
      position: options.sourceChest,
      item: options.sourceItem
    })
  }
  if (!sources.some(source => source && source.type === 'inventory')) sources.unshift({ type: 'inventory' })

  const output = options.output || (options.outputChest ? { type: 'chest', position: options.outputChest } : null)
  const leftovers = options.leftovers || (options.leftoversChest ? { type: 'chest', position: options.leftoversChest } : null)
  const inventoryBuffer = options.inventoryBuffer || options.buffer || options.temporaryChest || null

  const inferredBaseItems = [...(options.baseItems || [])]
  for (const source of sources) {
    if (!source) continue
    const values = source.items || (source.item != null ? [source.item] : source.product != null ? [source.product] : [])
    for (const value of values) {
      if ((typeof value === 'string' || typeof value === 'number') && !inferredBaseItems.includes(value)) inferredBaseItems.push(value)
    }
  }

  const batchSize = options.batchSize == null ? 2304 : options.batchSize
  if (!['inventory', 'max'].includes(batchSize) && (!Number.isFinite(Number(batchSize)) || Number(batchSize) <= 0)) {
    throw new TypeError('batchSize must be a positive number, inventory, or max')
  }

  let maxCycles = Infinity
  if (options.maxCycles != null) {
    maxCycles = Number(options.maxCycles)
    if (!(maxCycles >= 1)) throw new TypeError('maxCycles must be a number >= 1')
  }

  return {
    target: { item: target.item, amount },
    sources: sources.filter(Boolean),
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
    repeatDelayMs: nonNegative(options.repeatDelayMs, 2000),
    cycleDelayMs: nonNegative(options.cycleDelayMs, 50),
    batchSize,
    maxCycles,
    mode: options.mode || 'adaptive',
    recipeId: options.recipeId,
    fallback: options.fallback !== false,
    fastTimeoutMs: options.fastTimeoutMs || 2500,
    resumeAfterDeath: options.resumeAfterDeath !== false,
    respawnTimeoutMs: options.respawnTimeoutMs || 60000,
    afterRespawnDelayMs: options.afterRespawnDelayMs || 500
  }
}

function nonNegative (value, fallback) {
  if (value == null) return fallback
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
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
