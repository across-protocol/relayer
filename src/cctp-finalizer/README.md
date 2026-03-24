# CCTP Finalizer

Service that finalizes Circle Cross-Chain Transfer Protocol (CCTP) burns by submitting the corresponding mint transactions on the destination chain. It runs as an Express application that Google Cloud Pub/Sub (or any HTTPS-compatible queue) can push messages to. Each message encodes the details of a burn transaction that originated on a source chain and now needs its mint leg executed.

---

## High-Level Flow

1. **Pub/Sub Push** – Our indexer (the burn watcher) publishes a `PubSubMessage` (see below) where `message.data` is a base64-encoded JSON payload.
2. **Ingress (`app.ts`)** – The `POST /` endpoint decodes the payload, logs metadata, and delegates to `CCTPService.processBurnTransaction`. A `204` response acknowledges success; returning `500` forces Pub/Sub to retry. (`/health` is also exposed for simple uptime checks.)
3. **Key & RPC Resolution (`CCTPService`)**
   - Fetches EVM and SVM private keys from Google Cloud KMS via `retrieveGckmsKeys`.
   - Infers destination chain either from the payload or by decoding the CCTP message bytes.
   - Loads the destination RPC URL from the static map in `getRpcUrlForChain`.
4. **Attestation Handling**
   - Uses provided `message`/`attestation` pairs if present to skip the Circle API.
   - Otherwise, calls `utils.fetchCctpV2Attestations` until a status of `complete | done | succeeded` is observed.
5. **Idempotency Check**
   - EVM chains: `checkIfAlreadyProcessedEvm` queries `MessageTransmitter.hasCCTPMessageBeenProcessed`.
   - SVM chains: `checkIfAlreadyProcessedSvm` inspects PDAs derived from the nonce to see if they exist on Solana.
6. **Mint Execution**
   - EVM: `processMintEvm` and `runTransaction` invoke `receiveMessage`. HyperCore destinations optionally call the `SponsoredCCTPDstPeriphery` when a sponsorship signature accompanies the request.
   - SVM: `processMintSvm` detects V1 vs V2 messages, derives token messenger accounts, composes the Solana instruction set, and submits via `sendAndConfirmSolanaTransaction`.
7. **Result Propagation**
   - Successful mints return `{ success: true, mintTxHash }`.
   - Failures bubble up through typed `CCTPError`s to steer retry behavior.

---

## Pub/Sub Message Contract

Messages are defined in `types/index.ts` and serialized as JSON before being base64-encoded into the Pub/Sub payload:

```17:23:src/cctp-finalizer/types/index.ts
export interface PubSubMessage {
  burnTransactionHash: string;
  sourceChainId: number;
  message?: StringUnion | null;
  attestation?: StringUnion | null;
  destinationChainId?: LongUnion | null;
  signature?: StringUnion | null;
}
```

- `burnTransactionHash`: Source-chain tx hash used when fetching attestations.
- `sourceChainId`: Canonical chain ID for the burn leg.
- `message`/`attestation`: Optional Circle artifacts (when omitted, the service queries Circle).
- `destinationChainId`: Optional override when computing from message bytes is inconvenient.
- `signature`: Optional HyperCore sponsorship signature; only relevant for chains that use the sponsored destination periphery.

### Example Push Payload

```jsonc
{
  "message": {
    "data": "eyJidXJuVHJhbnNhY3Rpb25IYXNoIjoiMHgyMyIsInNvdXJjZUNoYWluSWQiOjg0NTMsIm1lc3NhZ2UiOnsi"
  }
}
```

After base64 decoding `message.data`, the JSON must conform to the `PubSubMessage` interface.

---

## Error Model & Retry Semantics

Typed errors in `errors.ts` drive retry decisions:

- `shouldRetry = true`: transient errors such as `NoAttestationFound`, `AttestationNotReady`, and `MintTransactionFailed` bubble up as HTTP 500 so Pub/Sub retries with exponential backoff.
- `shouldRetry = false`: permanent conditions like `AlreadyProcessed`, `SvmPrivateKeyNotConfigured`, or missing RPC URLs cause us to ACK the message (`success: true` or `success: false` but with `shouldRetry: false`), preventing queue thrashing.
- Unexpected errors default to retryable to avoid silently dropping messages.

---

## Configuration

### Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (defaults to `8080`). |
| `NODE_ENV` | Logged in the health endpoint. |
| `GCKMS_KEY_EVM`, `GCKMS_KEY_SVM` | Resource IDs for Google Cloud KMS keys that store the relayer’s signing keys (e.g. `<evm-key-name>`, `<svm-key-name>`). |
| `GCKMS_CONFIG` | JSON describing the KMS project/key-ring and encrypted payload location. Example: `{"mainnet":{"finalizer-evm":{"projectId":"<gcp-project-id>","locationId":"<region>","keyRingId":"<key-ring>","cryptoKeyId":"<crypto-key>","ciphertextBucket":"<bucket>","ciphertextFilename":"<ciphertext-file>"},"finalizer-svm":{"projectId":"<gcp-project-id>","locationId":"<region>","keyRingId":"<key-ring>","cryptoKeyId":"<crypto-key>","ciphertextBucket":"<bucket>","ciphertextFilename":"<ciphertext-file>"}}}`. |
| `GCP_STORAGE_CONFIG` | JSON config for Google Cloud Storage, e.g. `{"projectId":"<gcp-project-id>"}`. |
| `GOOGLE_CLOUD_PROJECT` | Deployment project (e.g. `<gcp-project-id>`). |

### RPC Endpoints

`getRpcUrlForChain` enforces explicit RPC URLs. Set only the ones you need, but missing values for active destinations throw `RpcUrlNotConfiguredError`.

- Mainnets: `ETHEREUM_RPC_URL`, `OPTIMISM_RPC_URL`, `POLYGON_RPC_URL`, `ARBITRUM_RPC_URL`, `BASE_RPC_URL`, `UNICHAIN_RPC_URL`, `LINEA_RPC_URL`, `WORLD_CHAIN_RPC_URL`, `HYPEREVM_RPC_URL`, `BSC_RPC_URL`, `MONAD_RPC_URL`, `SOLANA_RPC_URL`.
- Testnets: `SEPOLIA_RPC_URL`, `OPTIMISM_SEPOLIA_RPC_URL`, `ARBITRUM_SEPOLIA_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `POLYGON_AMOY_RPC_URL`, `ARBITRUM_NOVA_SEPOLIA_RPC_URL`, `HYPEREVM_TESTNET_RPC_URL`, `SOLANA_DEVNET_RPC_URL`.

All RPC URLs should include authentication if the upstream provider requires it.

## Local Development & Testing

1. **Install dependencies** (from repo root):
   ```bash
   yarn install
   ```
2. **Export required environment variables.**
3. **Run the service**:
   ```bash
   PORT=8081 ts-node src/cctp-finalizer/index.ts
   ```
4. **Simulate a Pub/Sub push**:
   ```bash
   curl -X POST http://localhost:8081/ \
     -H "Content-Type: application/json" \
     -d '{"message":{"data":"<base64-encoded PubSubMessage>"}}'
   ```

## Reference

- `src/cctp-finalizer/index.ts` – server bootstrap, signal handlers.
- `src/cctp-finalizer/app.ts` – HTTP layer and Pub/Sub contract.
- `src/cctp-finalizer/services/cctpService.ts` – orchestration logic.
- `src/cctp-finalizer/utils/evmUtils.ts` – EVM minting helpers.
- `src/cctp-finalizer/utils/svmUtils.ts` – Solana minting helpers, PDA derivations, account wiring.
- `src/cctp-finalizer/errors.ts` – typed errors driving retry semantics.
- `src/common/ContractAddresses.ts`, `src/utils/CCTPUtils.ts`, `src/utils/SDKUtils.ts` – shared primitives for contracts, protobuf decoding, and Circle API helpers.

