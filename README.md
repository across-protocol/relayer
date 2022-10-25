<div align="center">
  <br />
  <br />
  <a href="https://docs.across.to/v2/how-does-across-work/overview"><img alt="Across" src="https://2085701667-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2Fo33kX1T6RRp4inOcEH1d%2Fuploads%2F9CVfE3fSzsUxaZiqausI%2FAcross-green-darkbg.png?alt=media&token=8c84e972-794c-4b52-b9cf-0e5d7ae2270a" width=600></a>
  <br />
  <h3><a href="https://docs.across.to/v2/how-does-across-work/overview">Across</a> is a secure and instant asset-transfer bridge between EVM networks.</h3>
  <br />
</div>

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

# apply stylistic changes (e.g. eslint and prettier)
yarn lint-fix

# (for developers) continuously watch for changes and rebuild TS files as required
yarn watch
```

# Integration tests

You can conveniently run the dataworker, relayer, and finalizer functions via the hardhat task `integration-tests` which sets safe configurations like `PROPOSER_ENABLED=false` and prevents the user from accidentally sending an on-chain transaction. The test will complete successfully if no functions throw an error, which can be used as an additional source of confidence (in addition to the unit tests) that code has not broken the production bots.

```sh
# Run with gckms keys
LOG_IN_TEST=true yarn hardhat integration-tests --wallet gckms --keys bot2
# Run with MNEMONIC
LOG_IN_TEST=true yarn hardhat integration-tests --wallet mnemonic
```

# Prerequisites
After installing dependencies and building the repository, be sure to to [install RedisDB](https://redis.io/docs/getting-started/installation/), an in-memory storage layer that is required to make the bots work. The bots query blockchain RPCs for a lot of smart contract events so its important that the bot
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

# How to run a Relayer

Check out [this guide](https://docs.across.to/v2/developers/running-a-relayer) for detailed bot instructions!

# Community 

General discussion happens most frequently on the [Across discord](https://discord.com/invite/across).

# Contributing

Read through [CONTRIBUTING.md](https://github.com/UMAprotocol/protocol/blob/master/CONTRIBUTING.md) for a general overview of our contribution process. These guidelines are shared between the UMA and Across codebases because they were built originally by the same teams. 

# Bug Bounty

Here's the official Across [bug bounty program](https://docs.across.to/v2/miscellaneous/bug-bounty).

# Branching Model

## Active Branches

| Branch          | Status                                                                           |
| --------------- | -------------------------------------------------------------------------------- |
| [master](https://github.com/across-protocol/relayer-v2/tree/master)                   | Accepts PRs from `develop` when we intend to deploy to mainnet.                                      |
| [develop](https://github.com/across-protocol/relayer-v2/tree/develop)                 | Accepts PRs that are compatible with `master` OR from `release/X.X.X` branches.                    |
| release/X.X.X                                                                          | Accepts PRs for all changes, particularly those not backwards compatible with `develop` and `master`. |

## Overview

We generally follow [this Git branching model](https://nvie.com/posts/a-successful-git-branching-model/).
Please read the linked post if you're planning to make frequent PRs into this repository (e.g., people working at/with UMA).

## Production branch

Our production branch is `master`. The `master` branch contains the code for our latest "stable" releases.

## Development branch

Pull requests directed towards this branch should be backwards compatible with `master`.

## Release candidate branches

Branches marked `release/X.X.X` are **release candidate branches**.
Changes that are not backwards compatible with `master` MUST be directed towards a release candidate branch.
Release candidates are merged into `develop` and then into `master` once they've been fully deployed.
We may sometimes have more than one active `release/X.X.X` branch if we're in the middle of a deployment.
See table in the **Active Branches** section above to find the right branch to target.

# Release Process

Merge all features from `develop` into `master` that you want to include in the new release. We use GitHub's native release feature to manually trigger releases for now, follow [this documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) for more information.

When selecting a tag, select "Create a new tag: on publish" to have GitHub default to a tag, and set the "target" to `master`.

TODO: Decide on naming convention. We could go with the usual v1.2.3 and v5.9-beta.3. style, or we could select to use more catchy names like how [Lighthouse](https://github.com/sigp/lighthouse/releases) releases Beacon Client versions.

## Pre-releases

We aim to publish releases *infrequently*, therefore there should be good reason to _not_ mark a release as a "pre-release. For example, if there are emergency bug fixes that need to be introduced, or several important (and potentiall breaking) features.


## Documenting changes

Every merged PR into `master` should be following the [conventional commit](https://www.conventionalcommits.org/en/v1.0.0/) format, as documented in [CONTRIBUTING.md](https://github.com/UMAprotocol/protocol/blob/master/CONTRIBUTING.md). This should allow the GitHub release to auto-populate the changes introduced in the new release.

# License

All files within this repository are licensed under the [TODO](TODO) unless stated otherwise.