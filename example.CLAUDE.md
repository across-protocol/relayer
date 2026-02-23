# CLAUDE.md

_How an agent should behave and operate in this repo._

## Documentation System

Use docs in this order:

1. `AGENTS.md` (root): map of the repository and where to look next.
2. Module docs (`README.md` or local `AGENTS.md`): module behavior and local constraints.
3. `docs/*.md`: deeper architecture and protocol context.

Each layer has a separate purpose:

- `CLAUDE.md`: agent operating rules for this repository.
- Module docs: what must be understood to make a safe change in that module.
- `docs/`: background and deeper design context.

## Required Workflow

Before writing code:

1. Read root `AGENTS.md`.
2. Read docs for every module you will touch.
3. Confirm how behavior is validated in tests for that module.

Before opening a contribution:

1. Read [CONTRIBUTING.md](https://github.com/UMAprotocol/protocol/blob/master/CONTRIBUTING.md).
2. Follow `STYLE.md`.
3. Follow Conventional Commits guidance from `CONTRIBUTING.md`.
4. Read the Developers section in the root `README.md`.

## Non-Negotiable Rules

- Prefer minimal, local diffs over cross-cutting refactors.
- Preserve current behavior unless the task explicitly asks for behavior changes.
- Do not silently change risk-sensitive defaults (profitability, finality, rebalancing thresholds).
- If a change affects money movement logic, include explicit validation steps.
- Keep docs updated in the same change when behavior changes.

## Ambiguity and Escalation

Stop and ask for clarification if any of the following are true:

- The change crosses multiple module boundaries and design intent is unclear.
- You find conflicting patterns across modules and cannot infer the canonical one.
- A module appears to be in active refactor and interfaces are unstable.
- The change modifies signing, transfer, fill, refund, or finalization behavior.
- The right success criteria or test coverage is unclear.

## Validation Expectations

After code changes:

- Run targeted checks for edited modules first.
- Run broader tests when shared clients, interfaces, or config parsing is changed: `yarn test`.
- Lint via `yarn lint-fix`.
- Report exactly what was run and anything intentionally not run.
