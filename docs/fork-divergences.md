# Fork-only divergences

This repository is the maintained fork of `ai-outfitter/outfitter` (`origin`
here; `upstream` points at the official repository). Some behavior is
deliberately fork-local: it solves problems specific to this catalog and
machine setup that upstream should not absorb.

## Policy

- A divergence is recorded in this file and tracked as an issue in this fork
  repository. Fork-only changes are never opened as upstream issues or PRs.
- `main` stays current with `upstream/main`; the `batch/*` integration
  branches carry the fork's work. Syncing upstream into the fork prefers the
  fork's changes on conflict (`git merge upstream/main -X ours`).
- When upstream merges the fork's PRs, re-evaluate each divergence: drop it
  once upstream covers the need.

## Divergences

| Divergence                                                                                                | Tracking                                                 | Status             | Notes                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings-gated MCP materialization filename for the pi adapter (`pi_mcp_config_file`, default `mcp.json`) | [#1](https://github.com/raphaelbahat/outfitter/issues/1) | landed (`f460def`) | `mcp-adapter.json` keeps `pi-mcp-adapter` working after it moved off `mcp.json` (pi ≥0.87 ships built-in MCP support; the two systems cannot share one file in the same directory). Claude always materializes `mcp.json`; `dump` stays protocol-shaped; non-pi harnesses ignore the key. No upstream issue or PR by design. |
