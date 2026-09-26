'use strict'

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const craftEngine = require('..')

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || 'localhost',
  username: process.env.MC_USER || 'CraftBot',
  version: '1.18.2'
})

bot.loadPlugin(pathfinder)
bot.loadPlugin(craftEngine)

bot.once('spawn', async () => {
  const result = await bot.craftEngine.production({
    target: { item: 'emerald_block', amount: 'all' },
    sources: [
      { type: 'inventory' },
      { type: 'chest', position: [-749, 88, -6334], items: ['emerald'] }
    ],
    craftingTable: [-749, 88, -6335],
    output: { type: 'chest', position: [-749, 88, -6331] },
    leftovers: { type: 'chest', position: [-749, 88, -6332] },
    keep: ['diamond_pickaxe', 'netherite_pickaxe'],
    recursive: true,
    mode: 'adaptive',
    repeat: false,
    batchSize: 2304
  })
  console.log(result)
})
