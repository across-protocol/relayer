## Architecture

## Monorepo

This repo is structured as a monorepo containing code to run bots covering all important roles in the Across ecosystem that involve transfers of capital between users.

This repo originally started off as just containing the code to run an Across relayer, hence the name of the repo containing "relayer", but we found that the prerequisite state required to run a relayer are also required to run other user roles like the dataworker and finalizer. For example, the `SpokePoolClient` is used in all three of these roles because they all rely on fetching up to date, accurate event state from one or many SpokePool contracts that Across supports.

Therefore, for the purpose of code re-use, this repo has evolved into a monorepo over time and it is better to think of this repo as a "bots" repo rather than a "relayer" repo.