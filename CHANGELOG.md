# Changelog

## 1.0.0

Stability release after a full audit of the code base. No public method was
removed; the changes below fix wrong behaviour and make failures explicit.

### Fixed — crafting

- Fast mode is never attempted on Minecraft 1.21.2+. Those versions use a numeric
  recipe-display id in `craft_recipe_request`; writing the old string id broke packet
  serialization. `adaptive` now falls back to safe crafting with `FAST_UNSUPPORTED`.
- `activateBlock()` rejections no longer become unhandled promise rejections (which can
  crash Node). Opening the crafting table now fails fast and cancels the window wait.
- Fast crafting of more than 256 operations without `makeAll` silently stopped at 256.
  It now uses `makeAll` while at least 64 operations remain (never overshooting a finite
  request) and single requests for the rest.
- A partially successful fast craft now finishes the remainder with safe crafting
  (when fallback is allowed) instead of returning short; a failing safe remainder keeps
  the partial result and emits `partialCraft`.
- Ingredients left in the 2x2 player crafting grid after recipe-book crafting are
  returned to the inventory (they were invisible to `inventory.items()` before).
- The bot walks to a far crafting table before opening it (when pathfinder is loaded).
- Server recipe ids: smelting/stonecutting records with the same result are ignored and
  the declared recipe whose ingredients match the chosen recipe is used
  (`gold_ingot_from_gold_block` vs `gold_ingot_from_nuggets`).
- `declare_recipes` replaces previous records instead of appending duplicates on `/reload`.
- `recipeMismatch` compares only against the recipe that will actually be requested
  (no more false alarms for `stick` because `stick_from_bamboo_item` exists).

### Fixed — production

- Recursive production works again for multi-step chains such as
  `oak_log (chest) → oak_planks → stick`: direct ingredients are treated as base items
  only when an automatic shop buys them, and the planner prefers recipe paths whose
  materials are actually available.
- Each cycle is sized to what fits in the inventory with one free slot for output. The
  default `batchSize` (2304) of a 9:1 recipe filled the whole inventory, so safe/adaptive
  crafting failed with `destination full`.
- Dying in the middle of a cycle (window closed, transfer aborted) no longer fails the
  job, or ends it as "completed" when an optional source swallowed the error; the cycle
  is retried after respawn and `cycleInterrupted` is emitted.
- A paused job no longer fails after 24 hours.
- `stop()` interrupts `repeatDelayMs` / `cycleDelayMs` waits immediately.
- A disconnect (`end`) stops the running job.
- A second `production()` call rejects immediately with `JOB_ACTIVE` instead of waiting
  forever behind a running job.
- Invalid `target.amount` and `maxCycles` are rejected up front (and by `validate()`).

### Fixed — containers, shops, sources

- Withdraw/deposit never request more than fits. Mineflayer throws `destination full`
  while still holding the item on the cursor; single-chest outputs now fail with a clean
  `DESTINATION_FULL` error and nothing on the cursor.
- Transfers are grouped by item kind. The old per-stack loop read stack objects that
  Mineflayer mutates during a transfer, stopped early and could report
  "All chests in the configured destination range are full" while chests had room.
- When no standing spot within the goal range exists (container behind a wall or table), `goTo` retries with `GoalLookAtBlock` (anywhere the block is visible within reach). `BLOCK_NOT_FOUND` now says where the bot is and how far away the unloaded block is.
- Range sources open each container once (count + withdraw) instead of twice.
- Double chests are paired from their `facing`/`type` block state like vanilla, so two
  double chests standing side by side are each visited once.
- Ranges larger than `maxRangeBlocks` (default 131072) are refused with
  `RANGE_TOO_LARGE` instead of scanning millions of blocks.
- Shops only search the shop's own slots. The old search included the player-inventory
  part of the window and could click the bot's own items.
- Shop budgets account for `amountPerClick`: only whole bundles the remaining budget can
  pay for are bought.
- Source `item`/`items` filters accept `minecraft:` names, ids and `{ name }` selectors.
- `drop` destinations respect the requested amount and report correct counts.

### Fixed — lifecycle and supervisor

- `waitForEvent` removes all listeners on timeout (listener leak in long runs).
- The plugin no longer keeps Mineflayer bot options (account credentials) on the engine.
- `dispose()` removes the engine's bot listeners and detaches `bot.craftEngine`.
- `ensureStock()` rejects a non-numeric minimum instead of looping with `NaN`.
- Supervisor: a failed first `start()` is retried like a reconnect; a failing
  `configure()` quits the half-configured bot; the reconnect counter resets after a
  connection that stayed up for `stableConnectionMs` (default 60 s); a disconnect is no
  longer reported as `productionComplete`.

