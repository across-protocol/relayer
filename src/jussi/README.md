# Jussi Graph Artifacts

`buildJussiGraph.ts` is the source for the checked-in graph artifacts in this folder.

The builder is schema-first: it emits the canonical Jussi graph shape and populates venue economics from live relayer adapters instead of baking a separate graph schema into `relayer-v2`.

Today that means:

- Binance and Hyperliquid class-level `marginal_output_rate` values are estimated from live venue pricing data
- bridge / CCTP / OFT / CEX-bridge classes still emit `1:1` output rates and carry fees/latency on concrete edges
- bridge latencies follow the chain-family timing rules already encoded in relayer constants

## File Types

- `src/jussi/graphs/*.json`: flattened graph JSONs for inspection and diffing. These match the canonical Jussi shape of `sampleGraph.json` with `graph_id`, `graph_version`, `latency_annualized_cost_rate`, `pain_model`, `logical_assets`, `rate_limit_buckets`, `edge_classes`, `nodes`, and `edges`.

## How To Generate Them

Run the graph builder once and tell it where to write the two checked-in artifacts:

```bash
RELAYER_EXTERNAL_INVENTORY_CONFIG=../inventory-configs/prod.json \
REBALANCER_EXTERNAL_CONFIG=../inventory-configs/rebalancer.json \
JUSSI_GRAPH_JSON_OUT=src/jussi/graphs/sampleGraph.json \
yarn build-jussi-graph --wallet gckms --keys bot4 --binanceSecretKey <binance-secret-key>
```

This build reads the repo-local `.env` via `dotenv`. In practice you usually need:

- a valid Binance API key in `.env`
- working GCP auth if `--binanceSecretKey` points at a GCKMS-stored secret
- the inventory and rebalancer config JSON files referenced above

If your local Google auth is expired, the build will fail before publishing the artifact. The repo comments reference the local `with-gcp-auth` wrapper for refreshing ADC before rerunning the command.

If you also want the pure `{ graph_id, payload }` envelope on stdout for debugging or automation, call the built script directly instead of `yarn` and redirect that output:

```bash
node ./dist/scripts/buildJussiGraph.js --wallet gckms --keys bot4 --binanceSecretKey <binance-secret-key> \
  >/tmp/jussi-graph-envelope.json
```

## How To Use The PUT Payload

Extract the data you need to supply into the PUT endpoint from `src/jussi/graphs/sampleGraph.json`.

```bash
curl -sS -X PUT "http://127.0.0.1:8080/graphs/<graph_id>" \
  -H "Content-Type: application/json" \
  --data <data>
```

Use the `graph_id` from the matching flattened graph JSON. For the checked-in sample, that value lives in `src/jussi/graphs/sampleGraph.json`.
