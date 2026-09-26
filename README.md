# mineflayer-craft-engine

## Windows installation fix

This release uses the public npm registry. On Windows, run:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\install-clean.ps1
```

Or follow `INSTALL_WINDOWS.md`. Do not run tests until `npm install` finishes successfully.


Mineflayer botlari uchun tez crafting va avtomatik ishlab chiqarish paketi.

Paket quyidagi ishlarni bitta API orqali bajaradi:

- inventorydagi materiallardan craft;
- Recipe Book paketi orqali tez craft;
- fast usul ishlamasa avtomatik safe fallback;
- chest/barrel/shulker/ender chestdan material olish;
- bir nechta bosqichli recursive craft: `log → planks → sticks → target`;
- `/is shop ores` kabi GUI shoplardan xarid qilish;
- tayyor mahsulotni boshqa chestga joylash;
- keraksiz itemlarni alohida chestga solish;
- uzluksiz production loop;
- pause/resume/stop, status, metrics va checkpoint;
- o‘limdan keyin bir connection ichida ishni davom ettirish.

## Muhim tezlik izohi

`mode: 'fast'` yoki `mode: 'adaptive'` Minecraft Recipe Book protokolidagi
`craft_recipe_request` paketidan foydalanadi. Server retseptni tanisa va bot uchun
retsept ochilgan bo‘lsa, server crafting gridni o‘zi to‘ldiradi. Natija sloti
shift-click qilinadi.

Bu Item Scroller usuliga yaqin tezlik beradi, ammo internet ping, server TPS,
inventory tasdiqlashi va server cheklovlari sababli to‘liq jarayonni 1 ms ichida
yakunlash kafolatlanmaydi.

## Talablar

- Node.js 18 yoki yangi;
- Mineflayer;
- tavsiya etilgan Minecraft versiya: Java 1.18.2;
- bot chestlar orasida yurishi kerak bo‘lsa `mineflayer-pathfinder`.

## O‘rnatish

NPM orqali:

```bash
npm install mineflayer-craft-engine mineflayer
```

ZIP yoki lokal papkadan:

```bash
npm install ./mineflayer-craft-engine
```

Pathfinder kerak bo‘lsa:

```bash
npm install mineflayer-pathfinder
```

## Eng oddiy foydalanish

```js
const mineflayer = require('mineflayer')
const craftEngine = require('mineflayer-craft-engine')

const bot = mineflayer.createBot({
  host: 'localhost',
  username: 'CraftBot',
  version: '1.18.2'
})

bot.loadPlugin(craftEngine)

bot.once('spawn', async () => {
  const result = await bot.craftEngine.craft({
    item: 'emerald_block',
    amount: 'all',
    table: [-749, 88, -6335],
    mode: 'adaptive'
  })

  console.log(result)
})
```

## Craft rejimlari

### `adaptive` — tavsiya qilinadi

Avval Recipe Book fast usulini sinaydi. Server qabul qilmasa yoki natija kelmasa,
Mineflayer `bot.craft()` usuliga avtomatik qaytadi.

```js
mode: 'adaptive'
```

### `fast`

Fast usul ustuvor. Default holatda xato bo‘lsa fallback qiladi.
Fallbackni o‘chirish:

```js
mode: 'fast',
fallback: false
```

### `safe`

Faqat Mineflayerning ishonchli, lekin sekinroq `bot.craft()` funksiyasidan
foydalanadi.

```js
mode: 'safe'
```

## Recursive crafting

Inventoryda tayyor ingredient bo‘lmasa, paket oraliq retseptlarni ham craft qiladi.

```js
await bot.craftEngine.craft({
  item: 'stick',
  amount: 64,
  recursive: true,
  mode: 'adaptive'
})
```

Misol zanjir:

```text
oak_log → oak_planks → stick
```

Rejani craft qilmasdan ko‘rish:

```js
console.log(bot.craftEngine.plan({
  item: 'piston',
  amount: 64,
  craftingTable: [0, 64, 0]
}))
```

## Chestdan olib, craft qilib, boshqa chestga solish

```js
const { pathfinder } = require('mineflayer-pathfinder')

