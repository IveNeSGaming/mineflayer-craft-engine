import type { Bot, BotOptions } from 'mineflayer'
import { EventEmitter } from 'events'

declare function plugin(bot: Bot, options?: BotOptions): void

declare namespace plugin {
  type Position = [number, number, number] | { x: number; y: number; z: number }
  type CraftMode = 'safe' | 'fast' | 'adaptive'
  type Amount = number | 'all'
  type ItemSelector = string | number | {
    name?: string
    id?: number
    metadata?: number
    displayName?: string
    displayNameIncludes?: string
    loreIncludes?: string
    nbtPredicate?: (nbt: unknown, stack: unknown) => boolean
  }

  type ErrorCode =
    | 'BLOCK_NOT_FOUND' | 'BOT_DEAD' | 'CONTAINER_OPEN_FAILED' | 'CONTAINER_RANGE_EMPTY'
    | 'CRAFT_NO_PROGRESS' | 'CYCLE_INTERRUPTED' | 'DESTINATION_FULL' | 'DESTINATION_RANGE_FULL'
    | 'FAST_NO_PROGRESS' | 'FAST_TIMEOUT' | 'FAST_UNSUPPORTED' | 'JOB_ACTIVE' | 'MISSING_MATERIAL'
    | 'NO_RECIPE' | 'OUT_OF_REACH' | 'PROTOCOL_UNAVAILABLE' | 'RANGE_TOO_LARGE' | 'RECIPE_CYCLE'
    | 'SHOP_ADAPTER_NOT_FOUND' | 'SHOP_ITEM_NOT_FOUND' | 'SHOP_NO_PROGRESS' | 'SOURCE_SHORTAGE'
    | 'SOURCE_TYPE_UNSUPPORTED' | 'TABLE_NOT_FOUND' | 'TABLE_REQUIRED' | 'WINDOW_CLOSED'

  class CraftEngineError extends Error {
    name: 'CraftEngineError'
    code: ErrorCode | string
    details: Record<string, unknown>
  }

  interface CraftOptions {
    item: ItemSelector
    amount?: Amount
    table?: Position
    craftingTable?: Position
    mode?: CraftMode
    recursive?: boolean
    recipeId?: string
    fallback?: boolean
    closeWindow?: boolean
    fastTimeoutMs?: number
    windowTimeoutMs?: number
    stableMs?: number
    /** Upper bound of recipe-book request passes; defaults to the number of operations. */
    maxFastPasses?: number
    /** Output per batch for recursive `amount: 'all'` (default 2304). */
    batchSize?: number
    /** Item ids that must be taken from inventory and never crafted. */
    baseItemIds?: number[]
    /** Delay after asking the server to return leftovers from the 2x2 grid (default 100). */
    gridReturnDelayMs?: number
    /** @deprecated production() option, ignored by craft(). */
    preflight?: boolean
    /** @deprecated production() option, ignored by craft(). */
    flushOutputEachCycle?: boolean
    /** @deprecated production() option, ignored by craft(). */
    bufferEachCycle?: boolean
  }

  interface SourceCommon {
    item?: ItemSelector
    items?: ItemSelector[]
    /** false = errors from this source are skipped instead of failing. */
    required?: boolean
    optional?: boolean
    enabled?: boolean
  }

  interface ContainerAccessOptions {
    /** Pathfinder goal distance (default 2). */
    range?: number
    attempts?: number
    retryDelayMs?: number
  }

  interface ChestSource extends SourceCommon, ContainerAccessOptions {
    type: 'chest' | 'barrel' | 'shulker' | 'ender_chest' | 'container'
    position: Position
  }

  interface RangeOptions {
    blockNames?: string[]
    includeShulkers?: boolean
    nearestFirst?: boolean
    /** Refuse ranges larger than this many blocks (default 131072). */
    maxRangeBlocks?: number
  }

  interface ContainerRangeSource extends SourceCommon, ContainerAccessOptions, RangeOptions {
    type: 'range' | 'container-range' | 'container_range' | 'chest-range' | 'chest_range'
    start: Position
    end: Position
    minAvailable?: number
    minimumAvailable?: number
    minimumStack?: number
  }

  interface ShopSource extends SourceCommon {
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
    buyMode?: 'left' | 'right' | 'shift-left' | 'shift-right'
    amountPerClick?: number
    maxClicks?: number
    confirmSlot?: number
    confirmDelayMs?: number
    clickDelayMs?: number
    afterPurchaseDelayMs?: number
    windowTimeoutMs?: number
    closeWindow?: boolean
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

