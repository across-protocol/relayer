# Fill Simulation Script

## Overview

`simulateFill.ts` is a backward-looking debugging tool that helps you understand why a fill transaction would have reverted. Given an origin deposit transaction, it:

1. Fetches the deposit details from the origin chain
2. Constructs a fill transaction for the destination chain
3. Creates a Tenderly simulation at a block 2-20 seconds after the fill (as close to 2 seconds as possible based on block times)
4. Returns a link to the Tenderly simulation for inspection

This is particularly useful for debugging failed fills or understanding state changes that would have occurred during a fill.

## Prerequisites

### 1. Tenderly Account Setup

You need a Tenderly account with API access:

1. Sign up at [https://tenderly.co](https://tenderly.co)
2. Create a new project in your dashboard
3. Generate an API access key from your account settings
4. Note your username and project name

### 2. Environment Configuration

Add the following variables to your `.env` file:

```bash
# Tenderly API Configuration
TENDERLY_ACCESS_KEY=your_tenderly_access_key
TENDERLY_USER=your_tenderly_username
TENDERLY_PROJECT=your_tenderly_project_name

# RPC providers (same as main relayer configuration)
RPC_PROVIDER_INFURA_1=https://mainnet.infura.io/v3/...
RPC_PROVIDER_INFURA_10=https://optimism-mainnet.infura.io/v3/...
# ... etc
```

## Usage

### Basic Usage

```bash
yarn ts-node ./scripts/simulateFill.ts --originChainId <chainId> --txnHash <transactionHash> [options]
```

### Parameters

**Required:**
- `--originChainId`: The chain ID where the deposit transaction occurred
- `--txnHash`: The transaction hash of the deposit on the origin chain
  - Alias: `--transactionHash`

**Optional:**
- `--relayer`: The address to use as the sender (`from`) in the Tenderly simulation
  - Default: `0x07aE8551Be970cB1cCa11Dd7a11F47Ae82e70E67`
- `--delay`: Seconds after deposit to simulate the fill (0-3600)
  - Default: `2`
  - Use `0` to simulate immediately after deposit
  - Use higher values (10, 30, 60) to simulate fills that happened later

### Examples

#### Simulate a fill for a mainnet deposit:

```bash
yarn ts-node ./scripts/simulateFill.ts \
  --originChainId 1 \
  --txnHash 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
```

#### Simulate a fill for an Optimism deposit:

```bash
yarn ts-node ./scripts/simulateFill.ts \
  --originChainId 10 \
  --txnHash 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
```

#### Simulate with a custom relayer address:

```bash
yarn ts-node ./scripts/simulateFill.ts \
  --originChainId 1 \
  --txnHash 0x123... \
  --relayer 0xYourCustomAddress
```

#### Simulate with a longer delay (10 seconds after deposit):

```bash
yarn ts-node ./scripts/simulateFill.ts \
  --originChainId 1 \
  --txnHash 0x123... \
  --delay 10
```

#### Simulate immediately after deposit (0 second delay):

```bash
yarn ts-node ./scripts/simulateFill.ts \
  --originChainId 1 \
  --txnHash 0x123... \
  --delay 0
```

#### Combine multiple options:

```bash
yarn ts-node ./scripts/simulateFill.ts \
  --originChainId 1 \
  --txnHash 0x123... \
  --relayer 0xYourAddress \
  --delay 5
```

## How It Works

### 1. Deposit Fetching

The script connects to the origin chain and fetches the deposit transaction:
- Extracts the `FundsDeposited` event from the transaction logs
- Decodes the deposit parameters (amounts, tokens, recipient, etc.)
- Determines the destination chain from the deposit
- **Captures the deposit block number and timestamp**

### 2. Fill Construction

Using the deposit data, the script constructs a fill transaction:
- Uses the same `populateV3Relay` function as the actual relayer
- Constructs the transaction with the specified relayer address (defaults to `0x07aE8551Be970cB1cCa11Dd7a11F47Ae82e70E67`)
- Generates the raw transaction data that would be submitted

### 3. Historical Block Lookup

The script finds the correct historical block for simulation:
- **Calculates target timestamp: deposit timestamp + delay seconds (default 2)**
- Uses the built-in block finder utility to find the destination chain block closest to that timestamp
- Falls back to block time approximation if block finder fails
- This ensures the simulation runs with the correct historical state (token balances, contract state, etc.)

**Why the delay matters:**
- **Short delays (0-5s)**: Simulate immediate fills, useful for debugging fast relayer issues
- **Medium delays (5-30s)**: Typical fill times for most deposits
- **Long delays (30-3600s)**: Simulate fills that took longer, useful for:
  - Checking if a fill would have succeeded after token approvals
  - Debugging fills that happened during periods of high congestion
  - Understanding state changes over time

### 4. Tenderly Simulation

Creates a **public simulation** on Tenderly with:
- The fill transaction data
- **The historical block number (delay seconds after deposit timestamp, default 2)**
- The specified relayer address as the transaction sender (default: `0x07aE8551Be970cB1cCa11Dd7a11F47Ae82e70E67`)
- The destination SpokePool address as the target contract

The simulation is created as **public by default**, generating a shareable link that anyone can view without needing a Tenderly account. This makes it easy to:
- Share debugging results with your team
- Include simulation links in GitHub issues
- Document fill failures in incident reports

**Important**: Because the simulation uses the historical block from when the deposit occurred, you'll see the actual state of the blockchain at that time, not the current state. This is crucial for debugging why a fill might have failed - you need to see the balances, approvals, and contract state as they existed when the fill should have been executed.

You can adjust the `--delay` parameter to simulate at different points in time:
- Use the default (2s) for typical fast fills
- Increase the delay to see how the blockchain state changed over time
- Use 0 to simulate at the exact moment of the deposit

### 5. Results

Returns a **public shareable URL** to the Tenderly simulation dashboard where you can:
- See if the transaction would succeed or revert
- Inspect all state changes
- View emitted events
- Analyze gas usage
- Debug any reverts with detailed stack traces

**Note**: All simulations are created as public by default, so you can share the URL with teammates or include it in issue reports without requiring them to have Tenderly access.

## Supported Chains

The script supports all EVM chains in the Across protocol. Chain IDs and average block times are configured in the `AVERAGE_BLOCK_TIMES` mapping.

Currently supported chains include:
- Ethereum (1): 12s blocks
- Optimism (10): 2s blocks
- Polygon (137): 2s blocks
- Arbitrum (42161): 0.25s blocks
- Base (8453): 2s blocks
- ... and many more

Non-EVM chains (like Solana) are not yet supported and will return an error.

## Limitations

1. **EVM Only**: Currently only supports EVM-compatible destination chains
2. **Single Deposit**: If a transaction contains multiple deposits, you'll need to extend the script to support `--depositId` parameter
3. **Block Time Approximation**: Uses average block times which may not be exact for all chains at all times
4. **Tenderly Account Required**: Requires a Tenderly account with API access

## Troubleshooting

### "Missing Tenderly configuration" Error

Make sure you've added all three Tenderly environment variables to your `.env` file:
- `TENDERLY_ACCESS_KEY`
- `TENDERLY_USER`
- `TENDERLY_PROJECT`

### "No deposits found in txn" Error

The transaction hash you provided doesn't contain a deposit event. Verify:
- The transaction hash is correct
- The transaction is a deposit transaction (contains `FundsDeposited` event)
- You're using the correct origin chain ID

### "Invalid origin chain ID" Error

The chain ID you provided is not supported. Check the `CHAIN_IDs` enum in `@across-protocol/constants` for valid chain IDs.

### "Multiple deposits in transaction" Error

The transaction contains multiple deposits. The script currently only supports transactions with a single deposit. You'll need to extend the script to support the `--depositId` parameter to select a specific deposit.

## Future Enhancements

Potential improvements to this script:
- Support for multiple deposits in a single transaction via `--depositId`
- Support for SVM (Solana) destinations
- Configurable simulation time offset (currently hardcoded to 2 seconds)
- Batch simulation of multiple deposits
- Integration with other simulation platforms (e.g., BlockNative, Alchemy Simulation API)
- Historical block lookup to simulate at the exact time a fill would have occurred
