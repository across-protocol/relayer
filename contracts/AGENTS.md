# AGENTS.md - contracts

This folder contains utility smart contracts that are designed to facilitate transactions for bots that exist in this repository.

For example, the `AtomicWethDepositor` contract is designed  to allow the relayer to atomically (i.e. in one on-chain transaction) wrap native ETH into WETH and bridge that WETH to a destination network. This is helpful because its more convenient for the relayer to execute this wrap-and-bridge transaction in a single transaction than submit two successive transactions.

The contracts that begin with `Mock` prefixes are used primarily for unit testing only.