  interface CustomSource extends SourceCommon {
    type: 'custom'
    acquire(context: { bot: Bot; engine: CraftEngine; item: { id: number; name: string }; amount: number }): Promise<number> | number
  }

  type Source = ({ type: 'inventory' } & SourceCommon) | ChestSource | ContainerRangeSource | ShopSource | CustomSource

  interface Destination extends ContainerAccessOptions, RangeOptions {
    type?: 'inventory' | 'chest' | 'barrel' | 'shulker' | 'ender_chest' | 'container' |
      'range' | 'container-range' | 'container_range' | 'chest-range' | 'chest_range' | 'drop' | 'custom'
    position?: Position
    start?: Position
    end?: Position
    settleDelayMs?: number
    deposit?: (context: { bot: Bot; engine: CraftEngine; selector: ItemSelector; amount: Amount }) => Promise<number> | number
  }

  interface ProductionOptions {
    target?: { item: ItemSelector; amount?: Amount }
    item?: ItemSelector
    amount?: Amount
    sources?: Source[]
    sourceChest?: Position
    sourceItem?: ItemSelector
    craftingTable?: Position
    table?: Position
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
    preflight?: boolean
    flushOutputEachCycle?: boolean
    bufferEachCycle?: boolean
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
      amount: Amount
      helpers: Record<string, unknown>
    }): Promise<{ acquired?: number } | void>
  }

  interface Checkpoint {
    target: string
    requested: Amount
    remaining: Amount
    totalCrafted: number
    cycles: number
    timestamp: string
  }

  interface JobStatus {
    state: string
    cycles?: number
    totalCrafted?: number
    cancelled?: boolean
    paused?: boolean
    startedAt?: string | null
    endedAt?: string | null
    checkpoint: Checkpoint | null
    error?: string | null
  }

  interface CraftResult { item: string; requested: Amount; crafted: number; mode: CraftMode }
  interface ProductionResult { item: string; requested: Amount; totalCrafted: number; cycles: number; stopped: boolean; checkpoint: Checkpoint | null }

  interface SupervisorOptions {
    createBot(): Bot | Promise<Bot>
    production: ProductionOptions
    configure?: (bot: Bot, supervisor: CraftSupervisor) => void | Promise<void>
    beforeProduction?: (bot: Bot, supervisor: CraftSupervisor) => void | Promise<void>
    reconnectDelayMs?: number
    /** Consecutive failed reconnects allowed (a connection that lasted stableConnectionMs resets the count). */
    maxReconnects?: number
    /** Uptime after which a connection counts as healthy and resets the reconnect counter (default 60000; -1 disables). */
    stableConnectionMs?: number
    reconnectOnJobError?: boolean
    resumeFixedAmount?: boolean
    startDelayMs?: number
    quitAfterComplete?: boolean
    checkpoint?: Checkpoint | null
  }

  class CraftSupervisor extends EventEmitter {
    constructor(plugin: typeof import('.'), options: SupervisorOptions)
    bot: Bot | null
    checkpoint: Checkpoint | null
    reconnects: number
    start(): Promise<this>
    stop(reason?: string): void
    getStatus(): { stopped: boolean; reconnects: number; connected: boolean; username: string | null; checkpoint: Checkpoint | null; job: JobStatus | null }
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

  interface ContainerItemInfo { name: string; type: number; metadata: number; count: number; displayName: string }

  /** Low-level container helpers used by production(); exposed as `bot.craftEngine.containers`. */
  interface ContainerManager {
    goTo(position: Position, range?: number): Promise<void>
    inspect(position: Position, options?: ContainerAccessOptions): Promise<ContainerItemInfo[]>
    count(position: Position, selector: ItemSelector, options?: ContainerAccessOptions): Promise<number>
    withdraw(position: Position, selector: ItemSelector, amount: Amount, options?: ContainerAccessOptions & { required?: boolean }): Promise<number>
    /** Throws DESTINATION_FULL (with details.moved) when the amount does not fit. */
    deposit(position: Position, selector: ItemSelector, amount?: Amount, options?: ContainerAccessOptions): Promise<number>
    depositUpToCapacity(position: Position, selector: ItemSelector, amount?: Amount, options?: ContainerAccessOptions): Promise<{ moved: number; full: boolean }>
    withdrawRange(range: ContainerRangeSource | { start: Position; end: Position }, selector: ItemSelector, amount?: Amount, options?: Record<string, unknown>): Promise<number>
    depositRange(range: Destination, selector: ItemSelector, amount?: Amount, options?: Record<string, unknown>): Promise<number>
    findInRange(start: Position, end: Position, options?: RangeOptions): Array<{ x: number; y: number; z: number }>
    canonicalContainerKey(block: unknown): string
  }

  interface PlanDescription {
    item: string
    resultPerOperation: number
    operations: number
    requirements: Array<{ item: string; count: number }>
  }

  interface CraftEngineEvents {
    state: (event: { state: string; job: unknown; [key: string]: unknown }) => void
    jobStart: (event: { job: unknown; target: string; amount: Amount }) => void
    jobComplete: (event: { job: unknown; status: JobStatus }) => void
    jobError: (event: { job: unknown; error: Error }) => void
    checkpoint: (checkpoint: Checkpoint) => void
    craftComplete: (event: { job: unknown; item: string; amount: number }) => void
    outputStored: (event: { job: unknown; item: string; amount: number; reason: string; preexisting: boolean }) => void
    inventoryBuffered: (event: { job: unknown; amount: number; reason: string; destination: Destination }) => void
    materialsMissing: (event: { job: unknown; target: string; requirements: Array<{ id: number; name: string; count: number }> }) => void
    cycleInterrupted: (event: { job: unknown; reason: 'death'; cycle: number; error: Error }) => void
    sourceUsed: (event: { source: Source; item: string; moved: number }) => void
    sourceError: (event: { source: Source; item: string; error: Error }) => void
    shopIngredientsDetected: (event: { target: string; ingredients: Array<{ id: number; name: string; count: number }> }) => void
    shopIngredientDetectionFailed: (event: { target: string; error: Error }) => void
    shopBudgetExceeded: (event: { source: ShopSource; budgetKey: string; spent: number; maxSpend: number }) => void
    shopStopped: (event: { source: ShopSource; item: string; reason: string; clicks: number }) => void
    fastFallback: (event: { item: string; error: Error }) => void
    partialCraft: (event: { item: string; crafted: number; requested: Amount; error: Error }) => void
    recipeMismatch: (event: { item: string; expectedCount: number; declaredCount: number; recipeId: string }) => void
    retry: (event: { operation: string; attempt: number; cause: Error }) => void
    rangeSourceTried: (event: { position: unknown; available: number; moved: number; skipped: boolean; error: Error | null }) => void
    rangeDestinationScan: (event: { start: unknown; end: unknown; count: number; positions: unknown[] }) => void
    rangeDestinationTried: (event: { position: unknown; moved: number; full: boolean; error: Error | null }) => void
  }

  class CraftEngine extends EventEmitter {
    constructor(bot: Bot, options?: Record<string, unknown>)
    bot: Bot
    containers: ContainerManager
    currentJob: unknown | null
    lastCheckpoint: Checkpoint | null
    dead: boolean
    deaths: number
    metrics: Record<string, number | string>
    on<K extends keyof CraftEngineEvents>(event: K, listener: CraftEngineEvents[K]): this
    on(event: string | symbol, listener: (...args: any[]) => void): this
    once<K extends keyof CraftEngineEvents>(event: K, listener: CraftEngineEvents[K]): this
    once(event: string | symbol, listener: (...args: any[]) => void): this
    craft(options: CraftOptions): Promise<CraftResult>
    /** Rejects with code JOB_ACTIVE if a production job is already running. */
    production(options: ProductionOptions): Promise<ProductionResult>
    /** Tops inventory up to minAmount using sources (chest and/or shop), without running a full production job. */
    ensureStock(item: ItemSelector, minAmount: Amount, sources?: Source[], options?: { required?: boolean }): Promise<EnsureStockResult>
    /** Checks a production() config (crafting table, sources, destinations, recipe availability) without running it or touching the world. */
    validate(options: ProductionOptions): Promise<ValidationResult>
    plan(options: { item: ItemSelector; amount?: Amount; table?: Position; craftingTable?: Position }): PlanDescription
    registerRecipe(definition: Record<string, unknown>): unknown
    registerRecipeId(itemName: string, recipeId: string): void
    registerShopAdapter(id: string, adapter: ShopAdapter): ShopAdapter
    pause(): void
    resume(): void
    stop(): void
    getStatus(): JobStatus
    getMetrics(): Record<string, number | string>
    getCheckpoint(): Checkpoint | null
    resync(delayMs?: number): Promise<{ window: number | null; inventoryItems: number }>
    dispose(): void
  }
}

declare module 'mineflayer' {
  interface Bot {
    craftEngine: plugin.CraftEngine
  }
}

export = plugin
