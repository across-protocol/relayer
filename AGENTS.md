# AGENTS.md - relayer-v2

This repository contains code that powers bots that execute critical roles within the Across Protocol ecosystem.

## Directory Tree

```text
relayer-v2/
├── src/                          # Runtime bot implementations and shared TS modules.
│   ├── adapter/                  # Chain/exchange abstractions used by InventoryClient to send tokens across chains.
│   ├── caching/                  # Redis cache helpers.
│   ├── dataworker/               # Proposes/disputes/executes refund root bundles.
│   ├── finalizer/                # Finalization bot for executing multi-step cross-chain state transfer.
│   │   └── utils/                         # Chain-specific finalization handlers and helper modules.
│   │       ├── arbStack.ts                # Arbitrum stack finalization utilities.
│   │       ├── binance.ts                 # Binance chain finalization utilities.
│   │       ├── helios.ts                  # Helios finalization helper utilities used to transfer state between the UniversalAdapter and the UniversalSpokePool contracts.
│   │       ├── oftRetry.ts                # OFT retry finalization flow helpers.
│   │       ├── opStack.ts                 # OP Stack finalization utilities.
│   │       ├── polygon.ts                 # Polygon finalization utilities.
│   │       ├── scroll.ts                  # Scroll finalization utilities.
│   │       ├── zkSync.ts                  # zkSync finalization utilities.
│   │       ├── cctp/                      # CCTP-specific finalization handlers.
│   │       │   ├── anyToAny.ts            # CCTP any-chain to any-chain finalization flow.
│   │       │   ├── l1ToSvmL2.ts           # CCTP finalization path from EVM L1 to SVM L2.
│   │       │   ├── Svml2ToL1.ts           # CCTP finalization path from SVM L2 to EVM L1.
│   │       │       ├── l1Tol2.ts          # SVM CCTP helper path from L1 to L2.
│   │       │       └── l2Tol1.ts          # SVM CCTP helper path from L2 to L1.
│   │       └── linea/                     # Linea-specific finalization handlers.
modules.
│   │           ├── l1ToL2.ts              # Linea finalization path from L1 to L2.
│   │           └── l2ToL1.ts              # Linea finalization path from L2 to L1.
│   ├── hyperliquid/              # A type of finalizer bot for executing multi-step fills of user deposits into and out of Hypercore
│   ├── interfaces/               # Shared TypeScript interfaces and cross-module type contracts.
│   ├── libexec/                  # Event clients designed to fetch events from WebSockets, unlike the event clients in src/clients which are designed to be fetch via HTTP.
│   ├── monitor/                  # Broadly scoped monititor bot, ideally should be split into domain-specific bots.
│   ├── relayer/                  # Fills profitable deposits.
│   ├── refiller/                 # Refills inventory to configured targets.
│   ├── rebalancer/               # Rebalances inventory across chains.
│   ├── utils/                    # General utility helpers reused src/.
│   ├── clients/                  # Helper clients used by bots.
│   │   ├── AcrossAPIClient.ts            # Wrapper for Across API reads.
│   │   ├── AcrossSwapApiClient.ts        # Client for swap-specific Across API quote/data fetching.
│   │   ├── BalanceAllocator.ts           # Keeps track of balances across routes/chains for inventory actions. Prevents over-allocating balances when enqueuing multiple balance transfer actions.
│   │   ├── BundleDataApproxClient.ts     # Approximates root bundle data in order to give relayer a fast way to approximate upcoming refunds.
│   │   ├── ConfigStoreClient.ts          # Reads protocol configuration from on-chain ConfigStore.
│   │   ├── EventListener.ts              # Event listener primitives shared by event-driven clients.
│   │   ├── HubPoolClient.ts              # Client abstraction over HubPool contract operations/state.
│   │   ├── InventoryClient.ts            # Inventory tracking, targets, and transfer planning client. The cross-chain inventory transfer logic is slated to be replaced by the RebalancerClient. Eventually this client will just be in charge of tracking virtual relayer balances across chains.
│   │   ├── MultiCallerClient.ts          # Batched multicall/transaction execution helper client. Uses the TransactionClient to submit on-chain.
│   │   ├── ProfitClient.ts               # Fill profitability computation. Constructs a PriceClient in order to determine a deposit's profitability.
│   │   ├── SpokePoolClient.ts            # SpokePool event and state client.
│   │   ├── SvmFillerClient.ts            # SVM fill-status and transaction interaction client.
│   │   ├── TokenClient.ts                # Token metadata/balance/allowance convenience client.
│   │   ├── TokenTransferClient.ts        # Tracks ERC20 transfer events.
│   │   ├── TransactionClient.ts          # Transaction submission, tracking, and receipt handling client.
│   │   └── bridges/                      # Bridge-focused transfer adapters and bridge helper modules.
│   │       ├── AdapterManager.ts         # Selects bridge adapters and normalizes transfer execution.
│   │       ├── CrossChainTransferClient.ts # Cross-chain transfer coordination client.
│   │       └── utils.ts                  # Shared bridge utility helpers.
│   ├── gasless/                  # Gasless relayer.
│   └── common/                   # Cross-module constants and shared internal primitives.
│       └── abi/                  # Contract ABI artifacts and ABI-loading helper utilities.
├── contracts/                    # Utility contracts (plus mocks) that support bot transaction patterns.
├── deploy/                       # Deployment scripts for /contracts files
├── test/                         # Unit/integration behavior tests for bots and shared clients.
├── docs/                         # Deeper architecture/protocol context for operators and contributors.
├── scripts/                      # Operational scripts (for example, fetching inventory config).
```

## Runtime execution flow

The main entrypoint is `index.ts`. This file reads from the CLI arguments to determine which of the bots, contained in /src/, to run.

Each bot is designed to be run with a `--wallet` argument that informs it how to construct a wallet tied to a private key that it can use to perform bot operations.

Configurable parameters are specified in environment variables which are converted into bot-specific configuration objects defined in each bot's specific module.

Bots are designed to be executed within Docker containers described by `Dockerfile`.

## Memory State

Many of the bots are designed to be run serverlessly so that in between runs all state is thrown away. The bots use Redis to store state that should persist across.

## Bot types

The bot types are organized in /src/:

- dataworker: Responsible for proposing batches of relayer and depositor refunds for successfully filled and unfilled deposits respectively. Proposes these batches to the `HubPool` smart contract deployed on Ethereum and the batches are validated optimistically. Only one batch can be submitted at a time and any batch can be disputed, in which case the dispute is resolved by the UMA DVM system. For more about the UMA system, go to /docs/uma.md.
- relayer: Responsible for filling user deposits. Will only fill profitable user deposits but is designed to be highly customizable depending on the business requirements.
- refiller: Responsible for refilling inventory in tokens back to configurable target balances.
- finalizer: Executes on-chain transactions or API requests required to process cross-chain transactions. For example, withdrawing ERC20's from an optimistic rollup's 7-day withdrawal bridge is initiated by calling a smart contract transaction on the rollup's network and finalized by calling a separate smart contract transaction (after the 7-days have passed) on the destination chain. The finalizer would be responsible for calling this second transaction in this example.
