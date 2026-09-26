'use strict'

const mineflayer = require('mineflayer')
const craftEngine = require('..')

const bot = mineflayer.createBot({ host: 'localhost', username: 'CraftBot', version: '1.18.2' })
bot.loadPlugin(craftEngine)

bot.craftEngine.registerShopAdapter('my-ores-shop', {
  async purchase ({ bot, source, amount, helpers }) {
    const opened = helpers.waitForEvent(bot, 'windowOpen', {
      timeout: 5000,
      predicate: window => String(window.title).includes('Ores')
    })
    bot.chat('/is shop ores')
    const [window] = await opened
    const clicks = Math.ceil(Number(amount) / 64)
    for (let i = 0; i < clicks; i++) {
      await bot.clickWindow(source.itemSlot ?? 22, 0, 1)
      await helpers.sleep(40)
    }
    bot.closeWindow(window)
  }
})

bot.once('spawn', async () => {
  await bot.craftEngine.production({
    target: { item: 'emerald_block', amount: 64 },
    sources: [{ type: 'shop', adapter: 'my-ores-shop', itemSlot: 22, amountPerClick: 64 }],
    craftingTable: [0, 64, 0],
    output: { type: 'chest', position: [1, 64, 0] }
  })
})