bot.loadPlugin(pathfinder)
bot.loadPlugin(craftEngine)

await bot.craftEngine.production({
  target: {
    item: 'emerald_block',
    amount: 'all'
  },

  sources: [
    { type: 'inventory' },
    {
      type: 'chest',
      position: [-749, 88, -6334],
      items: ['emerald']
    }
  ],

  craftingTable: [-749, 88, -6335],

  output: {
    type: 'chest',
    position: [-749, 88, -6331]
  },

  leftovers: {
    type: 'chest',
    position: [-749, 88, -6332]
  },

  keep: ['diamond_pickaxe', 'netherite_pickaxe'],
  recursive: true,
  mode: 'adaptive',
  repeat: true,
  repeatDelayMs: 1500,
  batchSize: 2304
})
```

## `/is shop ores` GUI shop

Har bir serverning GUI nomi va slotlari boshqacha. Quyidagi qiymatlarni serveringizga
moslaysiz:

```js
await bot.craftEngine.production({
  target: {
    item: 'emerald_block',
    amount: 'all'
  },

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
  output: {
    type: 'chest',
    position: [-749, 88, -6331]
  },
  mode: 'adaptive',
  repeat: true
})
```

Agar xariddan keyin tasdiqlash oynasi ochilsa:

```js
{
  type: 'shop',
  adapter: 'command-gui',
  command: '/is shop ores',
  itemSlot: 22,
  click: 'left',
  confirmSlot: 13,
  confirmDelayMs: 100,
  amountPerClick: 64
}
```

## Custom shop adapter

```js
bot.craftEngine.registerShopAdapter('my-shop', {
  async purchase ({ bot, source, amount, helpers }) {
    const opened = helpers.waitForEvent(bot, 'windowOpen', {
      timeout: 5000,
      predicate: window => String(window.title).includes('Ores')
    })

    bot.chat('/is shop ores')
    const [window] = await opened

    const clicks = Math.ceil(Number(amount) / 64)
    for (let i = 0; i < clicks; i++) {
      await bot.clickWindow(source.itemSlot, 0, 1)
      await helpers.sleep(50)
    }

    bot.closeWindow(window)
  }
})
```

Keyin:

```js
sources: [
  {
    type: 'shop',
    adapter: 'my-shop',
    itemSlot: 22
  }
]
```

## Serverning custom recipe ID qiymati

Server yuborgan `declare_recipes` paketidan recipe ID avtomatik saqlanadi. Ayrim
custom serverlarda IDni qo‘lda yozish kerak bo‘lishi mumkin:

```js
bot.craftEngine.registerRecipeId(
  'emerald_block',
  'server:compressed_emerald'
)
```

Yoki bitta craft chaqirig‘ida:

```js
await bot.craftEngine.craft({
  item: 'emerald_block',
  amount: 'all',
  table: [0, 64, 0],
  recipeId: 'server:compressed_emerald',
  mode: 'fast'
})
```

## Custom crafting recipe

```js
bot.craftEngine.registerRecipe({
  id: 'server:compressed_emerald',
  recipeId: 'server:compressed_emerald',
  result: {
    item: 'emerald',
    count: 1
  },
  shape: [
    ['emerald_block', 'emerald_block', 'emerald_block'],
    ['emerald_block', 'emerald_block', 'emerald_block'],
    ['emerald_block', 'emerald_block', 'emerald_block']
  ],
  requiresTable: true
})
```

## Reconnect supervisor

Mineflayer connection tugaganda eski `bot` obyektini qayta ulab bo‘lmaydi. Paketdagi
supervisor yangi bot yaratadi, pluginlarni qayta yuklaydi va oxirgi checkpointdan
productionni qayta boshlaydi.

```js
const supervisor = craftEngine.createSupervisor({
  createBot: () => mineflayer.createBot({
    host: 'localhost',
    username: 'CraftBot',
    version: '1.18.2'
  }),

  configure: bot => bot.loadPlugin(pathfinder),

  production: {
    target: { item: 'emerald_block', amount: 'all' },
    sources: [
      { type: 'chest', position: [-749, 88, -6334], items: ['emerald'] }
    ],
    craftingTable: [-749, 88, -6335],
    output: { type: 'chest', position: [-749, 88, -6331] },
    repeat: true,
    mode: 'adaptive'
  },

  reconnectDelayMs: 5000,
  reconnectOnJobError: true
})

