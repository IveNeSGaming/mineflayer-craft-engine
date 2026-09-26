'use strict'

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const craftEngine = require('..')

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || 'hypixel.uz',
  username: process.env.MC_USER || 'CrafterBot',
  version: '1.18.2'
})

bot.loadPlugin(pathfinder)
bot.loadPlugin(craftEngine)

bot.once('spawn', async () => {
  const result = await bot.craftEngine.production({
    target: { item: 'emerald_block', amount: 'all' },
    sources: [
      { type: 'inventory' },
      {
        type: 'shop',
        adapter: 'command-gui',
        command: '/is shop ores',
        titleIncludes: 'ores',
        product: 'emerald',
        itemSlot: 22,
        click: 'shift-left',
        amountPerClick: 64,
        maxClicks: 9,
        clickDelayMs: 50,
        verify: true
      }
    ],
    craftingTable: [-749, 88, -6335],
    output: { type: 'chest', position: [-749, 88, -6331] },
    leftovers: { type: 'chest', position: [-749, 88, -6332] },
    mode: 'adaptive',
    repeat: true,
    repeatDelayMs: 1500,
    batchSize: 576
  })
  console.log(result)
})
