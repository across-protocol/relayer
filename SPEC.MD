# Polymarket Cross-Chain Buy via Across Relayer (MVP)

## 1. Overview
Enable a user on any supported origin chain to buy Polymarket YES/NO outcome tokens on Polygon with a single Across deposit. The relayer (solver) uses its own USDC.e on Polygon to execute the Polymarket order and is reimbursed by Across. Delivery of outcome tokens is enforced on-chain via a custom handler contract invoked during the Across fill.

This spec targets an MVP with:
- Buy-only
- Marketable limit orders
- FOK (all-or-nothing)
- Solver keeps price improvement

## 2. Goals
- One-click UX: user initiates a single Across deposit on origin chain.
- Atomic delivery guarantee on Polygon: solver only receives bridged USDC if outcome tokens are delivered.
- Minimal relayer modifications, easy to reason about.

## 3. Non-goals (MVP)
- Sell orders
- Partial fills (FAK)
- On-origin refund of price improvement
- Unified one-click signature (no user Polymarket API credentials are used)
- Generalized multi-market batching

## 4. Actors
- **User**: deposits USDC on origin chain.
- **Relayer / Solver**: watches deposits, trades on Polymarket, executes Across fill.
- **Across SpokePool**: performs fill on Polygon and calls handler contract.
- **Polymarket CLOB**: offchain matching engine; orders are placed via API client.
- **PolymarketHandler (new contract)**: receives USDC.e from fill and atomically swaps custody for outcome tokens.

## 5. High-Level Flow
1. **User Deposit (Origin Chain)**
   - User submits `depositV3` with:
     - `destinationChainId = 137 (Polygon)`
     - `outputToken = USDC.e` (Polygon USDC.e)
     - `recipient = PolymarketHandler` (Polygon handler contract)
     - `message = POLY_ORDER_V1` ABI-encoded payload

2. **Relayer Detects Intent**
   - Relayer parses `message` and validates:
     - `intent.solver == relayer EOA`
     - `recipient == configured PolymarketHandler`
     - `outputToken` is USDC.e
     - `orderType = FOK`, `side = BUY`

3. **Relayer Executes Polymarket Order (Offchain)**
   - Relayer uses its **own** Polygon EOA + L2 API creds to place a **marketable limit** order using the Polymarket CLOB client.
   - Per Polymarket’s docs, the relayer must:
     - Use an **L1 signer** once to create/derive API credentials.
     - Use **L2 API creds** (key/secret/passphrase) for order placement and signing.
   - The order buys `intent.outcomeAmount` shares at `intent.limitPrice` (FOK).
   - If the order does **not fully fill**, the relayer does **not** fill the Across deposit. The deposit later refunds on the origin chain.

4. **Relayer Fills Across Deposit (Onchain)**
   - Relayer calls `fillV3Relay` on the Polygon SpokePool.
   - SpokePool transfers USDC.e to the **PolymarketHandler** and then calls:
     `handleV3AcrossMessage(tokenSent, amount, relayer, message)`.

5. **PolymarketHandler Enforces Delivery (Onchain)**
   - Validates `msg.sender == SpokePool` and `relayer == intent.solver`.
   - Transfers **ERC1155 outcome tokens** from solver to user (`safeTransferFrom`).
   - Transfers **USDC.e** to solver.
   - If any transfer fails, the handler reverts, which makes the fill fail and prevents solver reimbursement.

## 6. PolymarketHandler Contract (On-chain)
### Interface
Across requires the handler to implement:
```
function handleV3AcrossMessage(
    address tokenSent,
    uint256 amount,
    address relayer,
    bytes memory message
) external;
```

### Behavior
- **Inputs**: `tokenSent`, `amount` must be trusted (enforced by SpokePool); `message` must be treated as untrusted data.
- **Checks**:
  - `msg.sender` is the configured SpokePool
  - `relayer == intent.solver`
- **Effects**:
  - ERC1155 transfer of `intent.outcomeAmount` from solver -> user
  - ERC20 transfer of `amount` from handler -> solver

### Pre-requisites
- Solver must `setApprovalForAll(handler, true)` on the Polymarket outcome token contract.
- Handler must be configured with an **allowlist** (or single address) of approved solvers.

