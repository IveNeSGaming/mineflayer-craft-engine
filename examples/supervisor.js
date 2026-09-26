'use strict'

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const craftEngine = require('..')

const supervisor = craftEngine.createSupervisor({
  createBot: () => mineflayer.createBot({
    host: process.env.MC_HOST || 'localhost',
    username: process.env.MC_USER || 'CraftBot',
    password: process.env.MC_PASS,
    version: '1.18.2'
  }),

  configure: bot => {
    bot.loadPlugin(pathfinder)
  },

  beforeProduction: async bot => {
    if (process.env.MC_LOGIN_COMMAND) bot.chat(process.env.MC_LOGIN_COMMAND)
  },

  production: {
    target: { item: 'emerald_block', amount: 'all' },
    sources: [{ type: 'chest', position: [-749, 88, -6334], items: ['emerald'] }],
    craftingTable: [-749, 88, -6335],
    output: { type: 'chest', position: [-749, 88, -6331] },
    mode: 'adaptive',
    repeat: true
  },

  reconnectDelayMs: 5000,
  reconnectOnJobError: true,
  resumeFixedAmount: true
})

supervisor.on('disconnect', console.log)
supervisor.on('reconnecting', console.log)
supervisor.on('productionError', console.error)

supervisor.start().catch(console.error)
