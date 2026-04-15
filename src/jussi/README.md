# Jussi Graph Artifacts

`buildJussiGraph.ts` is the source for the checked-in graph artifacts in this folder.

The builder is schema-first: it emits the canonical Jussi graph shape and populates venue economics from live relayer adapters instead of baking a separate graph schema into `relayer-v2`.

Today that means:

- Binance and Hyperliquid class-level `marginal_output_rate` values are estimated from live venue pricing data
- swap classes sample `$1k`, `$10k`, and `$100k` notionals and only emit multiple `output.segments` when the retained-rate estimates diverge materially
- bridge / CCTP / OFT / CEX-bridge classes still emit `1:1` output rates and carry fixed fees plus `cost.fixed_cost_native` on concrete edges
- bridge latencies follow the chain-family timing rules already encoded in relayer constants
- graph logical assets now include `native_price_alias_chain_ids` only when a chain's native fee asset can safely reuse `USDC` / `USDT` / `WETH`; all other chains require callers to supply `native:<chainId>` prices explicitly
- Binance family edge capacities use large round sanity caps instead of `maxAmountsToTransfer`; same-asset CEX bridge edges use the same large-cap default, while swap edges are additionally bounded by live market metadata when Binance exposes one

## File Types

- `src/jussi/graphs/sampleGraph.json`: the pure Jussi graph JSON
- `src/jussi/graphs/sampleRateLimitBuckets.json`: the companion rate-limit bucket JSON
- `src/jussi/graphs/samplePrices.json`: an example `prices_by_asset` value for `find_optimal_paths`, generated from live prices at build time

## How To Generate Them

Run the graph builder once and tell it where to write the checked-in graph artifact. The script will also write the companion rate-limit-buckets file next to it by default:

```bash
RELAYER_EXTERNAL_INVENTORY_CONFIG=../inventory-configs/prod.json \
REBALANCER_EXTERNAL_CONFIG=../inventory-configs/rebalancer.json \
JUSSI_GRAPH_JSON_OUT=src/jussi/graphs/sampleGraph.json \
yarn build-jussi-graph --wallet gckms --keys bot4 --binanceSecretKey <binance-secret-key>
```

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
yarn tsx ./scripts/buildJussiGraph.ts --wallet gckms --keys bot4 --binanceSecretKey <binance-secret-key> \
  >/tmp/jussi-graph-envelope.json
```

## How To Use The PUT Payload

Use the generated `graph_id` from stdout with the split artifacts in `src/jussi/graphs/sampleGraph.json`, `src/jussi/graphs/sampleRateLimitBuckets.json`, and `src/jussi/graphs/samplePrices.json`. Together those three files should be enough for a caller to do a local end-to-end `find_optimal_paths` test against a Jussi instance.

```bash
curl -sS -X PUT "http://127.0.0.1:8080/graph_bundles/<graph_id>" \
  -H "Content-Type: application/json" \
  --data @/tmp/jussi-graph-envelope.json
```

Use the `graph_id` from the stdout envelope emitted by the graph builder. The checked-in split JSON files are meant to match `jussi/graphs` layout for fixtures and review.
