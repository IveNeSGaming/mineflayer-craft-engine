'use strict'

const { EventEmitter } = require('events')
const { sleep } = require('../utils/async')

class CraftSupervisor extends EventEmitter {
  constructor (plugin, options = {}) {
    super()
    if (typeof options.createBot !== 'function') throw new TypeError('createSupervisor() requires createBot()')
    if (!options.production) throw new TypeError('createSupervisor() requires production options')
    this.plugin = plugin
    this.options = options
    this.bot = null
    this.checkpoint = options.checkpoint || null
    this.stopped = true
    this.reconnects = 0
    this._launching = false
    this._timer = null
  }

  async start () {
    if (!this.stopped) return this
    this.stopped = false
    await this._launch()
    return this
  }

  stop (reason = 'Supervisor stopped') {
    this.stopped = true
    if (this._timer) clearTimeout(this._timer)
    this._timer = null
    try {
      this.bot?.craftEngine?.stop()
      this.bot?.quit?.(reason)
    } catch {}
    this.emit('stopped', { reason, checkpoint: this.checkpoint })
  }

  getStatus () {
    return {
      stopped: this.stopped,
      reconnects: this.reconnects,
      connected: Boolean(this.bot?.entity),
      username: this.bot?.username || null,
      checkpoint: this.checkpoint,
      job: this.bot?.craftEngine?.getStatus?.() || null
    }
  }

  async _launch () {
    if (this.stopped || this._launching) return
    this._launching = true
    try {
      const bot = await this.options.createBot()
      if (!bot?.loadPlugin) throw new TypeError('createBot() must return a Mineflayer bot')
      this.bot = bot
      bot.loadPlugin(this.plugin)
      if (typeof this.options.configure === 'function') await this.options.configure(bot, this)

      let ended = false
      bot.once('end', reason => {
        ended = true
        this.checkpoint = bot.craftEngine?.getCheckpoint?.() || this.checkpoint
        this.emit('disconnect', { reason, checkpoint: this.checkpoint })
        this._scheduleReconnect()
      })
      bot.on('error', cause => this.emit('botError', { error: cause }))

      bot.once('spawn', async () => {
        this.emit('spawn', { bot, reconnects: this.reconnects })
        try {
          if (typeof this.options.beforeProduction === 'function') {
            await this.options.beforeProduction(bot, this)
          }
          if (this.options.startDelayMs) await sleep(this.options.startDelayMs)
          const jobOptions = this._productionOptionsFromCheckpoint()
          const result = await bot.craftEngine.production(jobOptions)
          this.checkpoint = bot.craftEngine.getCheckpoint() || this.checkpoint
          this.emit('productionComplete', { result, checkpoint: this.checkpoint })
          if (this.options.quitAfterComplete) bot.quit('Production complete')
        } catch (cause) {
          this.checkpoint = bot.craftEngine?.getCheckpoint?.() || this.checkpoint
          this.emit('productionError', { error: cause, checkpoint: this.checkpoint })
          if (!ended && this.options.reconnectOnJobError) bot.quit('Restarting production job')
        }
      })
    } finally {
      this._launching = false
    }
  }

  _productionOptionsFromCheckpoint () {
    const source = this.options.production
    const job = {
      ...source,
      target: source.target ? { ...source.target } : undefined
    }
    if (!this.options.resumeFixedAmount || !this.checkpoint || this.checkpoint.remaining === 'all') return job
    if (job.target) job.target.amount = this.checkpoint.remaining
    else job.amount = this.checkpoint.remaining
    return job
  }

  _scheduleReconnect () {
    if (this.stopped) return
    const max = this.options.maxReconnects == null ? Infinity : Number(this.options.maxReconnects)
    if (this.reconnects >= max) {
      this.stopped = true
      this.emit('reconnectLimit', { reconnects: this.reconnects, checkpoint: this.checkpoint })
      return
    }
    this.reconnects++
    const delay = Number(this.options.reconnectDelayMs || 5000)
    this.emit('reconnecting', { attempt: this.reconnects, delay })
    this._timer = setTimeout(() => {
      this._timer = null
      this._launch().catch(error => {
        this.emit('supervisorError', { error })
        this._scheduleReconnect()
      })
    }, delay)
  }
}

module.exports = { CraftSupervisor }