supervisor.start()
```

`baseItems` yordamida recursive planner qaysi itemlarni tashqi xomashyo deb
hisoblashi kerakligini aniq belgilash mumkin:

```js
baseItems: ['iron_ingot', 'redstone', 'cobblestone', 'oak_planks']
```

Chest source ichida `items` ko‘rsatilsa, ular avtomatik `baseItems` sifatida olinadi.
Generic chestda `items` yozilmasa, paket chest tarkibini bir marta tekshirib, mavjud
itemlarni xomashyo sifatida aniqlaydi.

## Production boshqaruvi

```js
bot.craftEngine.pause()
bot.craftEngine.resume()
bot.craftEngine.stop()

console.log(bot.craftEngine.getStatus())
console.log(bot.craftEngine.getMetrics())
console.log(bot.craftEngine.getCheckpoint())
```

## Eventlar

```js
bot.craftEngine.on('jobStart', console.log)
bot.craftEngine.on('state', console.log)
bot.craftEngine.on('sourceUsed', console.log)
bot.craftEngine.on('craftComplete', console.log)
bot.craftEngine.on('outputStored', console.log)
bot.craftEngine.on('fastFallback', console.log)
bot.craftEngine.on('materialsMissing', console.log)
bot.craftEngine.on('jobError', console.error)
bot.craftEngine.on('jobComplete', console.log)
bot.craftEngine.on('shopBudgetExceeded', console.warn)
bot.craftEngine.on('recipeMismatch', console.warn)
```

## Eski API bilan moslik

Birinchi MVP konfiguratsiyasi ham ishlaydi:

```js
await bot.craftEngine.production({
  item: 'emerald_block',
  amount: 'all',
  sourceItem: 'emerald',
  sourceChest: [-749, 88, -6334],
  craftingTable: [-749, 88, -6335],
  outputChest: [-749, 88, -6331],
  mode: 'adaptive'
})
```

## Test

```bash
npm install
npm run check
npm test
```

## Hozirgi real cheklovlar

- Fast crafting uchun server recipe-book requestni qabul qilishi va retsept bot uchun
  ochilgan bo‘lishi kerak. Aks holda `adaptive` safe rejimga o‘tadi.
- Custom GUI shop konfiguratsiyasi serverga moslashtiriladi; barcha serverlarda bir
  xil slot yoki title bo‘lmaydi.
- Mineflayer bot obyekti connection tugagandan keyin o‘zini yangidan yarata olmaydi.
  Paket o‘lim/respawnni bir connection ichida tiklaydi va checkpoint beradi;
  to‘liq reconnectni botni yaratadigan tashqi supervisor bajarishi kerak.
- Raw packet tezligi serverning TPS, ping va click-rate cheklovlaridan yuqori bo‘la
  olmaydi.
- Server qoidalarida bot va avtomatlashtirishga ruxsat borligini tekshiring.

## Faqat kerakli materialni to'ldirish (`ensureStock`, v0.7.0)

To'liq `production()` siklisiz, faqat "shu itemdan kamida N dona bo'lsin" deb, chestdan yoki shopdan (yoki ikkalasidan navbat bilan) to'ldirish kerak bo'lsa:

```js
const result = await bot.craftEngine.ensureStock('netherite_scrap', 4, [
  { type: 'chest', position: [-749, 88, -6334], items: ['netherite_scrap'] },
  {
    type: 'shop',
    command: '/is shop Ores',
    titleIncludes: 'Ores',
    product: 'netherite_scrap',
    amountPerClick: 1,
    maxClicks: 4
  }
])

