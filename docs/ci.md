# CI

CI runs on a self-hosted GitHub Actions runner; GitHub-hosted runners are not used.
The workflow is `.github/workflows/ci.yml`: lint, typecheck, tests, build and a CLI smoke check on Linux.
It runs on every push to `main`, on pull requests from branches of this repository, and by hand (`gh workflow run ci`).
Pull requests from forks never run on the runner, and outside contributors need approval before any workflow runs.

Windows is covered by local runs, since development happens on Windows; there is no macOS runner.

## Runner

| Runner | Where | Labels |
|---|---|---|
| `homelab` | homelab, container `gh-runner-motionclone` in `~/docker/gh-runner-motionclone` | `self-hosted, linux, homelab, node-linux` |

The image is the official actions runner plus the Chromium system libraries Playwright needs.
Node and pnpm come from the setup actions in each job.
The container is limited to 4 GB of memory and 3 CPUs at low CPU priority, so the other homelab services win.
Jobs target the pool label `node-linux`, so a second Linux runner with that label can be added without changing the workflow.

The registration is kept in the `state` volume; a recreate reconnects without a new token.
Re-register only after deleting that volume: `RUNNER_TOKEN=<token> docker compose up -d`.
Get a token with `gh api -X POST repos/codename-zen/motionclone/actions/runners/registration-token -q .token`.
