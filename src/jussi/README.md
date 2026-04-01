# Jussi Graph Artifacts

`buildJussiGraph.ts` is the source for the checked-in graph artifacts in this folder.

## File Types

- `src/jussi/graphs/*.json`: flattened graph JSONs for inspection and diffing. These match the shape of `sampleGraph.json` with `graph_id`, `graph_version`, `pain_model`, `logical_assets`, `nodes`, and `edges`.

## How To Generate Them

Run the graph builder once and tell it where to write the two checked-in artifacts:

```bash
RELAYER_EXTERNAL_INVENTORY_CONFIG=../inventory-configs/prod.json \
REBALANCER_EXTERNAL_CONFIG=../inventory-configs/rebalancer.json \
JUSSI_GRAPH_JSON_OUT=src/jussi/graphs/sampleGraph.json \
yarn build-jussi-graph --wallet gckms --keys bot4 --binanceSecretKey <binance-secret-key>
```

If you also want the pure `{ graph_id, payload }` envelope on stdout for debugging or automation, call the built script directly instead of `yarn` and redirect that output:

```bash
node ./dist/scripts/buildJussiGraph.js --wallet gckms --keys bot4 --binanceSecretKey <binance-secret-key> \
  >/tmp/jussi-graph-envelope.json
```

## How To Use The PUT Payload

Extract the data you need to supply into the PUT endpoint from `@src/jussi/graphs/sampleGraphs.json`.

```bash
curl -sS -X PUT "http://127.0.0.1:8080/graphs/<graph_id>" \
  -H "Content-Type: application/json" \
  --data <data>
```

Use the `graph_id` from the matching flattened graph JSON. For the checked-in sample, that value lives in `src/jussi/graphs/sampleGraph.json`.
