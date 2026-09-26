# Changelog

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

# 0.5.3

- Fast recipe-book crafting now repeats collection passes until the requested batch is produced or no further progress is possible.
- GUI shop purchases now obey `maxClicks` for finite requests.
- Added per-click purchase delay, inventory-full stop, and final purchase verification.

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

## 0.5.1

- Replaced environment-specific internal npm registry URLs with `https://registry.npmjs.org/`.
- Added project `.npmrc` with retry settings.
- Added Windows clean-install instructions and `install-clean.ps1`.

## 0.5.2

- Fixed `install-clean.ps1` stopping when no `node.exe` process exists.
- Added deterministic `npm ci` installation from the public npm registry.
- Added stronger `node_modules` cleanup and explicit npm exit-code checks.

## 0.6.0

- Added automatic direct-ingredient shop selection (`gold_block` -> `gold_ingot`).
- Added automatic GUI product slot detection when `itemSlot` and `product` are omitted.
- Added optional `itemSlots` mapping for custom shop GUIs.
- Added multi-container output ranges with `start` and `end` coordinates.
- Full destination chests are skipped; output continues into the next chest.
- Added double-chest deduplication and range destination events.
