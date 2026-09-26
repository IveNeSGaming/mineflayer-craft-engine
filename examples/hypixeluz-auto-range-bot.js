'use strict'

const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const craftEngine = require('..')

const CONFIG = {
  host: 'hypixel.uz',
  port: 25566,
  username: 'IveNeS_Craft',
  version: '1.18.2',
  password: process.env.MC_PASSWORD || '',

  warpCommand: '/is warp Build',
  warpWaitMs: 5000,

  targetItem: 'emerald_block',
  craftingTable: [2184, 11, 4611],

  // Xomashyo bor chestlar hududi. Har bir chestda kamida 64 ta
  // kerakli material bo‘lsa, shopdan oldin shu chestdan olinadi.
  inputStart: [2180, 12, 4610],
  inputEnd: [2190, 12, 4616],

  // Tayyor blocklar ketma-ket joylanadigan chestlar.
  outputStart: [2180, 12, 4615],
  outputEnd: [2190, 12, 4615],

  // Botdagi boshqa itemlar ish boshida shu chestga saqlanadi.
  inventoryBuffer: [2183, 12, 4611],

  shop: {
    command: '/is shop Ores',
    titleIncludes: 'Ores',
    amountPerClick: 64,
    maxClicks: 36,
    clickDelayMs: 180,
    itemSlots: {
      emerald: 22
      // gold_ingot: 20,
      // iron_ingot: 21,
      // diamond: 23
    }
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function createBot () {
  const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: 'offline'
  })

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(craftEngine)

  let started = false

  bot.on('login', () => console.log(`[BOT] ${CONFIG.host}:${CONFIG.port}`))

  bot.on('spawn', async () => {
    if (started) return
    started = true

    try {
      const movements = new Movements(bot)
      movements.canDig = false
      movements.allow1by1towers = false
      movements.allowParkour = false
      bot.pathfinder.setMovements(movements)

      bot.craftEngine.on('state', event => console.log('[STATE]', event.state))
      bot.craftEngine.on('inventoryBuffered', event => console.log('[BUFFER]', event.amount, 'item saqlandi'))
      bot.craftEngine.on('rangeSourceTried', event => {
        if (event.moved > 0) console.log(`[INPUT] ${event.position} dan ${event.moved} olindi`)
      })
      bot.craftEngine.on('rangeDestinationTried', event => {
        console.log(`[OUTPUT] ${event.position} | moved=${event.moved}${event.full ? ' | FULL → keyingi chest' : ''}`)
      })
      bot.craftEngine.on('craftComplete', event => console.log('[CRAFT]', event.amount, event.item))
      bot.craftEngine.on('outputStored', event => console.log('[STORED]', event.amount, event.item, event.reason || ''))
      bot.craftEngine.on('sourceError', event => console.log('[SOURCE SKIP]', event.error?.message || event.error))
      bot.craftEngine.on('jobError', event => console.error('[JOB ERROR]', event.error?.message || event.error))

      await sleep(1500)
      if (CONFIG.password) {
        bot.chat(`/login ${CONFIG.password}`)
        await sleep(3500)
      }

      bot.chat(CONFIG.warpCommand)
      await sleep(CONFIG.warpWaitMs)
      console.log('[WARP]', bot.entity.position.floored())

      await bot.craftEngine.production({
        target: { item: CONFIG.targetItem, amount: 'all' },

        sources: [
          { type: 'inventory' },

          // Avval atrofdagi chestlardan xomashyo qidiradi.
          {
            type: 'container-range',
            start: CONFIG.inputStart,
            end: CONFIG.inputEnd,
            blockNames: ['chest', 'trapped_chest'],
            minAvailable: 64,
            nearestFirst: true,
            optional: true
          },

          // Chestlarda yetmasa shopdan oladi.
          {
            type: 'shop',
            adapter: 'command-gui',
            command: CONFIG.shop.command,
            titleIncludes: CONFIG.shop.titleIncludes,
            autoIngredients: true,
            autoFind: true,
            itemSlots: CONFIG.shop.itemSlots,
            click: 'shift-left',
            amountPerClick: CONFIG.shop.amountPerClick,
            maxClicks: CONFIG.shop.maxClicks,
            clickDelayMs: CONFIG.shop.clickDelayMs,
            stopOnChat: true,
            verify: true,
            closeWindow: true,
            optional: true
          }
        ],

        craftingTable: CONFIG.craftingTable,

        output: {
          type: 'container-range',
          start: CONFIG.outputStart,
          end: CONFIG.outputEnd,
          blockNames: ['chest', 'trapped_chest'],
          includeShulkers: false
        },

        inventoryBuffer: {
          type: 'chest',
          position: CONFIG.inventoryBuffer
        },

        // Ish boshlanishida mavjud targetlarni outputga soladi va
        // boshqa itemlarni buffer chestga ko‘chiradi.
        preflight: true,
        flushOutputEachCycle: true,
        bufferEachCycle: true,

        mode: 'fast',
        fallback: false,

        // 36 stack emerald → 256 emerald_block (4 stack).
        batchSize: 'inventory',

        repeat: true,
        repeatDelayMs: 2000,
        cycleDelayMs: 150,
        resumeAfterDeath: true
      })
    } catch (error) {
      console.error('[XATO]', error?.stack || error)
    }
  })

  const antiIdle = setInterval(() => {
    if (!bot.entity) return
    bot.swingArm('right')
    bot.setControlState('sneak', true)
    setTimeout(() => bot.setControlState('sneak', false), 300)
  }, 120000)

  bot.on('messagestr', message => console.log('[CHAT]', message))
  bot.on('kicked', reason => console.log('[KICKED]', reason))
  bot.on('error', error => console.error('[BOT ERROR]', error.message))
  bot.on('end', reason => {
    clearInterval(antiIdle)
    console.log('[END]', reason)
  })
}

createBot()
