// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang package root — the orchestrator plugin (row id: fang-orchestrator).
// The split-row patch installs each sub-plugin as its own loader row; this entry is
// the main plugin (2.0 in the product spec) and must stay the BARE package name,
// because the client-module scanner only maps a bare (two-segment scoped) specifier
// to a package manifest — a `@scope/pkg/subpath` row never reaches `dsh.client`.
// If the split rows ever fail to resolve, `./compose` mounts every sub-plugin as a
// nested fiber from this same package.
export * from './plugins/orchestrator.mjs'
export { apply, Config, inject, name } from './plugins/orchestrator.mjs'
