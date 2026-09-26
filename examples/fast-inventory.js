'use strict'

const mineflayer = require('mineflayer')
const craftEngine = require('..')

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || 'localhost',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USER || 'CraftBot',
  version: process.env.MC_VERSION || '1.18.2'
})

bot.loadPlugin(craftEngine)

bot.once('spawn', async () => {
  try {
    const result = await bot.craftEngine.craft({
      item: 'emerald_block',
      amount: 'all',
      table: [-749, 88, -6335],
      mode: 'adaptive'
    })
    console.log(result)
  } catch (error) {
    console.error(error)
  }
})
