// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// CommandCache 单测（契约：docs/COMMAND-CACHE.md）：
//   in-flight 合并 / completed 重放 / LRU 淘汰 / 失败契约 / 容量边界 / 回调隔离。
import test from 'node:test'
import assert from 'node:assert/strict'

import { COMMAND_CACHE_DEFAULT_CAPACITY, CommandCache } from '../src/lib/command-cache.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('首次 run 执行一次并落 completed；stats/get/size 一致', async () => {
  const cache = new CommandCache()
  let calls = 0
  const result = { status: 'completed', result: { pong: true } }
  const out = await cache.run('cmd_1', async () => {
    calls += 1
    return result
  })
  assert.equal(calls, 1)
  assert.deepEqual(out, result)
  assert.equal(cache.size(), 1)
  assert.equal(cache.has('cmd_1'), true)
  assert.deepEqual(cache.get('cmd_1'), result)
  const stats = cache.stats()
  assert.equal(stats.total, 1)
  assert.equal(stats.running, 0)
  assert.equal(stats.completed, 1)
  assert.equal(stats.capacity, COMMAND_CACHE_DEFAULT_CAPACITY)
  assert.equal(stats.executions, 1)
  assert.equal(stats.hits, 0)
})

test('completed 命中：重放结果，不重复执行', async () => {
  const cache = new CommandCache()
  let calls = 0
  const result = { status: 'completed', result: 7 }
  await cache.run('cmd_hit', async () => {
    calls += 1
    return result
  })
  const again = await cache.run('cmd_hit', async () => {
    calls += 1
    return { status: 'completed', result: 999 }
  })
  assert.equal(calls, 1, '第二次 run 不得执行 fn')
  assert.deepEqual(again, result)
  assert.deepEqual(cache.stats().hits, 1)
})

test('running 命中：并发提交返回同一个 promise，只执行一次', async () => {
  const cache = new CommandCache()
  const gate = deferred()
  let calls = 0
  const fn = () => {
    calls += 1
    return gate.promise
  }
  const p1 = cache.run('cmd_dup', fn)
  const p2 = cache.run('cmd_dup', fn)
  assert.equal(p1, p2, 'running 命中必须返回同一个 promise（不是包装后的新 promise）')
  await tick()
  assert.equal(calls, 1, '并发提交不得执行两次')
  gate.resolve({ status: 'completed', result: 'ok' })
  const [a, b] = await Promise.all([p1, p2])
  assert.deepEqual(a, { status: 'completed', result: 'ok' })
  assert.deepEqual(b, a)
  assert.equal(cache.stats().executions, 1)
  assert.equal(cache.stats().dedupHits, 1)
})

test('业务失败（fn 返回 rejected 结果）会被缓存', async () => {
  const cache = new CommandCache()
  let calls = 0
  const rejected = { status: 'rejected', code: 'not-found', message: 'plugin not found' }
  await cache.run('cmd_biz', async () => {
    calls += 1
    return rejected
  })
  const again = await cache.run('cmd_biz', async () => {
    calls += 1
    return { status: 'completed', result: 'should not run' }
  })
  assert.equal(calls, 1)
  assert.deepEqual(again, rejected)
})

