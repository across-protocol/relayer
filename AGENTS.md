# AGENTS.md - relayer-v2

This repository contains bots that execute critical Across protocol operations, including relaying, dataworker root bundle workflows, inventory rebalancing, and cross-chain finalization tasks.

## How to use docs in this repo

Read docs in this order:

1. `CLAUDE.md` for repository-specific agent operating rules.
2. This file (`AGENTS.md`) for top-level navigation and module map.
3. Module docs (`src/*/README.md` or local `AGENTS.md`) for implementation and runtime details.
4. `docs/*.md` for deeper architectural and protocol context.

## Documentation maintenance

Keep all relevant `AGENTS.md` and `README.md` files updated in the same change whenever behavior, configuration, interfaces, or runtime flow changes.

- Before writing implementation plans, surface material ambiguities first and resolve them with the user.
- For each new task, propose 0-3 targeted updates to `CLAUDE.md` and/or module `AGENTS.md` files (or explicitly state why no updates are needed).
- For deep-dive documentation tasks, prefer cross-module walkthroughs when behavior spans relayer, clients, dataworker, or shared utilities.
- Write deep-dive docs as "current behavior" references first, then add a concise "contributor recommendations" section.

## Quick index

- Relayer runtime and risk model: `src/relayer/README.md`
- Rebalancer behavior and adapters: `src/rebalancer/README.md`
- Refiller behavior: `src/refiller/README.md`
- Dataworker root-bundle flow: `src/dataworker/README.md`
- Shared runtime clients: `src/clients/README.md`
- Finalization-specific workflows: `src/finalizer/*` and `src/cctp-finalizer/*`
- UMA and smart-contract context: `docs/uma.md` and `docs/smart-contracts.md`
- Relayer fill and repayment deep dives: `docs/relayer-fill-decision-flow.md` and `docs/repayment-selection.md`
- Inventory deep dives: `docs/repayment-eligibility.md` and `docs/inventory-virtual-balance-model.md`

## Bot types

The main bot types in `src/`:

- `dataworker`: Proposes, disputes, and executes root bundles for relayer and depositor refunds.
- `relayer`: Fills profitable deposits subject to configured risk and route constraints.
- `refiller`: Refills inventory back to configured target balances.
- `rebalancer`: Rebalances inventory across chains and exchange venues.
- `finalizer`: Completes delayed cross-chain flows and multi-step bridge finalization tasks.
- `monitor`: Runs monitoring and reporting checks.
- `gasless`: Handles gasless relay flows.

## Directory tree

```text
relayer-v2/
├── src/                          # Runtime bot implementations and shared TypeScript modules.
│   ├── dataworker/               # Dataworker runtime and root-bundle proposal/dispute logic.
│   ├── relayer/                  # Deposit fill runtime and relayer-specific config/logic.
│   ├── refiller/                 # Refiller runtime for target-balance inventory replenishment.
│   ├── rebalancer/               # Cross-chain and venue-based inventory rebalancing logic.
│   ├── finalizer/                # Generic finalization runtime and chain-specific finalizer utilities.
│   │   └── utils/                # Per-chain/per-bridge finalization helper implementations.
│   ├── cctp-finalizer/           # CCTP-focused finalization runtime and utility modules.
│   ├── monitor/                  # Monitoring and operational health checks.
│   ├── gasless/                  # Gasless relay runtime.
│   ├── hyperliquid/              # Hyperliquid-specific execution and integration flows.
│   ├── clients/                  # Shared clients for events, txs, inventory, pricing, and bridges.
│   │   ├── ProfitClient.ts       # Profitability evaluation for potential fills.
│   │   ├── InventoryClient.ts    # Inventory state, targets, and transfer planning.
│   │   ├── TransactionClient.ts  # Transaction submission, tracking, and receipt handling.
│   │   ├── TokenClient.ts        # Token metadata, balances, and allowance helpers.
│   │   ├── SpokePoolClient.ts    # SpokePool event/state client wrappers.
│   │   └── bridges/              # Bridge adapter selection and cross-chain transfer helpers.
│   ├── caching/                  # Redis-backed and in-memory cache helpers.
│   ├── adapter/                  # Chain/exchange adapter abstractions.
│   ├── interfaces/               # Shared interfaces and cross-module types.
│   ├── libexec/                  # Websocket/event listener execution helpers.
│   ├── common/                   # Shared constants and common primitives.
│   │   └── abi/                  # Contract ABI artifacts and ABI-loading helpers.
│   └── utils/                    # General shared utility helpers.
├── contracts/                    # Utility contracts used by bots (plus mocks for tests).
├── deploy/                       # Contract deployment scripts.
├── scripts/                      # Operational scripts and one-off tooling.
├── test/                         # Unit/integration tests for bots and shared clients.
├── docs/                         # Deeper architecture and protocol documentation.
└── Dockerfile                    # Container runtime definition for bot execution.
```

## Runtime execution flow

- Main entrypoint: `index.ts`
- CLI args choose bot type and runtime options.
- `--wallet` controls wallet construction for on-chain operations.
- Environment variables map into bot-specific configuration objects.
- Bots are designed to run in Dockerized, often serverless, environments.

## Memory/state model

Most bots are designed for stateless execution between runs. Persistent runtime state is stored in Redis when continuity is required across invocations.
