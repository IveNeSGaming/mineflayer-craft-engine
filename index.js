'use strict'

const { CraftEngine } = require('./lib/core/CraftEngine')
const { CraftSupervisor } = require('./lib/core/CraftSupervisor')

function plugin (bot, options = {}) {
  if (bot.craftEngine) return
  bot.craftEngine = new CraftEngine(bot, options)
}

plugin.CraftEngine = CraftEngine
plugin.CraftSupervisor = CraftSupervisor
plugin.createSupervisor = options => new CraftSupervisor(plugin, options)
module.exports = plugin
