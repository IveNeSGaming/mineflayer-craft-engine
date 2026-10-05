'use strict'

const { CraftEngine } = require('./lib/core/CraftEngine')
const { CraftSupervisor } = require('./lib/core/CraftSupervisor')
const { CraftEngineError } = require('./lib/core/errors')

// Mineflayer calls plugins as plugin(bot, botOptions). Those options hold the
// account credentials and are not engine settings, so they are not forwarded.
function plugin (bot) {
  if (bot.craftEngine) return
  bot.craftEngine = new CraftEngine(bot)
}

plugin.CraftEngine = CraftEngine
plugin.CraftSupervisor = CraftSupervisor
plugin.CraftEngineError = CraftEngineError
plugin.createSupervisor = options => new CraftSupervisor(plugin, options)
module.exports = plugin
