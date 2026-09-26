import type { Bot, BotOptions } from 'mineflayer'
import { EventEmitter } from 'events'

declare function plugin(bot: Bot, options: BotOptions): void

declare namespace plugin {
  type Position = [number, number, number] | { x: number; y: number; z: number }
  type CraftMode = 'safe' | 'fast' | 'adaptive'
  type ItemSelector = string | number | {
    name?: string
    id?: number
    metadata?: number
    displayName?: string
    displayNameIncludes?: string
    loreIncludes?: string
  }

  interface CraftOptions {
    item: ItemSelector
    amount?: number | 'all'
    table?: Position
    craftingTable?: Position
    mode?: CraftMode
    recursive?: boolean
    preflight?: boolean
    flushOutputEachCycle?: boolean
    bufferEachCycle?: boolean
    recipeId?: string
    fallback?: boolean
    closeWindow?: boolean
    fastTimeoutMs?: number
    stableMs?: number
  }

  interface ChestSource {
    type: 'chest' | 'barrel' | 'shulker' | 'ender_chest' | 'container'
    position: Position
    item?: ItemSelector
    items?: Array<string | number>
    range?: number
  }


  interface ContainerRangeSource {
    type: 'range' | 'container-range' | 'container_range' | 'chest-range' | 'chest_range'
    start: Position
    end: Position
    item?: ItemSelector
    items?: Array<string | number>
    blockNames?: string[]
    includeShulkers?: boolean
    nearestFirst?: boolean
    minAvailable?: number
    minimumAvailable?: number
    minimumStack?: number
    required?: boolean
    optional?: boolean
  }

  interface ShopSource {
    type: 'shop'
    adapter?: string | ShopAdapter
    command?: string
    openCommand?: string
    titleIncludes?: string
    titleRegex?: string
    itemSlot?: number
    itemSlots?: Record<string, number>
    product?: ItemSelector
    autoFind?: boolean
    autoIngredients?: boolean
    click?: 'left' | 'right' | 'shift-left' | 'shift-right'
    amountPerClick?: number
    maxClicks?: number
    confirmSlot?: number
    clickDelayMs?: number
    verify?: boolean
    stopOnChat?: boolean
    stopOnChatPatterns?: Array<string | RegExp>
    /** In-memory spend tracking key; defaults to command/openCommand/adapter. */
    budgetKey?: string
    /** Price of a single unit, in whatever currency your server uses. */
    costPerUnit?: number
    /** Total spend allowed for this budgetKey before purchases are refused. Resets on process restart (in-memory only). */
    maxSpend?: number
  }

  interface CustomSource {
    type: 'custom'
    acquire(context: { bot: Bot; engine: CraftEngine; item: unknown; amount: number | 'all' }): Promise<number> | number
  }

  type Source = { type: 'inventory' } | ChestSource | ContainerRangeSource | ShopSource | CustomSource

  interface Destination {
    type?: 'inventory' | 'chest' | 'barrel' | 'shulker' | 'ender_chest' | 'container' | 'range' | 'container-range' | 'chest-range' | 'drop' | 'custom'
    position?: Position
    start?: Position
    end?: Position
    blockNames?: string[]
    includeShulkers?: boolean
    nearestFirst?: boolean
    settleDelayMs?: number
    deposit?: (context: unknown) => Promise<number> | number
  }

  interface ProductionOptions {
    target?: { item: ItemSelector; amount?: number | 'all' }
    item?: ItemSelector
    amount?: number | 'all'
    sources?: Source[]
    sourceChest?: Position
    sourceItem?: ItemSelector
    craftingTable?: Position
    output?: Destination
    outputChest?: Position
    leftovers?: Destination
    leftoversChest?: Position
    inventoryBuffer?: Destination
    buffer?: Destination
    temporaryChest?: Destination
    keep?: ItemSelector[]
    protect?: ItemSelector[]
    baseItems?: ItemSelector[]
    recursive?: boolean
    repeat?: boolean
    repeatDelayMs?: number
    cycleDelayMs?: number
    batchSize?: number | 'inventory' | 'max'
    maxCycles?: number
    mode?: CraftMode
    recipeId?: string
    fallback?: boolean
    fastTimeoutMs?: number
    resumeAfterDeath?: boolean
    respawnTimeoutMs?: number
    afterRespawnDelayMs?: number
  }

  interface ShopAdapter {
    purchase(context: {
      bot: Bot
      engine: CraftEngine
      source: ShopSource
      item: ItemSelector
      amount: number | 'all'
      helpers: Record<string, unknown>
    }): Promise<{ acquired?: number } | void>
  }


  interface SupervisorOptions {
    createBot(): Bot | Promise<Bot>
    production: ProductionOptions
    configure?: (bot: Bot, supervisor: CraftSupervisor) => void | Promise<void>
    beforeProduction?: (bot: Bot, supervisor: CraftSupervisor) => void | Promise<void>
    reconnectDelayMs?: number
    maxReconnects?: number
    reconnectOnJobError?: boolean
    resumeFixedAmount?: boolean
    startDelayMs?: number
    quitAfterComplete?: boolean
    checkpoint?: Record<string, unknown> | null
  }

  class CraftSupervisor extends EventEmitter {
    constructor(plugin: typeof import('.'), options: SupervisorOptions)
    bot: Bot | null
    checkpoint: Record<string, unknown> | null
    start(): Promise<this>
    stop(reason?: string): void
    getStatus(): Record<string, unknown>
  }

  function createSupervisor(options: SupervisorOptions): CraftSupervisor

  interface ValidationIssue {
    code: string
    message: string
    field: string | null
  }

  interface ValidationResult {
    ok: boolean
    issues: ValidationIssue[]
  }

  interface EnsureStockResult {
    item: string
    have: number
    acquired: number
    ok: boolean
  }

  class CraftEngine extends EventEmitter {
    constructor(bot: Bot, options?: Record<string, unknown>)
    bot: Bot
    craft(options: CraftOptions): Promise<{ item: string; requested: number | 'all'; crafted: number; mode: CraftMode }>
    production(options: ProductionOptions): Promise<{ item: string; requested: number | 'all'; totalCrafted: number; cycles: number; stopped: boolean }>
    /** Tops inventory up to minAmount using sources (chest and/or shop), without running a full production job. */
    ensureStock(item: ItemSelector, minAmount: number | 'all', sources?: Source[], options?: Record<string, unknown>): Promise<EnsureStockResult>
    /** Checks a production() config (crafting table, sources, destinations, recipe availability) without running it or touching the world. */
    validate(options: ProductionOptions): Promise<ValidationResult>
    plan(options: { item: ItemSelector; amount?: number | 'all'; table?: Position; craftingTable?: Position }): unknown
    registerRecipe(definition: Record<string, unknown>): unknown
    registerRecipeId(itemName: string, recipeId: string): void
    registerShopAdapter(id: string, adapter: ShopAdapter): ShopAdapter
    pause(): void
    resume(): void
    stop(): void
    getStatus(): Record<string, unknown>
    getMetrics(): Record<string, number | string>
    getCheckpoint(): Record<string, unknown> | null
    resync(delayMs?: number): Promise<Record<string, unknown>>
    dispose(): void
  }
}

declare module 'mineflayer' {
  interface Bot {
    craftEngine: plugin.CraftEngine
  }
}

export = plugin
