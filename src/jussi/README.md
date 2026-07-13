# Jussi Graph Artifacts

`scripts/buildJussiGraph.ts` is the source for the checked-in graph artifacts in this folder and for optional Jussi API uploads.

The builder is schema-first: it emits the canonical Jussi graph shape and populates venue economics from live relayer adapters instead of baking a separate graph schema into `relayer-v2`.
The implementation is split into topology, economics, serialization, API-client, and publisher modules under `src/jussi/`.

## Public Build API

New callers should import graph-building APIs from `src/jussi/buildGraph.ts`.

Use `buildJussiGraphUploadBundle(params)` when a client needs a graph ready for `JussiApiClient.putGraphBundle(graphId, bundle)`. It runs the full topology plus live-economics build and returns:

- `graphId`: the id to use in `PUT /graph_bundles/{graphId}`
- `bundle`: the PUT body `{ graph, rate_limit_buckets }`
- `envelope`: the stdout/debug shape `{ graph_id, payload }`
- `bundleHash`: the stable bundle hash for metadata or reconciliation
- `graph`: the intermediate `BuiltJussiGraph` for artifact writers

Use `buildJussiGraphDefinition(params)` only when the caller needs the intermediate graph object before serialization. Use `prepareGraphTopology(...)` plus `runFullBuild(prepared, deps)` only for advanced flows that intentionally separate deterministic topology checks from live signer/client construction, such as `scripts/buildJussiGraph.ts` and the upload publisher.

Today that means:

- Binance and Hyperliquid class-level `marginal_output_rate` values are estimated from live venue pricing data
- swap classes sample `$1k`, `$10k`, and `$100k` notionals and only emit multiple `output.segments` when the retained-rate estimates diverge materially
- bridge / CCTP / OFT / CEX-bridge classes still emit `1:1` output rates and carry fixed fees plus `cost.fixed_cost_native` on concrete edges
- bridge latencies follow the chain-family timing rules already encoded in relayer constants
- graph logical assets now include `native_price_alias_chain_ids` only when a chain's native fee asset can safely reuse `USDC` / `USDT` / `WETH`; all other chains require callers to supply `native:<chainId>` prices explicitly
- Binance family edge capacities use large round sanity caps instead of `maxAmountsToTransfer`; same-asset CEX bridge and swap edges are additionally bounded by live Binance withdrawal maxima and CCTP intermediate bridge caps when those routes constrain execution

## Build Modes

All modes start with `prepareGraphTopology`, a pure step that parses relayer/rebalancer config, computes the hub context, computes the single rebalance route set, and builds the final deduped topology. It constructs no signer, clients, wallet, or Redis connection.

Default and upload full builds initialize rebalancer pricing adapters with the prepared rebalance route set, including bridge-derived routes added during topology preparation, so every serialized candidate can be priced against an initialized adapter route.

| Mode | Behavior after topology prep | Signer | Redis |
|------|------------------------------|--------|-------|
| Default | Runs the shared full build core, writes artifacts, and prints the `{ graph_id, payload }` envelope. | Yes | No publisher gate; live adapters may connect as usual |
| `--topology-only` | Prints the deterministic topology artifact; writes `JUSSI_TOPOLOGY_JSON_OUT` when set. | No | No |
| `--topology-only --check` | Rebuilds deterministic topology and compares it with the committed topology artifact. | No | No |
| `--upload` | Validates the upload gate, acquires the publisher Redis lock, runs the same full build core, PUTs the bundle, and persists metadata. | Yes | Required |

Topology is deterministic from constants plus `InventoryConfig`/`RebalancerConfig`. Economics are always live on default builds and uploads: cumulative balances, gas prices, venue quotes, output segments, capacities, and fixed costs are recomputed every run.

Topology checks do not construct a signer, relayer clients, rebalancer adapters, GCP clients, or Binance API clients. Binance-labeled routes in the topology artifact are generated from static Binance network constants; live Binance API calls happen only in the default/upload full-build economics path.

