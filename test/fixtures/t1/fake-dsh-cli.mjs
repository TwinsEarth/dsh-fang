// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// Fake `dsh web` CLI for forker tests. NEVER launch a real dsh in tests.
//
// Behaviour is selected by FAKE_DSH_MODE so one fixture covers every spawn outcome:
//   ok          print the tokenized banner and stay alive   (happy path)
//   split       print the banner in two chunks              (rolling-buffer parse)
//   silent      never print a URL and stay alive            (timeout path)
//   crash       exit with code 3                            (crash / classifyExit)
//   restart     exit with code 75                           (guard-allowed restart)
//   exit-clean  exit with code 0                            (normal exit)
//
// v2 port contract: the fake CLI echoes the `--port N` argument it was launched with, so a
// test can assert the forker really passed the deterministic pool port and that the parsed
// URL carries it. `FAKE_DSH_PORT` overrides the *printed* port only — that is how a test
// simulates a child that ignored `--port N` (the forker must then fail with port-mismatch).
//
// The first lines let tests assert the launch spec really reached the child:
//   fake-dsh home=<DSH_HOME>                                  -> env propagation
//   fake-dsh role=<DSH_FANG_ROLE> task=<DSH_FANG_TASK_ID>     -> fork identity injection
//   fake-dsh argv=--profile web --port 0 ...                  -> buildSpawnArgs -wired argv
const argv = process.argv.slice(2)

// `node --test` (bare / directory scan) discovers EVERY file under test/ — fixture files
// included — and would otherwise wait forever on this intentionally long-lived process.
// fang-forker always launches the CLI with `--profile`; any other argv means "discovered
// as a test file", so exit 0 immediately and let the scan pass.
if (!argv.includes('--profile')) {
  console.log('fake-dsh-cli: not launched by fang-forker (no --profile) — exiting immediately')
  process.exitCode = 0
} else {
  main()
}

function printedPort() {
  if (process.env.FAKE_DSH_PORT !== undefined) return Number(process.env.FAKE_DSH_PORT)
  const i = argv.indexOf('--port')
  const argPort = i >= 0 ? Number(argv[i + 1]) : 0
  // `--port 0` means "OS picked a port"; 54321 is the fixture's stand-in for that.
  return Number.isInteger(argPort) && argPort > 0 ? argPort : 54321
}

function main() {
  const keepAlive = () => setInterval(() => {}, 1000)
  const mode = process.env.FAKE_DSH_MODE || 'ok'
  const port = printedPort()
  const banner = `dsh web: http://127.0.0.1:${port}/?token=fake-token`

  process.stdout.write(`fake-dsh home=${process.env.DSH_HOME ?? ''}\n`)
  process.stdout.write(`fake-dsh role=${process.env.DSH_FANG_ROLE ?? ''} task=${process.env.DSH_FANG_TASK_ID ?? ''}\n`)
  process.stdout.write(`fake-dsh argv=${argv.join(' ')}\n`)

  if (mode === 'silent') {
    process.stdout.write('fake-dsh: booting (no banner yet)\n')
    keepAlive()
  } else if (mode === 'crash') {
    process.stderr.write('fake-dsh: boom\n')
    process.exitCode = 3
  } else if (mode === 'restart') {
    process.exitCode = 75
  } else if (mode === 'exit-clean') {
    process.exitCode = 0
  } else if (mode === 'split') {
    process.stdout.write('dsh web: http://127.0.0.1:')
    setTimeout(() => {
      process.stdout.write(`${port}/?token=split-token\n`)
      keepAlive()
    }, 40)
  } else {
    process.stdout.write(`${banner}\n`)
    keepAlive()
  }
}
