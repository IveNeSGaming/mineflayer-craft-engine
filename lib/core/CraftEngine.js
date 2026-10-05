'use strict'

const { EventEmitter } = require('events')
const { RecipeRegistry } = require('../recipes/RecipeRegistry')
const { RecipePlanner } = require('../recipes/RecipePlanner')
const { CraftingManager } = require('../crafting/CraftingManager')
const { ContainerManager } = require('../containers/ContainerManager')
const { ShopRegistry } = require('../shops/ShopRegistry')
const { SourceManager } = require('../sources/SourceManager')
const { DestinationManager } = require('../destinations/DestinationManager')
const { ProductionJob } = require('../production/ProductionJob')
const { sleep } = require('../utils/async')
const { resolveItem } = require('../utils/items')
const { validateProductionOptions } = require('./Validator')
const { error } = require('./errors')

class CraftEngine extends EventEmitter {
  constructor (bot, options = {}) {
    super()
    this.bot = bot
    this.options = options
    this.registry = new RecipeRegistry(bot)
    this.planner = new RecipePlanner(bot, this.registry)
    this.containers = new ContainerManager(bot, this)
    this.shops = new ShopRegistry(bot, this)
    this.sources = new SourceManager(bot, this.containers, this.shops, this)
    this.destinations = new DestinationManager(bot, this.containers, this)
    this.crafting = new CraftingManager(bot, this.registry, this.planner, this)
    this.currentJob = null
    this.lastCheckpoint = null
    this.dead = false
    this.deaths = 0
    this._queue = Promise.resolve()
    this.metrics = {
      craftCalls: 0,
      productionJobs: 0,
      craftedItems: 0,
      cycles: 0,
      fastFallbacks: 0,
      errors: 0,
      startedAt: new Date().toISOString()
    }

    this.on('fastFallback', () => { this.metrics.fastFallbacks++ })
    this.on('jobError', () => { this.metrics.errors++ })
    this._botListeners = {
      death: () => {
        this.dead = true
        this.deaths++
      },
      spawn: () => { this.dead = false },
      // A disconnected bot can never finish the job; stop it so the loop
      // exits instead of retrying against a dead connection.
      end: () => { this.currentJob?.stop() }
    }
    for (const [event, listener] of Object.entries(this._botListeners)) bot.on(event, listener)
  }

  runExclusive (operation) {
    const run = this._queue.then(operation, operation)
    this._queue = run.catch(() => {})
    return run
  }

  craft (options) {
    return this.runExclusive(async () => {
      this.metrics.craftCalls++
      const result = await this.crafting.craft(options)
      this.metrics.craftedItems += result.crafted
      return result
    })
  }

  production (options) {
    // Checked synchronously: a second call would otherwise wait in the queue
    // behind a (possibly endless) running job instead of failing fast.
    if (this._productionActive) {
      return Promise.reject(error('JOB_ACTIVE', 'A production job is already active'))
    }
    this._productionActive = true
    return this.runExclusive(async () => {
      const job = new ProductionJob(this, options)
      this.currentJob = job
      this.metrics.productionJobs++
      try {
        return await job.run()
      } finally {
        if (this.currentJob === job) this.currentJob = null
      }
    }).finally(() => { this._productionActive = false })
  }

  createProductionJob (options) {
    return new ProductionJob(this, options)
  }

  /*
   * Bir martalik "shu itemdan kamida N dona bo'lishi kerak" tekshiruvi —
   * to'liq production() siklisiz. Ichkarida SourceManager.acquire()ni
   * (production()ning o'zi ham ishlatadigan mexanizm) chaqiradi, shuning
   * uchun xohlasa chestdan, xohlasa shopdan (yoki ikkalasidan navbat
   * bilan) to'ldirishi mumkin — sources ro'yxati production()dagi bilan
   * bir xil formatda.
   */
  ensureStock (itemSelector, minAmount, sources = [], options = {}) {
    return this.runExclusive(async () => {
      const item = resolveItem(this.bot, itemSelector)
      if (minAmount !== 'all' && !Number.isFinite(Number(minAmount))) {
        throw new TypeError(`ensureStock() minAmount must be a number or 'all', got ${minAmount}`)
      }
      const target = minAmount === 'all' ? Infinity : Math.max(0, Number(minAmount))
      const have = this.bot.inventory.count(item.id, null)

      if (have >= target) {
        return { item: item.name, have, acquired: 0, ok: true }
      }

      const need = target === Infinity ? Infinity : target - have
      const result = await this.sources.acquire(item.id, need, sources, options)
      const total = this.bot.inventory.count(item.id, null)
      const ok = target === Infinity ? result.acquired > 0 : total >= target

      return { item: item.name, have: total, acquired: result.acquired, ok }
    })
  }

  /*
   * production() options'ni HAQIQATDA ishga tushirmasdan tekshiradi:
   * craftingTable/chest/shop pozitsiyalari haqiqiy bloklarga to'g'ri
   * keladimi, maqsad item uchun retsept topiladimi va h.k. Validator.js'ga
   * qarang. Bot dunyo holatini o'zgartirmaydi (hech qanday konteyner
   * ochilmaydi, xarid qilinmaydi) — shu sabab runExclusive() navbatiga
   * kirmaydi, boshqa ish davom etayotganda ham chaqirish mumkin.
   */
  async validate (options = {}) {
    return validateProductionOptions(this, options)
  }

  plan (options) {
    if (!options?.item) throw new TypeError('plan() requires item')
    return this.planner.describe(options.item, options.amount ?? 1, {
      tableAvailable: Boolean(options.table || options.craftingTable)
    })
  }

  registerRecipe (definition) {
    return this.registry.registerCustomRecipe(definition)
  }

  registerRecipeId (itemName, recipeId) {
    this.registry.registerRecipeId(itemName, recipeId)
  }

  registerShopAdapter (id, adapter) {
    return this.shops.register(id, adapter)
  }

  pause () {
    this.currentJob?.pause()
  }

  resume () {
    this.currentJob?.resume()
  }

  stop () {
    this.currentJob?.stop()
  }

  getStatus () {
    return this.currentJob?.status() || { state: 'idle', checkpoint: this.lastCheckpoint }
  }

  getMetrics () {
    return { ...this.metrics }
  }

  getCheckpoint () {
    return this.lastCheckpoint ? { ...this.lastCheckpoint } : null
  }

  async resync (delayMs = 150) {
    if (this.bot.currentWindow) this.bot.closeWindow(this.bot.currentWindow)
    await sleep(delayMs)
    return {
      window: this.bot.currentWindow?.id ?? null,
      inventoryItems: this.bot.inventory.items().length
    }
  }

  dispose () {
    this.stop()
    this.registry.dispose()
    for (const [event, listener] of Object.entries(this._botListeners)) this.bot.removeListener(event, listener)
    if (this.bot.craftEngine === this) delete this.bot.craftEngine
    this.removeAllListeners()
  }
}

module.exports = { CraftEngine }