The committed topology artifact captures materialized nodes, final post-dedupe edge candidates, logical assets, required native price chains, attached rate-limit bucket bodies, and the static rebalance route set. It intentionally excludes live balances, gas, venue quotes, graph id, `bundleHash`, and `prices_by_asset`.

## File Types

- `src/jussi/graphs/sampleGraph.json`: the pure Jussi graph JSON
- `src/jussi/graphs/sampleRateLimitBuckets.json`: the companion rate-limit bucket JSON
- `src/jussi/graphs/samplePrices.json`: an example `prices_by_asset` value for `find_optimal_paths`, generated from live prices at build time; it includes `logical:<asset>` prices plus only the explicit `native:<chainId>` prices not covered by `native_price_alias_chain_ids`
- `src/jussi/graphs/sampleTopology.json`: the committed deterministic topology snapshot used by `--topology-only --check`

## How To Generate Them

Run the graph builder once and tell it where to write the checked-in graph artifact. The script will also write the companion rate-limit-buckets file next to it by default:

```bash
RELAYER_EXTERNAL_INVENTORY_CONFIG=../inventory-configs/prod.json \
REBALANCER_EXTERNAL_CONFIG=../inventory-configs/rebalancer.json \
JUSSI_GRAPH_JSON_OUT=src/jussi/graphs/sampleGraph.json \
yarn build-jussi-graph --wallet gckms --keys bot4 --binanceSecretKey <binance-secret-key>
```

Use `--relayerAddress <0x-address>` when the graph should query inventory for a target relayer address that is different from the execution wallet. The signer still comes from the selected `--wallet` mode; the override is only for graph-builder balance and quote inputs, so regenerating sandbox artifacts does not require the target relayer private key.

If you want to override the companion output path explicitly, set `JUSSI_RATE_LIMIT_BUCKETS_JSON_OUT`.

The script also writes `samplePrices.json` next to the graph by default. Override that path with `JUSSI_PRICES_BY_ASSET_JSON_OUT` if needed.

This build reads the repo-local `.env` via `dotenv`. In practice you usually need:

- a valid Binance API key in `.env`
- working GCP auth if `--binanceSecretKey` points at a GCKMS-stored secret
- the inventory and rebalancer config JSON files referenced above
- a real EVM wallet mode today; `--wallet void` does not work yet because the relayer client stack still derives an SVM signer from the EVM signer during startup

If your local Google auth is expired, the build will fail before publishing the artifact. The repo comments reference the local `with-gcp-auth` wrapper for refreshing ADC before rerunning the command.

If you also want the `{ graph_id, payload }` envelope on stdout for debugging or automation, call the built script directly instead of `yarn` and redirect that output. The stdout `payload` still uses the Jussi bundle body for `PUT /graph_bundles/{graph_id}`:

```bash
yarn build-jussi-graph --wallet gckms --keys bot4 --binanceSecretKey <binance-secret-key> \
  >/tmp/jussi-graph-envelope.json
```

To run a signer-free topology-only build:

```bash
RELAYER_EXTERNAL_INVENTORY_CONFIG=../inventory-configs/prod.json \
REBALANCER_EXTERNAL_CONFIG=../inventory-configs/rebalancer.json \
yarn build-jussi-graph --topology-only
```

Use `yarn --silent run build-jussi-graph --topology-only` or call `node -r ts-node/register ./scripts/buildJussiGraph.ts --topology-only` directly when redirecting stdout for machine-readable JSON; plain `yarn` writes its own command prelude to stdout.

To regenerate the committed topology snapshot without GCP, Binance, Redis, or a wallet:

```bash
RELAYER_EXTERNAL_INVENTORY_CONFIG=../inventory-configs/prod.json \
REBALANCER_EXTERNAL_CONFIG=../inventory-configs/rebalancer.json \
JUSSI_TOPOLOGY_JSON_OUT=src/jussi/graphs/sampleTopology.json \
yarn build-jussi-graph --topology-only
```

To verify topology drift against the committed snapshot:

```bash
RELAYER_EXTERNAL_INVENTORY_CONFIG=../inventory-configs/prod.json \
REBALANCER_EXTERNAL_CONFIG=../inventory-configs/rebalancer.json \
yarn build-jussi-graph --topology-only --check
```

