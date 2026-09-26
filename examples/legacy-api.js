'use strict'

const mineflayer = require('mineflayer')
const craftEngine = require('..')

const bot = mineflayer.createBot({ host: 'localhost', username: 'CraftBot', version: '1.18.2' })
bot.loadPlugin(craftEngine)

bot.once('spawn', async () => {
  // 0.1.0 dagi eski config ham qo‘llanadi.
  console.log(await bot.craftEngine.production({
    item: 'emerald_block',
    amount: 'all',
    sourceItem: 'emerald',
    sourceChest: [-749, 88, -6334],
    craftingTable: [-749, 88, -6335],
    outputChest: [-749, 88, -6331],
    mode: 'adaptive'
  }))
})