### Added

- `CraftEngineError` export with documented `code` values.
- Events: `cycleInterrupted`, `partialCraft`, `shopStopped`.
- Complete TypeScript declarations: typed events (`CraftEngineEvents`),
  `bot.craftEngine.containers`, results, checkpoints and all source/destination options.
- `mineflayer-pathfinder` declared as an optional peer dependency; repository metadata.
- Integration test suite on a simulated bot (`test/helpers/simbot.js`) with real 1.18.2
  recipe data, chests, double chests, GUI shop, recipe-book protocol and death/respawn.

## 0.7.0

- Added `bot.craftEngine.ensureStock(item, minAmount, sources, options)`: tops inventory up to a minimum using the same `sources` (chest and/or shop) as `production()`, without running a full production job.
- Added `bot.craftEngine.validate(productionOptions)`: checks a `production()` config (crafting table block, chest/shop source and destination positions, recipe availability) without running it or touching the world. Returns `{ ok, issues: [{ code, message, field }] }`.
- Added shop purchase budgets: `costPerUnit` + `maxSpend` on a `shop` source clamp purchase amount to what's affordable and refuse further purchases once spent, emitting `shopBudgetExceeded`. Tracking is in-memory only (`ShopRegistry.getSpend`/`resetSpend`) and resets on process restart; nothing is written to disk.
- Added `recipeMismatch` event: when the server's declared recipe (`declare_recipes`) reports a different result count than the recipe the engine chose (e.g. mineflayer's static recipe data vs. a custom server recipe), the mismatch is now surfaced instead of silently producing incorrect operation counts.

## 0.6.2

- Fixed partial-full chest routing: only the amount that fits is deposited.
- A partly full chest no longer leaves items on the cursor or falsely reports them as stored.
- Start/end output now continues to the next chest after filling the current chest.
- Added `rangeDestinationScan` event showing how many containers were discovered.
- Added configurable `settleDelayMs` for server inventory confirmation.

## 0.6.1

- Added production preflight: existing finished output is deposited before shopping/crafting.
- Added inventory buffer chest for unrelated items.
- Added start/end container-range sources with `minAvailable` support.
- Output routing now deposits every matching target stack in inventory, not only the current craft count.
- Optional shop/source failures no longer abort production; available materials are still crafted.
- Added `batchSize: "inventory"` for full-inventory compression batches.
- Added shop chat-stop handling for insufficient funds and full inventory messages.

## 0.6.0

- Added automatic direct-ingredient shop selection (`gold_block` -> `gold_ingot`).
- Added automatic GUI product slot detection when `itemSlot` and `product` are omitted.
- Added optional `itemSlots` mapping for custom shop GUIs.
- Added multi-container output ranges with `start` and `end` coordinates.
- Full destination chests are skipped; output continues into the next chest.
- Added double-chest deduplication and range destination events.

## 0.5.3

- Fast recipe-book crafting now repeats collection passes until the requested batch is produced or no further progress is possible.
- GUI shop purchases now obey `maxClicks` for finite requests.
- Added per-click purchase delay, inventory-full stop, and final purchase verification.

## 0.5.2

- Fixed `install-clean.ps1` stopping when no `node.exe` process exists.
- Added deterministic `npm ci` installation from the public npm registry.
- Added stronger `node_modules` cleanup and explicit npm exit-code checks.

## 0.5.1

- Replaced environment-specific internal npm registry URLs with `https://registry.npmjs.org/`.
- Added project `.npmrc` with retry settings.
- Added Windows clean-install instructions and `install-clean.ps1`.

## 0.5.0

- Recipe Book fast crafting for Minecraft 1.17.1+ with `craft_recipe_request`.
- Captures server-declared recipe identifiers and supports manual recipe ID overrides.
- Adaptive mode with automatic fallback to Mineflayer safe crafting.
- Correct output-count and maximum-operation calculations.
- Recursive crafting and leaf-material planning.
- Inventory, chest, barrel, shulker, ender chest and custom sources.
- Generic command-GUI shop adapter and custom shop adapter registry.
- Output and leftover routing.
- Continuous production jobs with pause, resume, stop, metrics and checkpoints.
- Death/spawn recovery inside the same connection.
- JavaScript API types, examples and unit tests.

## 0.1.0

- Initial MVP with basic crafting and one chest-to-chest production loop.