console.log(result) // { item, have, acquired, ok }
```

Agar inventarda allaqachon yetarli bo'lsa, `sources` umuman ishga tushmaydi.

## Shop xarid byudjeti (v0.7.0)

`shop` source'ga `costPerUnit` (bir dona narxi) va `maxSpend` (jami ruxsat etilgan xarajat) qo'shsangiz, byudjet tugagach xarid to'xtaydi va so'ralgan miqdor qolgan byudjetga moslab qisqartiriladi:

```js
sources: [
  {
    type: 'shop',
    command: '/is shop Ores',
    product: 'emerald',
    amountPerClick: 64,
    maxClicks: 10,
    costPerUnit: 5,
    maxSpend: 5000
  }
]
```

Byudjet **faqat jarayon xotirasida** (in-memory) kuzatiladi — hech qanday faylga yozilmaydi, bot qayta ishga tushganda nolga qaytadi:

```js
bot.craftEngine.shops.getSpend('/is shop Ores') // hozirgi sikldagi jami sarf
bot.craftEngine.shops.resetSpend('/is shop Ores') // yoki resetSpend() — hammasini
bot.craftEngine.on('shopBudgetExceeded', ({ source, budgetKey, spent, maxSpend }) => {
  console.log(`${budgetKey}: byudjet tugadi (${spent}/${maxSpend})`)
})
```

## Retsept nomuvofiqligi ogohlantirishi (`recipeMismatch`, v0.7.0)

Server e'lon qilgan retsept (`declare_recipes`) natija miqdori kutubxona tanlagan retseptnikidan farq qilsa (masalan custom server retsepti mineflayer'ning statik ma'lumotidan boshqacha bo'lsa), bu endi jim qolib "Not enough materials" kabi tushunarsiz xatolarga olib kelmaydi — aniq ogohlantirish beriladi:

```js
bot.craftEngine.on('recipeMismatch', ({ item, expectedCount, declaredCount, recipeId }) => {
  console.warn(`${item}: kutubxona ${expectedCount} dona kutgan edi, server ${declaredCount} deb e'lon qildi (${recipeId})`)
})
```

## Konfiguratsiyani tekshirish (`validate`, v0.7.0)

`production()` ni ishga tushirishdan OLDIN, dunyoga tegmasdan (hech narsa ochilmaydi, hech narsa sotib olinmaydi) konfiguratsiyani tekshirish:

```js
const result = await bot.craftEngine.validate({
  target: { item: 'emerald_block', amount: 'all' },
  craftingTable: [-749, 88, -6335],
  sources: [
    { type: 'chest', position: [-749, 88, -6334], items: ['emerald'] }
  ],
  output: { type: 'chest', position: [-749, 88, -6331] }
})

if (!result.ok) {
  for (const issue of result.issues) {
    console.error(`[${issue.code}] ${issue.field}: ${issue.message}`)
  }
}
```

Tekshiradigan narsalar: `craftingTable` koordinatasida haqiqatan `crafting_table` bormi, har bir chest/shop source va destination to'g'ri konfiguratsiya qilinganmi (masalan shop source'da `command` bormi), va maqsad item uchun umuman retsept topiladimi.

## Litsenziya

MIT

## Automatic shop ingredient + chest range (v0.6.0)

When the shop source has no fixed `product` or `itemSlot`, the engine uses the target recipe's direct ingredients. For example, `gold_block` automatically requests `gold_ingot` and searches the shop GUI for that item.

```js
await bot.craftEngine.production({
  target: { item: 'gold_block', amount: 'all' },
  sources: [
    { type: 'inventory' },
    {
      type: 'shop',
      command: '/is shop Ores',
      titleIncludes: 'Ores',
      autoIngredients: true,
      autoFind: true,
      click: 'shift-left',
      amountPerClick: 64,
      maxClicks: 9
    }
  ],
  craftingTable: [2184, 11, 4611],
  output: {
    type: 'container-range',
    start: [2183, 12, 4612],
    end: [2190, 12, 4612]
  },
  batchSize: 64,
  repeat: true
})
```

The range is inclusive. Full containers are skipped and the engine continues with the next chest. If a custom shop GUI cannot be matched by item name, use `itemSlots`, for example `{ gold_ingot: 20, emerald: 22 }`.
