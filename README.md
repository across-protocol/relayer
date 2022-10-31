# Across V2 Relayer

This code implements [UMIP-157](https://github.com/UMAprotocol/UMIPs/blob/master/UMIPs/umip-157.md) and interacts with these [smart contracts](https://github.com/across-protocol/contracts-v2). The contracts were audited [by OpenZeppelin](https://blog.openzeppelin.com/uma-across-v2-audit/).

# Installation

```sh
# install dependencies
cd relayer-v2
yarn install

# build relayer bot
yarn build

# run test suite
yarn test
```

# How to run a relayer using this code

First, be sure to [install RedisDB](https://redis.io/docs/getting-started/installation/), an in-memory storage layer that will significantly speed up bot
runs after the first time in which it fills the database.

Start the `redis` server in a separate window from the bot:

```sh
redis-server
```

When running the bot, be sure to set the following environment variable

```sh
REDIS_URL=redis://localhost:6379
```

Check out [this guide](https://docs.across.to/v2/developers/running-a-relayer) for detailed bot instructions!

# Development

```sh
# continuously watch for changes and rebuild as required
yarn watch
```

## Integration tests

You can conveniently run the dataworker, relayer, and finalizer functions via the hardhat task `integration-tests` which sets safe configurations like `PROPOSER_ENABLED=false` and prevents the user from accidentally sending an on-chain transaction. The test will complete successfully if no functions throw an error, which can be used as an additional source of confidence (in addition to the unit tests) that code has not broken the production bots.

```sh
# Run with gckms keys
yarn hardhat integration-tests --wallet gckms --keys bot2
# Run with MNEMONIC
yarn hardhat integration-tests --wallet mnemonic
```
