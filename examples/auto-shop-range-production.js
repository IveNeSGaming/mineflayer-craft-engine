'use strict'

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const craftEngine = require('..')

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || 'hypixel.uz',
  port: Number(process.env.MC_PORT || 25566),
  username: process.env.MC_USER || 'IveNeS_Craft',
  version: '1.18.2',
  auth: 'offline'
})

bot.loadPlugin(pathfinder)
bot.loadPlugin(craftEngine)

bot.once('spawn', async () => {
  // gold_block yozilsa planner gold_ingot kerakligini aniqlaydi.
  // itemSlot va product yozilmagan: shop oynasidan item avtomatik topiladi.
  await bot.craftEngine.production({
    target: {
      item: process.env.TARGET_ITEM || 'gold_block',
      amount: 'all'
    },

    sources: [
      { type: 'inventory' },
      {
        type: 'shop',
        adapter: 'command-gui',
        command: '/is shop Ores',
        titleIncludes: 'Ores',
        autoIngredients: true,
        autoFind: true,
        click: 'shift-left',
        amountPerClick: 64,
        maxClicks: 9,
        clickDelayMs: 150,
        verify: true,
        closeWindow: true

        // GUI custom bo‘lsa slotlarni qo‘lda xaritalash mumkin:
        // itemSlots: { emerald: 22, gold_ingot: 20, iron_ingot: 21 }
      }
    ],

    craftingTable: [2184, 11, 4611],

    // Start va end oralig‘idagi barcha chestlarga navbat bilan soladi.
    output: {
      type: 'container-range',
      start: [2183, 12, 4612],
      end: [2190, 12, 4612],
      blockNames: ['chest', 'trapped_chest'],
      includeShulkers: false
    },

    // leftovers kerak emas.
    mode: 'fast',
    fallback: false,
    batchSize: 64,
    repeat: true,
    repeatDelayMs: 1500
  })
})