test('fn 抛错（传输/编程错误）不缓存，允许重试重新执行', async () => {
  const cache = new CommandCache()
  await assert.rejects(
    cache.run('cmd_err', async () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(cache.has('cmd_err'), false, '抛错必须从缓存移除')
  assert.equal(cache.stats().droppedOnError, 1)

  let retried = 0
  const out = await cache.run('cmd_err', async () => {
    retried += 1
    return { status: 'completed', result: 'retry-ok' }
  })
  assert.equal(retried, 1, '重试应该重新执行')
  assert.equal(out.result, 'retry-ok')
})

test('fn 同步抛错同样不缓存', async () => {
  const cache = new CommandCache()
  await assert.rejects(
    cache.run('cmd_sync_throw', () => {
      throw new Error('sync-boom')
    }),
    /sync-boom/,
  )
  assert.equal(cache.has('cmd_sync_throw'), false)
})

test('LRU：超容量淘汰最久未用的 completed', async () => {
  const cache = new CommandCache({ capacity: 2 })
  await cache.run('a', async () => 'A')
  await cache.run('b', async () => 'B')
  await cache.run('c', async () => 'C')
  assert.equal(cache.has('a'), false, 'a 最久未用，应先淘汰')
  assert.equal(cache.has('b'), true)
  assert.equal(cache.has('c'), true)
  assert.equal(cache.size(), 2)
  assert.equal(cache.stats().evictions, 1)
})

test('LRU：run 命中会 touch，保住热点项', async () => {
  const cache = new CommandCache({ capacity: 2 })
  await cache.run('a', async () => 'A')
  await cache.run('b', async () => 'B')
  await cache.run('a', async () => 'A2') // 命中 → touch → b 变成最旧
  await cache.run('c', async () => 'C')
  assert.equal(cache.has('a'), true, 'a 被 touch 过，应保留')
  assert.equal(cache.has('b'), false, 'b 变成最久未用，应淘汰')
  assert.equal(cache.has('c'), true)
})

test('纯 get() 不改变 LRU 顺序（查询不算一次使用）', async () => {
  const cache = new CommandCache({ capacity: 2 })
  await cache.run('a', async () => 'A')
  await cache.run('b', async () => 'B')
  cache.get('a') // 纯查询：不 touch
  await cache.run('c', async () => 'C')
  assert.equal(cache.has('a'), false, 'get 不刷新顺序，a 仍是最旧')
  assert.equal(cache.has('b'), true)
  assert.equal(cache.has('c'), true)
})

test('running 不可淘汰：全是 in-flight 时允许临时超限，完成后自动收敛', async () => {
  const cache = new CommandCache({ capacity: 2 })
  const a = deferred()
  const b = deferred()
  cache.run('a', () => a.promise)
  cache.run('b', () => b.promise)
  const c = cache.run('c', async () => 'C')
  assert.equal(cache.size(), 3, '全是 running 时允许临时超限')
  assert.deepEqual([cache.stats().running, cache.stats().completed], [3, 0])

  const cResult = await c
  assert.equal(cResult, 'C')
  assert.equal(cache.has('c'), false, 'c 完成后成为唯一 completed，容量收敛时被淘汰')
  assert.equal(cache.size(), 2)

  a.resolve('A')
  b.resolve('B')
  await Promise.all([a.promise, b.promise])
  await tick()
  assert.equal(cache.size(), 2)
  assert.equal(cache.has('a'), true)
  assert.equal(cache.has('b'), true)
})

test('invalidate：只对 completed 生效，running 不可失效', async () => {
  const cache = new CommandCache()
  await cache.run('cmd_done', async () => 'done')
  assert.equal(cache.invalidate('cmd_done'), true)
  assert.equal(cache.has('cmd_done'), false)
  assert.equal(cache.invalidate('cmd_done'), false, '已失效后再失效返回 false')

  const gate = deferred()
  const p = cache.run('cmd_running', () => gate.promise)
  assert.equal(cache.invalidate('cmd_running'), false, 'running 不可失效（避免副作用重复）')
  gate.resolve('ok')
  await p
})

test('clear：清掉 completed、保留 running；running 完成后仍会落缓存', async () => {
  const cache = new CommandCache()
  await cache.run('a', async () => 'A')
  const gate = deferred()
  const p = cache.run('b', () => gate.promise)
  assert.equal(cache.clear(), 1, '只清 completed，返回清掉的数量')
  assert.equal(cache.has('a'), false)
  assert.equal(cache.has('b'), true, 'running 保留')
  gate.resolve('B')
  await p
  assert.equal(cache.has('b'), true, '已执行过的结果仍应缓存')
})

test('onEvict 回调：只在淘汰 completed 时触发，且异常被隔离', async () => {
  const evicted = []
  const cache = new CommandCache({
    capacity: 1,
    onEvict: (id, entry) => {
      evicted.push([id, entry.result])
      throw new Error('evict-callback-boom')
    },
  })
  await cache.run('a', async () => 'A')
  await cache.run('b', async () => 'B') // 淘汰 a，回调抛错也不能中断
  assert.deepEqual(evicted, [['a', 'A']])
  assert.equal(cache.has('a'), false)
  assert.equal(cache.has('b'), true)
  assert.equal(cache.size(), 1)
  assert.equal(cache.stats().evictions, 1)
})

test('容量与参数边界：capacity>=1、commandId 非空、fn 必须是函数', () => {
  assert.throws(() => new CommandCache({ capacity: 0 }), RangeError)
  assert.throws(() => new CommandCache({ capacity: -2 }), RangeError)
  assert.throws(() => new CommandCache({ capacity: Number.NaN }), RangeError)
  assert.equal(new CommandCache({ capacity: 3.9 }).capacity, 3, '容量向下取整')
  assert.equal(new CommandCache({ capacity: 1 }).capacity, 1)

  const cache = new CommandCache()
  assert.throws(() => cache.run('', async () => 1), /non-empty commandId/)
  assert.throws(() => cache.run('   ', async () => 1), /non-empty commandId/)
  assert.throws(() => cache.run('cmd_x'), TypeError)
})

test('调用方忽略返回的 promise，结果仍然进入缓存；失败也不会产生 unhandled rejection', async () => {
  const cache = new CommandCache()
  cache.run('cmd_lazy', async () => ({ status: 'completed', result: 'lazy' })) // 不 await
  await tick()
  assert.equal(cache.has('cmd_lazy'), true)
  assert.deepEqual(cache.get('cmd_lazy'), { status: 'completed', result: 'lazy' })

  let unhandled = 0
  const onUnhandled = () => { unhandled += 1 }
  process.on('unhandledRejection', onUnhandled)
  try {
    cache.run('cmd_fail_lazy', async () => {
      throw new Error('lazy-boom')
    }) // 故意不处理
    await tick()
    await tick()
    assert.equal(unhandled, 0, '缓存内部挂着 handler，调用方忽略也不应 unhandled')
    assert.equal(cache.has('cmd_fail_lazy'), false)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('stats：executions/hits/dedupHits/evictions/droppedOnError 计数完整', async () => {
  const cache = new CommandCache({ capacity: 1 })
  const gate = deferred()
  const p1 = cache.run('x', () => gate.promise)
  const p2 = cache.run('x', () => gate.promise) // dedupHits
  assert.equal(p1, p2)
  gate.resolve('X')
  await p2
  await cache.run('x', async () => 'X') // hits
  await cache.run('y', async () => 'Y') // 淘汰 x
  await assert.rejects(cache.run('z', async () => {
    throw new Error('z-boom')
  }))
  const stats = cache.stats()
  assert.equal(stats.executions, 3, 'x、y、z 各执行一次')
  assert.equal(stats.hits, 2, 'running 命中 + completed 命中各一次')
  assert.equal(stats.dedupHits, 1)
  assert.equal(stats.evictions, 2, 'y 淘汰 x、z 淘汰 y')
  assert.equal(stats.droppedOnError, 1)
  assert.equal(stats.total, 0, 'z 抛错后自身也被移除')
  assert.equal(stats.overCapacity, 0)
})
