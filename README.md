<div align="center">
  <br />
  <br />
  <a href="[https://docs.across.to/](https://docs.across.to/)"><img alt="Across" src="https://2085701667-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2Fo33kX1T6RRp4inOcEH1d%2Fuploads%2F9CVfE3fSzsUxaZiqausI%2FAcross-green-darkbg.png?alt=media&token=8c84e972-794c-4b52-b9cf-0e5d7ae2270a" width=600></a>
  <br />
  <h3><a href="[https://docs.across.to/](https://docs.across.to/)">Across</a> is a secure and instant asset-transfer bridge between EVM networks.</h3>
  <br />
</div>

# Across V3 Relayer

This code implements [UMIP-157](https://github.com/UMAprotocol/UMIPs/blob/master/UMIPs/umip-157.md) and interacts with these [smart contracts](https://github.com/across-protocol/contracts). The contracts were audited [by OpenZeppelin](https://blog.openzeppelin.com/across-v3-incremental-audit).

# How to run a Relayer

Check out [this guide](https://docs.across.to/relayers/running-a-relayer) for detailed bot instructions!

## Prerequisites

After installing dependencies and building the repository, be sure to [install RedisDB](https://redis.io/docs/getting-started/installation/), an in-memory storage layer that is required to make the bots work. The bots query blockchain RPCs for a lot of smart contract events so it's important that the bot
cache some of this data in order to maintain its speed.

The first time that the bot runs, it might be slower than usual as the Redis DB fills up. This slowdown should disappear on subsequent runs.

Start the `redis` server in a separate window:

```sh
redis-server
```

When running the bot, be sure to set the following environment variable

```sh
REDIS_URL=redis://localhost:6379
```

## Installation

```sh
# install dependencies
cd relayer
yarn install

# build relayer bot
yarn build
```

# Community

General discussion happens most frequently on the [Across discord](https://discord.across.to).

# License

All files within this repository are licensed under the [GNU Affero General Public License](LICENCE) unless stated otherwise.

# Developers

## Contributing

```sh
# run test suite
yarn test

# apply stylistic changes (e.g. eslint and prettier)
yarn lint-fix
```

Read through [CONTRIBUTING.md](https://github.com/UMAprotocol/protocol/blob/master/CONTRIBUTING.md) for a general overview of our contribution process. These guidelines are shared between the UMA and Across codebases because they were built originally by the same teams.

## Bug Bounty

Here's the official Across [bug bounty program](https://docs.across.to/resources/bug-bounty). The bug bounty only applies to the `master` branch and is agnostic of release versions.

## Integration tests

You can conveniently run the dataworker, relayer, and finalizer functions via the hardhat task `integration-tests` which sets safe configurations like `PROPOSER_ENABLED=false` and prevents the user from accidentally sending an on-chain transaction. The test will complete successfully if no functions throw an error, which can be used as an additional source of confidence (in addition to the unit tests) that code has not broken the production bots.

If you want to read more about the three different agents in the Across system, check out the [docs](https://docs.across.to/reference/actors-in-the-system).

```sh
LOG_IN_TEST=true yarn hardhat integration-tests --wallet mnemonic
```

## Branching Model

### Active Branches

| Branch                                                           | Status           |
| ---------------------------------------------------------------- | ---------------- |
| [master](https://github.com/across-protocol/relayer/tree/master) | Accepts all PRs. |

### Overview

Longer term we'd ideally like to follow [this Git branching model](https://nvie.com/posts/a-successful-git-branching-model/), but for now we manually trigger GitHub releases to demarcate features that we'd like to "release" for public usage.

### Production branch

Our production branch is `master` and releases are only made from `master`.

## Release Process

Merge all features into `master` that you want to include in the new release. We use GitHub's native release feature to manually trigger releases, follow [this documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) for more information.

When selecting a tag, select "Create a new tag: on publish" to have GitHub default to a tag, and set the "target" to `master`.

We use [Semantic Versioning](https://semver.org/) for naming releases and we aim to publish `major` and `minor` releases very rarely (and with very detailed notes).

### NPM

`.github/workflows/publish.yml` will automatically publish a new `NPM` package whenever a GitHub release is made. This will not happen for pre-releases.

### Pre-releases

We publish pre-releases to signal to users about potential releases that are risky to use in production setups.

### Documenting changes

Every merged PR into `master` should be following the [conventional commit](https://www.conventionalcommits.org/en/v1.0.0/) format, as documented in [CONTRIBUTING.md](https://github.com/UMAprotocol/protocol/blob/master/CONTRIBUTING.md).