## 7. Intent Message Schema (ABI-encoded)
ABI-encoded tuple (versioned):
```
struct PolyOrderIntentV1 {
  uint8   version;        // = 1
  address recipient;      // user on Polygon
  address solver;         // relayer EOA expected to fill
  address outcomeToken;   // Polymarket ERC1155 contract
  uint256 tokenId;        // outcome token ID
  uint256 outcomeAmount;  // shares to buy (1e6 scaling)
  uint256 limitPrice;     // price per share (1e6, USDC decimals)
  bytes32 clientOrderId;  // originChainId:depositId hash
}
```
Notes:
- `limitPrice` is expressed in **USDC 6 decimals** (e.g., $0.53 => 530000).
- `outcomeAmount` is expressed in **1e6 shares** to avoid floating-point amounts in messages.
- `clientOrderId` is used only for logging / deduplication.
- `solver` in the message is enforced by both relayer and handler.

## 8. Relayer Additions (Offchain)
### New Modules
- `PolymarketIntentParser`: decode `message` to `PolyOrderIntentV1`.
- `PolymarketClient`: wrapper around `@polymarket/clob-client` for:
  - L1 auth -> derive L2 creds (if not supplied)
  - `createOrder` + `postOrder` with `OrderType.FOK` (or `createAndPostOrder` equivalent)
  - convert `limitPrice`/`outcomeAmount` (1e6 scaling) into float `price`/`size` for the client
  - optional builder attribution
  - fetch `tickSize` / `negRisk` (Gamma API or CLOB market metadata)
  - configure `signatureType` + `funder` per Polymarket account type (EOA = 0)

### Steps in Relayer
- Filter deposits to those with `POLY_ORDER_V1` message and destination Polygon.
- Validate solver matches relayer EOA.
- Submit Polymarket FOK order using solver funds.
- If order **fully fills**, call `fillV3Relay` (trigger handler).
- If order **fails**, skip deposit (origin refund later).

## 9. Assumptions & Constraints
- Polymarket trading uses **marketable limit orders** via CLOB client (`https://clob.polymarket.com`).
- Orders require **L2 API credentials**, derived once from the relayer’s L1 signer (or pre-provisioned).
- Relayer must reinitialize the CLOB client with **signatureType** + **funder** (EOA = 0; funder = relayer EOA).
- Builder API credentials, if used, are **attribution only** and do not replace user API credentials.
- Only **BUY** orders are supported.
- **FOK** only; no partial fills.
- Solver funds execution; Across repays solver on fill.
- User `outputAmount` should cover worst-case cost: `limitPrice * outcomeAmount` (plus fees, if any).
- **Price improvement is kept by solver** (MVP). No on-origin refund.
- **Any market** is allowed (no allowlist).
- `tokenId` is provided by the user (UI uses Gamma API).
- `outcomeAmount` scaling assumes Polymarket outcome tokens use 1e6 base units per share; confirm against CTF token units and adjust if needed.
- `recipient` is assumed to be an EOA; if a contract, it must implement ERC1155 receiver hooks.
- Solver must have sufficient **USDC.e** and Polymarket **exchange/CTF approvals** to place orders.

## 10. Failure Modes & Refunds
- **Order fails / not fully filled**: relayer skips fill; deposit refunded by Across.
- **CLOB rejects the order** (e.g. invalid tick size / min size / FOK not filled): relayer skips fill.
- **Handler reverts**: fill fails; deposit eventually refunds on origin chain.
- **Insufficient solver balance / approval**: order fails or handler reverts.

## 11. Observability
- Relayer logs include: `depositId`, `clientOrderId`, `tokenId`, `size`, `limitPrice`, `orderId`, `status`.
- ERC1155 `TransferSingle` event on Polygon proves outcome delivery.

## 12. Future Improvements
- Refund price improvement to user (Polygon or origin chain).
- Support FAK (partial fills) with proportional outcome transfer.
- Support SELL intents.
- Move to true one-click signatures by introducing a message-only deposit type.
- Add signed intent payloads from the user for stronger integrity guarantees.

## 13. Reviewer Feedback (Resolved)
- **Q: How does the handler avoid trusting spoofed message data?**
  - A: The handler trusts only `tokenSent` and `amount` from SpokePool and validates `relayer == solver` from message. Message data is still treated as untrusted; the solver refuses fills if message is malformed.
- **Q: What if outcome transfer succeeds but USDC transfer fails?**
  - A: The handler uses `SafeERC20` and reverts on failure, preventing reimbursement without delivery.
- **Q: How is limitPrice precision represented?**
  - A: `limitPrice` is in 1e6 (USDC decimals); the relayer converts to float for the Polymarket client.
