# mend — one patch tool for every AI edit format

[![bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/haoye2023/makefun-mend-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/haoye2023/makefun-mend-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for the make.fun bounty [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

`mend` is a single command-line tool (Node 22, standard library only) that
applies AI-generated edits to files, whatever format the edit arrives in:
unified diffs, search-and-replace blocks, and whole-file rewrites. It parses
each format, applies the change atomically, and reports exactly what it did.

## Layout

- `main.ts` — the mend tool itself: format detection, parsing, application.
- `runner.ts` — the entry runner used by the bounty harness.

## License

MIT — see `LICENSE`.