`--topology-only --check` reads `src/jussi/graphs/sampleTopology.json` by default. Override the input path with `JUSSI_TOPOLOGY_JSON_IN`.

## How To Use The PUT Payload

Use the generated `graph_id` from stdout with the split artifacts in `src/jussi/graphs/sampleGraph.json`, `src/jussi/graphs/sampleRateLimitBuckets.json`, and `src/jussi/graphs/samplePrices.json`. Together those three files should be enough for a caller to do a local end-to-end `find_optimal_paths` test against a Jussi instance.

The script stdout is an envelope:

```json
{ "graph_id": "<graph_id>", "payload": { "graph": {}, "rate_limit_buckets": [] } }
```

The PUT body is the bundle JSON at `payload`, not the envelope itself:

```bash
jq '.payload' /tmp/jussi-graph-envelope.json >/tmp/jussi-graph-bundle.json
curl -sS -X PUT "http://127.0.0.1:8080/graph_bundles/<graph_id>" \
  -H "Content-Type: application/json" \
  --data @/tmp/jussi-graph-bundle.json
```

Use the `graph_id` from the stdout envelope emitted by the graph builder. The checked-in split JSON files are meant to match `jussi/graphs` layout for fixtures and review.

## Uploads

`--upload` automates the PUT path:

```bash
RELAYER_EXTERNAL_INVENTORY_CONFIG=../inventory-configs/prod.json \
REBALANCER_EXTERNAL_CONFIG=../inventory-configs/rebalancer.json \
JUSSI_API_URL=http://127.0.0.1:8080 \
yarn build-jussi-graph --upload --wallet gckms --keys bot4 --binanceSecretKey <binance-secret-key>
```

Environment:

- `JUSSI_API_URL`: required for `--upload`.
- `JUSSI_API_TOKEN`: optional bearer token sent as `Authorization: Bearer <token>`.
- `JUSSI_ALLOW_PROD_UPLOAD=true`: required when `JUSSI_API_URL` is not localhost.
- `REDIS_URL`: required reachable for `--upload`; otherwise the repo default Redis URL is used.
- `JUSSI_GRAPH_JSON_OUT`, `JUSSI_RATE_LIMIT_BUCKETS_JSON_OUT`, and `JUSSI_PRICES_BY_ASSET_JSON_OUT`: full-build artifact paths, unchanged from artifact-only builds.
- `JUSSI_TOPOLOGY_JSON_OUT`: topology snapshot output path for `--topology-only`.
- `JUSSI_TOPOLOGY_JSON_IN`: topology snapshot input path for `--topology-only --check`; defaults to `src/jussi/graphs/sampleTopology.json`.

The production-upload gate runs before Redis preflight, signer construction, or live economics. This is intentional because the server semantics for `PUT /graph_bundles/{graph_id}` are not confirmed: the endpoint may create an inactive named bundle, or the latest PUT may become active immediately. Keep production upload disabled until operators confirm activation and rollback behavior.

Each upload uses `buildJussiGraphId(now)` for a timestamped graph id and stores publish metadata in Redis. Always-PUT behavior can accumulate one stored bundle per run; confirm whether the Jussi service has retention or garbage collection for old graph bundles.

## Redis Contract

`--upload` adds a publisher gate around the default full-build core:

1. Redis preflight read/write.
2. Acquire `jussi:graph:publish:lock` with a random token using `SET NX PX`.
3. Renew the lock with token-checked Lua while the live build, PUT, and metadata persist run.
4. Release the lock with token-checked Lua in `finally`.

Keys:

| Key | Value | TTL |
|-----|-------|-----|
| `jussi:graph:last_published` | `JSON.stringify({ graphId, bundleHash, publishedAt })` | None |
| `jussi:graph:publish:lock` | Random lock holder token | `PX ttlMs`, heartbeat-renewed |

Structured values are JSON-encoded by the caller because `RedisCache.set` stores strings. If the PUT succeeds but metadata persistence fails, the publisher throws an error containing `graphId` and `bundleHash` so operators can reconcile Redis manually; the previous `last_published` remains authoritative.
