# Finalizer

## Binance withdrawal addresses

`FINALIZER_WITHDRAWAL_TO_ADDRESSES` maps each EOA to the token symbols it may receive. Binance deposits are returned only to their attributed, authorized EOA. Map order matters: the first EOA authorizing a symbol receives any genuinely orphaned balance for that symbol.
