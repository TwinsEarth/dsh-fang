// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — SSRF guard：私网/元数据地址拒绝 + DNS 预检 + allowlist 语义。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertEndpointSafe,
  classifyEndpointHost,
  isMetadataAddress,
  isMetadataHost,
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
} from '../src/lib/ssrf-guard.mjs'

test('ssrf-guard: private IPv4/IPv6 ranges', () => {
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1']) {
    assert.equal(isPrivateIpv4(ip), true, ip)
  }
  for (const ip of ['1.2.3.4', '8.8.8.8', '172.32.0.1', '192.169.1.1', '101.64.0.1']) {
    assert.equal(isPrivateIpv4(ip), false, ip)
  }
  for (const ip of ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateIpv6(ip), true, ip)
  }
  for (const ip of ['2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateIpv6(ip), false, ip)
  }
  assert.equal(isPrivateAddress('10.0.0.1'), true)
  assert.equal(isPrivateAddress('1.1.1.1'), false)
})

test('ssrf-guard: cloud metadata addresses and hostnames are always blocked', () => {
  assert.equal(isMetadataAddress('169.254.169.254'), true)
  assert.equal(isMetadataAddress('100.100.100.200'), true)
  assert.equal(isMetadataAddress('fd00:ec2::254'), true)
  assert.equal(isMetadataHost('metadata.google.internal'), true)
  assert.equal(classifyEndpointHost('169.254.169.254').reason, 'metadata-address-blocked')
  assert.equal(classifyEndpointHost('metadata.google.internal').reason, 'metadata-address-blocked')
  // 即使显式加入 allowlist，元数据地址也不能放行。
  assert.equal(classifyEndpointHost('169.254.169.254', { allowHosts: ['169.254.169.254'] }).reason, 'metadata-address-blocked')
})

test('ssrf-guard: private literal needs explicit allowlist; loopback is allowed', () => {
  assert.equal(classifyEndpointHost('10.0.0.5').reason, 'private-address-blocked')
  assert.equal(classifyEndpointHost('10.0.0.5', { allowHosts: ['10.0.0.5'] }).ok, true)
  assert.equal(classifyEndpointHost('127.0.0.1').kind, 'loopback')
  assert.equal(classifyEndpointHost('::1').kind, 'loopback')
  assert.equal(classifyEndpointHost('localhost').kind, 'loopback')
  assert.equal(classifyEndpointHost('8.8.8.8').kind, 'public-ipv4')
  assert.equal(classifyEndpointHost('example.com').kind, 'hostname')
})

test('ssrf-guard: DNS preflight blocks public names resolving to private/metadata', async () => {
  const privateResolver = async () => [{ address: '10.0.0.7', family: 4 }]
  assert.equal((await assertEndpointSafe('public.example.com', { resolve: privateResolver })).reason, 'private-address-blocked')
  const metadataResolver = async () => [{ address: '169.254.169.254', family: 4 }]
  assert.equal((await assertEndpointSafe('public.example.com', { resolve: metadataResolver })).reason, 'metadata-address-blocked')
  const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }]
  assert.equal((await assertEndpointSafe('example.com', { resolve: publicResolver })).ok, true)
  const unresolved = async () => { throw new Error('ENOTFOUND') }
  assert.equal((await assertEndpointSafe('nxdomain.example', { resolve: unresolved })).ok, true, 'NXDOMAIN is left to fetch failure')
  // allowlist 允许该主机解析到私网（显式信任），但不允许解析到元数据。
  assert.equal((await assertEndpointSafe('ollama.lan', { resolve: privateResolver, allowHosts: ['ollama.lan'] })).ok, true)
  assert.equal((await assertEndpointSafe('ollama.lan', { resolve: metadataResolver, allowHosts: ['ollama.lan'] })).reason, 'metadata-address-blocked')
  // 字面量路径不触发 DNS。
})
