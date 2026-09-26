'use strict'

const mineflayer = require('mineflayer')
const craftEngine = require('..')

const bot = mineflayer.createBot({ host: 'localhost', username: 'CraftBot', version: '1.18.2' })
bot.loadPlugin(craftEngine)

bot.once('spawn', async () => {
  // Inventoryda oak_log bo‘lsa, paket avval plank, keyin stick craft qiladi.
  const plan = bot.craftEngine.plan({ item: 'stick', amount: 64 })
  console.log('Plan:', plan)

  const result = await bot.craftEngine.craft({
    item: 'stick',
    amount: 64,
    recursive: true,
    mode: 'adaptive'
  })
  console.log(result)
})
