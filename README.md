# Across V2 Relayer

This code implements [UMIP-157](https://github.com/UMAprotocol/UMIPs/blob/master/UMIPs/umip-157.md) and interacts with these [smart contracts](https://github.com/across-protocol/contracts-v2). The contracts were audited [by OpenZeppelin](https://blog.openzeppelin.com/uma-across-v2-audit/).

# Installation

```sh
# build
cd relayer-v2
yarn

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
