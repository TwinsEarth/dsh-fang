// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fang-orchestrator — dsh-Fang 母体的「大脑」（v2.0.0）。
//
// 三层拓扑里的第一层：只做任务语义（create / status / promote / archive），
// 进程机制全部交给 Forker，跨进程控制全部交给分身的 Adapter + src/lib/remote.mjs。
// 边界：母体不可变；分身零共享；分身崩溃/回收不经过 restart-guard。
//
// 所有子插件服务通过 ctx.get(SERVICE.x) 可选获取，缺失时显式降级，
// 绝不假装成功。orchestrator 自身只在 mother 角色激活（roleGate）。
import fs from 'node:fs'
import path from 'node:path'

import {
  z, roleGate, resolveFangLayout, resolveProfileDir,
  SERVICE, AUDIT, TASK_STATUS, FORK_STATUS, FANG_VERSION, ADAPTER_OP,
  exists, ensureDir, readJson, writeJsonAtomic, writeFileAtomic, sha256, removeTree, copyTree,
  newId, iso, nowMs, bus, sleep, parseWebUrl, probeWebUrl,
  invokeCommercial, commercialConfigSchemaDefaults,
} from '../kernel/index.mjs'

export const name = 'fang-orchestrator'
export const inject = []

export const Config = z.object({
  role: z.union([z.const('mother'), z.const('fork')]).default('mother')
    .description('配置层角色；环境 DSH_FANG_ROLE 优先（forker 派生的分身自动为 fork）'),
  maxForks: z.number().min(1).max(64).default(8)
    .description('同时存活的任务/分身上限'),
  motherProfile: z.string().default('')
    .description('母体 profile 名；留空 = 当前 profile（分身模板来源）'),
  profileTemplate: z.string().default('')
    .description('分身 profile 模板目录；留空 = 当前 profile 目录（Forker 的 cleanTemplate 会覆盖）'),
  cliPath: z.string().default('')
    .description('dsh 启动器路径；留空自动探测（PATH 上的 dsh / 安装目录 dsh.cmd）'),
  dataRoot: z.string().default('')
    .description('数据根目录；留空 = $DSH_HOME/fang/<profileTag>'),
  forksRoot: z.string().default('')
    .description('分身 home 根目录；留空 = <dataRoot>/forks'),
  adapterTimeoutMs: z.number().min(100).max(120000).default(10000)
    .description('派生后等待分身 Adapter 就绪的上限（毫秒）；超时任务记为 running（adapter 未就绪）'),
  adapterPollMs: z.number().min(50).max(5000).default(400)
    .description('Adapter 握手轮询间隔（毫秒）'),
  allowProcessRestart: z.boolean().default(false)
    .description('是否允许编排器主动重启母体（默认禁止；重启一律交给 restart-guard）'),
  autoReapIdleMinutes: z.number().min(0).max(1440).default(0)
    .description('空闲多少分钟后自动归档任务（0 = 不自动）'),
  commercial: z.object({
    collaboration: z.boolean().default(false).description('联合开发（需 fangCommercial provider）'),
    git: z.boolean().default(false).description('本地 Git 快照（需 provider）'),
    backup: z.boolean().default(false).description('云备份（需 provider）'),
    tokenApi: z.boolean().default(false).description('Token API（不在本插件内实现）'),
    teams: z.boolean().default(false).description('团队权限（需 provider）'),
  }).default({}),
  routes: z.object({
    enabled: z.boolean().default(true).description('是否注册 /fang 路由'),
    prefix: z.string().default('/fang').description('路由前缀'),
  }).default({}),
})

const HTML_ESCAPE = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

/** Find a runnable dsh launcher. `.cmd` wrappers are spawned through a shell by the forker. */
export function resolveCliPath(explicit = '', env = process.env) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (env.DSH_CLI) candidates.push(env.DSH_CLI)
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue
    candidates.push(path.join(dir, 'dsh.cmd'), path.join(dir, 'dsh.exe'), path.join(dir, 'dsh'))
  }
  candidates.push(
    'E:\\DS\\resources\\runtime\\cli\\bin\\dsh.cmd',
    'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
  )
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch { /* next */ }
  }
  return explicit || 'dsh'
}

export function isShellLauncher(cliPath) {
  return /\.(cmd|bat)$/i.test(String(cliPath))
}

/** Durable task registry (v1 files stay readable: they carry the same forkId field). */
function loadRegistry(file) {
  const raw = readJson(file, [])
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.forks)) return raw.forks
  return []
}

function saveRegistry(file, entries) {
  writeJsonAtomic(file, { version: 2, at: iso(), forks: entries })
}

/** Normalize a lineage seed payload; returns null when absent. Bounded by 64 KiB. */
export function normalizeSeed(seed) {
  if (!seed || typeof seed !== 'object') return null
  const sessionId = String(seed.sessionId ?? '').trim()
  const markdown = String(seed.markdown ?? '')
  if (!sessionId && !markdown) return null
  if (markdown.length > 64 * 1024) throw new Error('seed-too-large')
  return { sessionId, markdown: markdown || `# lineage seed\n\n- session: ${sessionId}\n- mode: lineage-only\n` }
}

export function apply(ctx, config) {
  const cfg = { ...Config({}), ...(config ?? {}) }
  const gate = roleGate('orchestrator', { cfgRole: cfg.role, logger: ctx.logger })
  if (!gate.active) return
  const role = gate.role

  const layout = resolveFangLayout({ dataRoot: cfg.dataRoot, forksRoot: cfg.forksRoot })
  const motherProfile = cfg.motherProfile || layout.profileTag
  ensureDir(layout.dataDir)
  ensureDir(layout.forkHomesDir)

  /** @type {Map<string, any>} */
  const tasks = new Map()
  // v2 owns tasks.json. A v1 install only has forks.json; read it once so a live upgrade
  // does not lose the task list, but never write it back (the forker owns that file).
  const registrySource = exists(layout.tasksFile) ? layout.tasksFile : layout.forksFile
  for (const f of loadRegistry(registrySource)) {
    if (f && typeof f.forkId === 'string') {
      const task = normalizeTask(f)
      tasks.set(task.taskId, task)
    }
  }

  const safeGet = (key) => { try { return ctx.get(key) } catch { return undefined } }
  const audit = (kind, data) => {
    try { safeGet(SERVICE.auditor)?.append(kind, data) } catch { /* auditor optional */ }
    try { bus.emit('fang/audit', { kind, data }) } catch { /* ignore */ }
  }
  const persist = () => {
    try { saveRegistry(layout.tasksFile, [...tasks.values()]) } catch { /* best effort */ }
  }
  const forker = () => safeGet(SERVICE.forker)
  const cliPath = () => (cfg.cliPath ? cfg.cliPath : resolveCliPath('', process.env))
  // The booted profile's own directory is authoritative (launcher sets DSH_PROFILE_DIR);
  // resolving "$DSH_HOME/profiles/<tag>" from argv can point at a template that never existed.
  // 分身模板必须来自一个**真的装了本 bundle** 的 profile；否则分身的 node_modules junction
  // 指到一个没有 @local/dsh-fang 的 profile，fork 里所有 /fang 路由都会 404（实测事故）。
  const templateDir = () => {
    const candidates = [cfg.profileTemplate, process.env.DSH_PROFILE_DIR, resolveProfileDir(motherProfile), resolveProfileDir(layout.profileTag)]
    const usable = candidates.filter((dir) => typeof dir === "string" && dir.trim()
      && exists(path.join(dir, "node_modules", "@local", "dsh-fang")))
    if (usable.length > 0) return usable[0]
    return candidates.find((dir) => typeof dir === "string" && dir.trim()) ?? resolveProfileDir(layout.profileTag)
  }
  const commercialHooks = commercialConfigSchemaDefaults()
  for (const key of Object.keys(commercialHooks)) {
    if (cfg.commercial && cfg.commercial[key] === true) commercialHooks[key] = true
  }

  function normalizeTask(f) {
    const taskId = f.taskId ?? f.forkId
    const status = f.status === FORK_STATUS.RUNNING ? TASK_STATUS.RUNNING
      : f.status === FORK_STATUS.CRASHED ? TASK_STATUS.FAILED
        : f.status === FORK_STATUS.STOPPED ? TASK_STATUS.ARCHIVED
          : f.status ?? TASK_STATUS.PROVISIONING
    return {
      taskId,
      forkId: taskId,
      title: f.title ?? f.taskTitle ?? taskId,
      taskTitle: f.title ?? f.taskTitle ?? taskId,
      profile: f.profile,
      homeDir: f.homeDir,
      status,
      createdAt: f.createdAt ?? nowMs(),
      restarts: f.restarts ?? 0,
      pid: f.pid ?? null,
      port: f.port ?? null,
      url: f.url ?? null,
      token: f.token ?? (f.url ? extractTokenSafe(f.url) : ''),
      adapter: f.adapter ?? { ok: false, error: 'not-handshaked' },
      collaborators: Array.isArray(f.collaborators) ? f.collaborators : [],
      template: f.template ?? '',
    }
  }

  function extractTokenSafe(url) {
    try {
      const u = new URL(String(url))
      return u.searchParams.get('token') ?? ''
    } catch { return '' }
  }

  /** Layout of one fork's private $DSH_HOME (its buffer lives inside it). */
  function forkLayout(info) {
    return resolveFangLayout({
      env: { ...process.env, DSH_HOME: info.homeDir },
      argv: ['--profile', info.profile],
    })
  }

  // ── 跨进程 remote 客户端（懒加载，模块缺失时显式降级）────────────────────────
  let remoteModulePromise = null
  const remoteModule = async () => {
    if (!remoteModulePromise) {
      remoteModulePromise = import('../lib/remote.mjs').catch(() => null)
    }
    return remoteModulePromise
  }
  const remoteCache = new Map()
  async function remoteFor(task) {
    if (!task?.url) return null
    const cached = remoteCache.get(task.taskId)
    if (cached && cached.url === task.url) return cached.client
    const mod = await remoteModule()
    if (!mod || typeof mod.createRemote !== 'function') return null
    const client = mod.createRemote({
      url: task.url,
      token: task.token || (mod.extractToken ? mod.extractToken(task.url) : ''),
      timeoutMs: 8000,
    })
    remoteCache.set(task.taskId, { url: task.url, client })
    return client
  }

  /** Poll the fork-side Adapter until it answers hello (bounded by adapterTimeoutMs). */
  async function handshake(task) {
    const client = await remoteFor(task)
    if (!client) {
      task.adapter = { ok: false, error: 'remote-module-missing', at: nowMs() }
      return task.adapter
    }
    const deadline = nowMs() + cfg.adapterTimeoutMs
    let last = null
    while (nowMs() < deadline) {
      const res = await client.hello()
      if (res?.ok && res.data?.ok) {
        task.adapter = {
          ok: true,
          version: res.data.version ?? '',
          role: res.data.role ?? 'fork',
          taskId: res.data.taskId ?? task.taskId,
          at: nowMs(),
        }
        audit(AUDIT.ADAPTER_HANDSHAKE, { taskId: task.taskId, ok: true, version: task.adapter.version })
        return task.adapter
      }
      last = res
      await sleep(cfg.adapterPollMs)
    }
    task.adapter = { ok: false, error: last?.error ?? last?.kind ?? 'timeout', at: nowMs() }
    audit(AUDIT.ADAPTER_HANDSHAKE, { taskId: task.taskId, ok: false, error: task.adapter.error })
    return task.adapter
  }

  function taskView(t) {
    const live = forker()?.status?.(t.taskId)
    const running = live ? !!live.running : t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.READY
    const status = !running ? (t.status === TASK_STATUS.ARCHIVED ? TASK_STATUS.ARCHIVED : TASK_STATUS.FAILED)
      : (t.adapter?.ok ? TASK_STATUS.READY : TASK_STATUS.RUNNING)
    return {
      taskId: t.taskId,
      forkId: t.taskId,
      title: t.title,
      taskTitle: t.title,
      status,
      pid: live?.pid ?? t.pid ?? null,
      port: t.port ?? null,
      url: t.url ?? null,
      homeDir: t.homeDir,
      profile: t.profile,
      createdAt: t.createdAt,
      restarts: t.restarts ?? 0,
      adapter: { ok: !!t.adapter?.ok, version: t.adapter?.version ?? '', error: t.adapter?.error ?? '' },
      collaborators: t.collaborators ?? [],
      seed: t.seed ?? null,
    }
  }

  const service = {
    role,
    version: FANG_VERSION,
    dataDir: layout.dataDir,

    /** v2 主入口：派生一个任务（= 一个分身）。 */
    async createTask(input = {}) {
      const title = String(input.title ?? input.taskTitle ?? '').trim() || `任务 ${tasks.size + 1}`
      const running = [...tasks.values()].filter(t => {
        const s = taskView(t).status
        return s === TASK_STATUS.RUNNING || s === TASK_STATUS.READY
      }).length
      if (running >= cfg.maxForks) {
        return { ok: false, error: 'quota-exceeded', detail: `已达上限 ${cfg.maxForks}，请先归档旧任务` }
      }
      const f = forker()
      if (!f || typeof f.spawn !== 'function') {
        return { ok: false, error: 'forker-unavailable', detail: 'fang-forker 未加载' }
      }

      const taskId = newId('task')
      const profile = `fang-${taskId.replace(/^task_/, '').slice(0, 12)}`
      const homeDir = path.join(layout.forkHomesDir, taskId)
      const template = String(input.template ?? '').trim()
      const task = normalizeTask({
        taskId,
        title,
        profile,
        homeDir,
        status: TASK_STATUS.PROVISIONING,
        createdAt: nowMs(),
        collaborators: Array.isArray(input.collaborators) ? input.collaborators : [],
        template,
        adapter: { ok: false, error: 'handshaking' },
      })
      tasks.set(taskId, task)
      persist()

      try {
        const provisioned = await f.provision({
          forkId: taskId,
          taskTitle: title,
          homeDir,
          profile,
          profileTemplate: template || templateDir(),
        })
        if (provisioned && provisioned.ok === false) {
          task.status = TASK_STATUS.FAILED
          persist()
          return { ok: false, error: 'provision-failed', detail: provisioned.error }
        }
        audit(AUDIT.FORK_CREATED, { taskId, forkId: taskId, title, homeDir, profile })

        // 防御：分身的 profile 必须能解析本 bundle；否则派生出来的是一个"没有 /fang 路由"的
        // 僵尸分身（adapter 握手会得到 http-404）。发现即回收并如实报错。
        const forkProfileDir = path.join(homeDir, 'profiles', profile)
        const forkBundle = path.join(forkProfileDir, 'node_modules', '@local', 'dsh-fang')
        if (!exists(forkBundle)) {
          task.status = TASK_STATUS.FAILED
          tasks.delete(taskId)
          persist()
          try { await f.reap(taskId) } catch { /* 回收失败不改变结论 */ }
          audit(AUDIT.FORK_CRASHED, { taskId, error: 'fork-bundle-unavailable', forkProfileDir })
          return { ok: false, error: 'fork-bundle-unavailable', detail: forkProfileDir }
        }


        // v2.1 lineage seed: a bounded handoff digest copied into the fork's own home.
        // The fork reads it; the mother stays immutable (no session mount/copy).
        const seed = normalizeSeed(input.seed ?? (input.seedSessionId ? { sessionId: input.seedSessionId } : null))
        if (seed) {
          try {
            const seedsDir = path.join(homeDir, 'fang-seeds')
            ensureDir(seedsDir)
            const seedId = newId('seed')
            const seedPath = path.join(seedsDir, seedId + '.md')
            writeFileAtomic(seedPath, seed.markdown)
            task.seed = {
              seedId,
              path: seedPath,
              sessionId: seed.sessionId ?? '',
              sha256: sha256(seed.markdown),
              bytes: Buffer.byteLength(seed.markdown, 'utf8'),
            }
            audit(AUDIT.FORK_CREATED + '-seed', { taskId, seedId, sessionId: task.seed.sessionId, bytes: task.seed.bytes })
          } catch (e) {
            task.seed = null
            audit(AUDIT.FORK_CRASHED + '-seed', { taskId, error: String(e?.message ?? e) })
          }
        }

        const started = await f.spawn({
          forkId: taskId,
          homeDir,
          profile,
          cliPath: cliPath(),
          env: { DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: taskId, DSH_FANG_MOTHER: layout.dataDir },
        })
        if (!started || started.ok === false) {
          task.status = TASK_STATUS.FAILED
          persist()
          audit(AUDIT.FORK_CRASHED, { taskId, error: started?.error ?? 'spawn-failed' })
          bus.emit('fang/task-failed', { taskId, error: started?.error ?? 'spawn-failed' })
          return { ok: false, error: 'spawn-failed', detail: started?.error ?? 'unknown' }
        }
        task.status = TASK_STATUS.RUNNING
        task.pid = started.pid ?? null
        task.port = started.port ?? null
        task.url = started.url ?? null
        task.token = started.token ?? extractTokenSafe(task.url)
        persist()
        audit(AUDIT.FORK_STARTED, { taskId, pid: task.pid, port: task.port, profile })
        bus.emit('fang/task-created', { taskId, forkId: taskId, title, url: task.url, port: task.port })

        const reachable = await probeWebUrl(task.url).catch(() => ({ ok: false }))
        const adapter = await handshake(task)
        task.status = adapter.ok ? TASK_STATUS.READY : TASK_STATUS.RUNNING
        persist()
        audit(AUDIT.TASK_READY, { taskId, adapter, reachable: !!reachable.ok })

        // 商用钩子：联合开发（无 provider 时返回 not-configured，不阻塞）。
        if (task.collaborators.length && commercialHooks.collaboration) {
          await invokeCommercial({
            commercialHooks, provider: safeGet(SERVICE.commercial), capability: 'collaboration',
            method: 'publishChange', args: [{ taskId, pluginId: '', files: [] }],
          })
        }

        return {
          ok: true,
          taskId,
          forkId: taskId,
          title,
          url: task.url,
          port: task.port,
          homeDir,
          profile,
          adapter: { ok: adapter.ok, version: adapter.version ?? '', error: adapter.error ?? '' },
          reachable: !!reachable.ok,
          seed: task.seed,
        }
      } catch (e) {
        task.status = TASK_STATUS.FAILED
        persist()
        audit(AUDIT.FORK_CRASHED, { taskId, error: String(e?.message ?? e) })
        bus.emit('fang/task-failed', { taskId, error: String(e?.message ?? e) })
        return { ok: false, error: 'create-task-threw', detail: String(e?.message ?? e) }
      }
    },

    /** v1 兼容别名：fork 就是一个任务。 */
    async fork(request = {}) {
      return service.createTask({ title: request.taskTitle ?? request.title, template: request.basePlugin })
    },

    listTasks() {
      return [...tasks.values()].map(taskView).sort((a, b) => a.createdAt - b.createdAt)
    },

    listForks() {
      return service.listTasks()
    },

    async getTaskStatus(taskId) {
      const task = tasks.get(String(taskId ?? ''))
      if (!task) return { ok: false, error: 'unknown-task' }
      const view = taskView(task)
      const client = task.adapter?.ok ? await remoteFor(task) : null
      let adapterStatus = null
      if (client) {
        const res = await client.status()
        adapterStatus = res.ok ? res.data : { ok: false, error: res.error ?? res.kind }
      }
      return {
        ok: true,
        taskId: task.taskId,
        status: view.status,
        title: view.title,
        fork: {
          pid: view.pid, port: view.port, url: view.url, homeDir: view.homeDir,
          profile: view.profile, createdAt: view.createdAt,
        },
        adapter: view.adapter,
        adapterStatus,
      }
    },

    async getForkHealth(forkId) {
      const status = await service.getTaskStatus(forkId)
      if (status.ok === false) return status
      const probe = status.fork.url
        ? await probeWebUrl(status.fork.url).catch(() => ({ ok: false }))
        : { ok: false, reason: 'no-url' }
      return {
        ok: probe.ok,
        forkId,
        taskId: forkId,
        status: status.status,
        pid: status.fork.pid,
        port: status.fork.port,
        url: status.fork.url,
        probe,
        adapter: status.adapter,
      }
    },

    /**
     * v2 提升：从分身取回插件源码 → 母体阈值复核 → Router 初判 → 审批 → A/B → staging。
     * 与 v1 的 promote() 区别：走 Adapter 跨进程取源码与分身评分，不再假设母体能读分身磁盘。
     */
    async promoteTask(taskId, pluginId) {
      const id = String(taskId ?? '')
      const plugin = String(pluginId ?? '').trim()
      if (!id) return { ok: false, error: 'task-id-required' }
      if (!plugin) return { ok: false, error: 'plugin-id-required' }
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      if (!task.adapter?.ok) return { ok: false, error: 'adapter-unavailable', detail: task.adapter?.error ?? '' }

      const client = await remoteFor(task)
      if (!client) return { ok: false, error: 'remote-unavailable' }

      const read = await client.command(ADAPTER_OP.READ_PLUGIN, { pluginId: plugin })
      if (!read.ok || read.data?.ok === false) {
        return { ok: false, error: 'read-plugin-failed', detail: read.data?.error ?? read.error ?? '' }
      }
      const files = read.data?.result?.files ?? {}
      if (!Object.keys(files).length) return { ok: false, error: 'plugin-not-found', detail: plugin }

      const forkScore = await client.command(ADAPTER_OP.SCORE_PLUGIN, { pluginId: plugin })
      const forkAssessment = forkScore.ok && forkScore.data?.ok ? forkScore.data.result : null

      // Materialize the fetched source into a mother-side work dir, then re-score with
      // the MOTHER threshold policy (母体更严格，且这是真正写进生产的判定).
      const workDir = path.join(layout.dataDir, 'work', `${id}-${plugin}`)
      try {
        removeTree(workDir)
        ensureDir(workDir)
        for (const [rel, content] of Object.entries(files)) {
          const target = resolveInside(workDir, rel)
          if (!target) return { ok: false, error: 'unsafe-plugin-path', detail: rel }
          writeFileAtomic(target, String(content))
        }
      } catch (e) {
        return { ok: false, error: 'materialize-failed', detail: String(e?.message ?? e) }
      }

      const scorer = safeGet(SERVICE.scorer)
      const motherAssessment = scorer?.scoreDir ? scorer.scoreDir(workDir, null, { environment: 'mother' }) : null
      if (!motherAssessment) return { ok: false, error: 'scorer-unavailable' }
      if (motherAssessment.grade === 'D' || motherAssessment.grade === 'E') {
        return { ok: false, error: 'grade-too-low', grade: motherAssessment.grade, score: motherAssessment.S }
      }

      const router = safeGet(SERVICE.router)
      const route = router?.decide
        ? router.decide({
          plugin: { name: plugin, source: 'local-author' },
          assessment: motherAssessment,
          source: 'mother',
        })
        : null
      if (route && route.route !== 'sandbox') {
        return { ok: false, error: 'route-refused', route: route.route, reason: route.reason }
      }

      const approver = safeGet(SERVICE.approver)
      if (!approver) return { ok: false, error: 'approver-unavailable' }

      // 团队权限钩子（无 provider 时放行并记录 basis）。
      let teamBasis = { commercial: false }
      if (commercialHooks.teams) {
        const check = await invokeCommercial({
          commercialHooks, provider: safeGet(SERVICE.commercial), capability: 'teams',
          method: 'check', args: [{ action: 'promote', group: plugin }],
        })
        teamBasis = { commercial: true, ...(check.ok ? check.value : { allowed: true, error: check.error }) }
        if (teamBasis.allowed === false) return { ok: false, error: 'team-denied', basis: teamBasis }
      }

      const decision = typeof approver.requestPromotion === 'function'
        ? await approver.requestPromotion({
          pluginId: plugin,
          taskId: id,
          detail: `来源任务 ${task.title}`,
          impact: { taskId: id, pluginId: plugin, forkGrade: forkAssessment?.grade ?? null, motherGrade: motherAssessment.grade },
        })
        : await approver.request({
          kind: 'promotion',
          risk: 'red',
          title: `提升插件 ${plugin} → 母体`,
          detail: `来源任务 ${id}（${task.title}）`,
          impact: { taskId: id, pluginId: plugin, grade: motherAssessment.grade },
        })
      const outcome = decision?.outcome ?? 'timeout'
      audit(AUDIT.APPROVAL_DECIDED, { kind: 'promotion', taskId: id, pluginId: plugin, outcome })
      if (outcome !== 'approved') return { ok: false, error: 'denied', outcome }

      const target = path.join(layout.dataDir, 'promoted', plugin)
      try {
        if (exists(target)) {
          approver.snapshot?.({ tag: plugin, dir: target })
          removeTree(target)
        }
        copyTree(workDir, target)
      } catch (e) {
        audit(AUDIT.PROMOTE_FAILED, { taskId: id, pluginId: plugin, error: String(e?.message ?? e) })
        return { ok: false, error: 'promote-failed', detail: String(e?.message ?? e) }
      }
      audit(AUDIT.PROMOTE_COMMITTED, {
        taskId: id, pluginId: plugin, target,
        forkGrade: forkAssessment?.grade ?? null, motherGrade: motherAssessment.grade,
      })

      // 商用钩子：云备份（不阻塞、失败只记录）。
      let backup = { ok: false, error: 'not-configured' }
      if (commercialHooks.backup) {
        backup = await invokeCommercial({
          commercialHooks, provider: safeGet(SERVICE.commercial), capability: 'backup',
          method: 'upload', args: [{ kind: 'plugin', id: plugin, key: plugin, body: files }],
        })
      }

      return {
        ok: true,
        outcome: 'approved',
        taskId: id,
        pluginId: plugin,
        target,
        forkAssessment,
        motherAssessment,
        route: route?.route ?? null,
        teamBasis,
        backup,
        note: '已写入母体 staging；重启母体后生效（重启需 restart-guard 审批）',
      }
    },

    /** v1 兼容提升：本地路径直接读分身 buffer（同机、旧流程）。 */
    async promote(forkId, pluginId) {
      const info = tasks.get(String(forkId ?? ''))
      if (!info) return { ok: false, error: 'unknown-fork' }
      if (!pluginId) return { ok: false, error: 'plugin-id-required' }
      const src = path.join(forkLayout(info).bufferDir, String(pluginId))
      if (!exists(src)) return { ok: false, error: 'not-in-fork-buffer', detail: src }

      const scorer = safeGet(SERVICE.scorer)
      const assessment = scorer?.scoreDir ? scorer.scoreDir(src, null, { environment: 'mother' }) : null
      if (assessment && (assessment.grade === 'D' || assessment.grade === 'E')) {
        return { ok: false, error: 'grade-too-low', grade: assessment.grade, score: assessment.S }
      }
      const approver = safeGet(SERVICE.approver)
      if (!approver) return { ok: false, error: 'approver-unavailable' }
      const decision = await approver.request({
        kind: 'promotion',
        risk: 'red',
        title: `提升插件 ${pluginId} → 母体`,
        detail: `来源分身 ${forkId}（${info.title}）`,
        impact: { forkId, pluginId, grade: assessment?.grade ?? 'unknown' },
      })
      if ((decision?.outcome ?? 'timeout') !== 'approved') {
        return { ok: false, error: 'denied', outcome: decision?.outcome ?? 'timeout' }
      }
      const target = path.join(layout.dataDir, 'promoted', String(pluginId))
      try {
        if (exists(target)) {
          approver.snapshot?.({ tag: String(pluginId), dir: target })
          removeTree(target)
        }
        copyTree(src, target)
      } catch (e) {
        return { ok: false, error: 'promote-failed', detail: String(e?.message ?? e) }
      }
      audit(AUDIT.PROMOTE_COMMITTED, { forkId, pluginId, target })
      return { ok: true, outcome: 'approved', target, pluginId, assessment }
    },

    /**
     * v2.1 门户入口：派生一个任务，可选地用母体只读会话做 lineage 种子。
     * 只读会话目录（session catalog）缺失时退化为 lineage-only，不阻塞派生。
     */
    async derive(input = {}) {
      const sessionId = String(input.sessionId ?? '').trim()
      let seed = null
      if (sessionId) {
        const catalog = safeGet(SERVICE.sessionCatalog)
        if (!catalog || typeof catalog.digest !== 'function') {
          return { ok: false, error: 'session-catalog-unavailable' }
        }
        const digest = await catalog.digest(sessionId)
        if (!digest || digest.ok === false) {
          return { ok: false, error: 'session-seed-failed', detail: digest?.code ?? digest?.error ?? 'unknown' }
        }
        seed = { sessionId, markdown: digest.markdown }
      }
      const title = String(input.title ?? '').trim()
        || (seed ? `从会话继续 · ${seed.sessionId.slice(-8)}` : `派生任务 ${tasks.size + 1}`)
      const out = await service.createTask({ title, seed, collaborators: input.collaborators })
      return { ...out, derivedFrom: seed ? { sessionId: seed.sessionId } : null }
    },

    /** v2 归档：先让分身 flush + 落审计，再回收进程与 home。 */
    async archiveTask(taskId) {
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      const summary = taskView(task)
      let remote = { ok: false, error: 'adapter-unavailable' }
      if (task.adapter?.ok) {
        const client = await remoteFor(task)
        if (client) {
          const res = await client.command(ADAPTER_OP.ARCHIVE, {})
          remote = { ok: !!(res.ok && res.data?.ok !== false), error: res.data?.error ?? res.error }
        }
      }
      task.status = TASK_STATUS.ARCHIVED
      persist()
      const reaped = await service.reap(id)
      audit(AUDIT.TASK_ARCHIVED, { taskId: id, title: task.title, remote })
      bus.emit('fang/task-archived', { taskId: id, title: task.title })
      return { ok: true, archived: true, taskId: id, title: task.title, summary, remote, reaped: reaped.ok === true }
    },

    async reap(taskId) {
      const task = tasks.get(String(taskId ?? ''))
      if (!task) return { ok: false, error: 'unknown-fork' }
      const f = forker()
      let reaped = { ok: true }
      try {
        reaped = f && typeof f.reap === 'function' ? await f.reap(task.taskId) : { ok: true }
      } catch (e) {
        reaped = { ok: false, error: String(e?.message ?? e) }
      }
      if (reaped && reaped.ok === false) {
        task.status = TASK_STATUS.FAILED
        persist()
        return { ok: false, error: 'reap-failed', detail: reaped.error }
      }
      tasks.delete(task.taskId)
      remoteCache.delete(task.taskId)
      persist()
      audit(AUDIT.FORK_REAPED, { taskId: task.taskId })
      bus.emit('fang/fork-reaped', { forkId: task.taskId })
      return { ok: true, forkId: task.taskId, removed: reaped?.removed ?? true }
    },

    status() {
      const list = [...tasks.values()].map(taskView)
      const ready = list.filter(t => t.status === TASK_STATUS.READY).length
      const running = list.filter(t => t.status === TASK_STATUS.RUNNING).length
      return {
        version: FANG_VERSION,
        role,
        profileTag: layout.profileTag,
        dataDir: layout.dataDir,
        mother: { profile: motherProfile, cliPath: cliPath(), template: templateDir() },
        tasks: { total: list.length, ready, running, max: cfg.maxForks, list },
        // v1 兼容视图：Client 徽标与旧调用方仍读 forks.*
        forks: { total: list.length, running: ready + running, max: cfg.maxForks, list },
        audit: { checkedAt: bootState.at, ok: bootState.ok, findings: bootState.findings },
        commercial: { ...commercialHooks },
        services: {
          forker: !!safeGet(SERVICE.forker),
          scorer: !!safeGet(SERVICE.scorer),
          healer: !!safeGet(SERVICE.healer),
          approver: !!safeGet(SERVICE.approver),
          hotReloader: !!safeGet(SERVICE.hotReloader),
          restart: !!safeGet(SERVICE.restart),
          buffer: !!safeGet(SERVICE.buffer),
          auditor: !!safeGet(SERVICE.auditor),
          router: !!safeGet(SERVICE.router),
          adapter: !!safeGet(SERVICE.adapter),
          commercial: !!safeGet(SERVICE.commercial),
          sessionCatalog: !!safeGet(SERVICE.sessionCatalog),
        },
      }
    },

    /** 母体重启的唯一入口：转交 restart-guard，自身永不直接退出进程。 */
    async requestMotherRestart(reason = 'manual') {
      const guard = safeGet(SERVICE.restart)
      if (!guard || typeof guard.request !== 'function') {
        return { ok: false, error: 'restart-guard-unavailable' }
      }
      const decision = await guard.request({
        reason: String(reason),
        risk: 'red',
        scope: 'mother',
        origin: 'fang:orchestrator',
      })
      return { ok: decision?.outcome === 'approved', ...decision }
    },
  }

  ctx.effect(() => ctx.provide(SERVICE.orchestrator, service))

  // ── 启动自检 ───────────────────────────────────────────────────────────
  const bootState = { at: nowMs(), ok: null, findings: [] }
  const bootAuditTimer = setTimeout(() => {
    try {
      const auditor = safeGet(SERVICE.auditor)
      const check = auditor?.bootCheck?.() ?? auditor?.bootAudit?.()
      bootState.ok = check?.ok !== false
      bootState.findings = Array.isArray(check?.findings) ? check.findings : []
      audit(AUDIT.BOOT, { ok: bootState.ok, findings: bootState.findings })
    } catch (e) {
      bootState.ok = false
      bootState.findings = [{ id: 'boot-audit-threw', level: 'error', message: String(e?.message ?? e) }]
    }
  }, 1000)
  ctx.effect(() => () => clearTimeout(bootAuditTimer))

  // ── 启动时把注册表里已经死掉的任务标成 stopped（不假装还活着）───────────────
  const refreshStale = () => {
    let changed = false
    for (const t of tasks.values()) {
      const live = forker()?.status?.(t.taskId)
      if (live && !live.running && (t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.READY)) {
        t.status = TASK_STATUS.FAILED
        changed = true
      }
    }
    if (changed) persist()
  }
  const bootTimer = setTimeout(() => { try { refreshStale() } catch { /* ignore */ } }, 2000)
  ctx.effect(() => () => clearTimeout(bootTimer))

  // ── 可选：空闲自动归档 ───────────────────────────────────────────────────
  if (cfg.autoReapIdleMinutes > 0) {
    const t = setInterval(() => {
      const idleMs = cfg.autoReapIdleMinutes * 60_000
      for (const task of [...tasks.values()]) {
        if (nowMs() - (task.lastActiveAt ?? task.createdAt) > idleMs) {
          service.archiveTask(task.taskId).catch(() => { /* best effort */ })
        }
      }
    }, 60_000)
    ctx.effect(() => () => clearInterval(t))
  }

  // ── HTTP 门户 ──────────────────────────────────────────────────────────
  if (cfg.routes?.enabled !== false) {
    ctx.inject(['webServer'], (child) => {
      const webServer = child.get('webServer') ?? child.webServer
      if (!webServer || typeof webServer.register !== 'function') return
      const prefix = String(cfg.routes?.prefix ?? '/fang').replace(/\/+$/, '') || '/fang'

      const json = (res, code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(obj))
      }
      const readBody = (req) => new Promise((resolve) => {
        let raw = ''
        req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy() })
        req.on('end', () => {
          try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
        })
        req.on('error', () => resolve({}))
      })
      const route = (method, pathname, handler) => webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          if (req.method !== method) return json(res, 405, { ok: false, error: 'method-not-allowed' })
          try { return await handler(req, res) } catch (e) {
            return json(res, 500, { ok: false, error: 'handler-threw', detail: String(e?.message ?? e) })
          }
        },
      })

      route('GET', `${prefix}/panel`, (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(renderPanelHtml(prefix))
      })
      route('GET', `${prefix}/api/status`, (req, res) => json(res, 200, service.status()))
      route('GET', `${prefix}/api/tasks`, (req, res) => json(res, 200, { ok: true, tasks: service.listTasks() }))
      route('POST', `${prefix}/api/tasks/create`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.createTask({ title: body?.title, template: body?.template, collaborators: body?.collaborators })
        return json(res, out.ok ? 200 : 409, out)
      })
      route('GET', `${prefix}/api/tasks/status`, async (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        const out = await service.getTaskStatus(query.get('taskId') ?? '')
        return json(res, out.ok === false ? 404 : 200, out)
      })
      route('POST', `${prefix}/api/tasks/archive`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.archiveTask(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/tasks/promote`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.promoteTask(String(body?.taskId ?? ''), String(body?.pluginId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })

      route('POST', `${prefix}/api/derive`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.derive({ title: body?.title, sessionId: body?.sessionId, collaborators: body?.collaborators })
        return json(res, out.ok ? 200 : 409, out)
      })
      // v1 兼容路由
      route('GET', `${prefix}/api/forks`, (req, res) => json(res, 200, { ok: true, forks: service.listForks() }))
      route('POST', `${prefix}/api/forks/create`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.fork({ taskTitle: body?.taskTitle ?? body?.title })
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/reap`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.reap(String(body?.forkId ?? body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/promote`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.promote(String(body?.forkId ?? ''), String(body?.pluginId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
    })
  }
}

/** Reject any plugin-provided relative path that escapes its base directory. */
export function resolveInside(base, rel) {
  const p = String(rel ?? '')
  if (!p || p.includes('\0')) return null
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || p.startsWith('\\\\') || p.includes('..')) return null
  const resolved = path.resolve(base, p)
  const baseResolved = path.resolve(base)
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) return null
  return resolved
}

/** Server-rendered portal (v2): task table + adapter state + four actions. */
export function renderPanelHtml(prefix = '/fang') {
  const p = HTML_ESCAPE(prefix)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-Fang v2 · 瓮城</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px; max-width: 1180px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8a8a8a; margin-bottom: 20px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
  input, button { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid #8886; background: transparent; color: inherit; }
  input { min-width: 280px; }
  button { cursor: pointer; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #8884; vertical-align: middle; }
  th { font-weight: 600; color: #8a8a8a; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid currentColor; }
  .ready { color: #16a34a; } .running { color: #2563eb; } .failed { color: #dc2626; }
  .archived { color: #8a8a8a; } .provisioning { color: #d97706; }
  .empty { color: #8a8a8a; padding: 24px 0; }
  #msg { min-height: 22px; color: #d97706; }
  a { color: inherit; }
</style></head>
<body>
  <h1>dsh-Fang v2 · 瓮城</h1>
  <div class="sub">母体只读；每个任务一个分身（用完即弃）。Adapter 就绪 = 分身器官已上线；归档 = flush + 回收。</div>
  <div class="row">
    <input id="title" placeholder="任务标题，例如：开发 dsh-foo 插件" />
    <button class="primary" id="create">派生新任务</button>
    <button id="refresh">刷新</button>
    <span id="mother"></span>
  </div>
  <div id="msg"></div>
  <table>
    <thead><tr><th>任务</th><th>状态</th><th>Adapter</th><th>端口</th><th>PID</th><th>操作</th></tr></thead>
    <tbody id="rows"><tr><td colspan="6" class="empty">加载中…</td></tr></tbody>
  </table>
<script>
const P = ${JSON.stringify(p)};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function msg(t, bad) { $('msg').textContent = t || ''; $('msg').style.color = bad ? '#dc2626' : '#16a34a'; }
async function api(path, opts) {
  const res = await fetch(P + path, Object.assign({ headers: { 'content-type': 'application/json' } }, opts));
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
async function refresh() {
  const { body } = await api('/api/status');
  const s = body || {};
  $('mother').innerHTML = s.version
    ? '<span class="badge">母体 · ' + esc(s.profileTag) + ' · ' + esc(s.tasks?.ready) + ' ready / ' + esc(s.tasks?.total) + ' tasks</span>'
    : '';
  const list = s.tasks?.list ?? [];
  if (!list.length) { $('rows').innerHTML = '<tr><td colspan="6" class="empty">还没有任务。输入标题并点「派生新任务」。</td></tr>'; return; }
  $('rows').innerHTML = list.map(t => '<tr>' +
    '<td>' + esc(t.title) + '<br><code>' + esc(t.taskId) + '</code></td>' +
    '<td><span class="badge ' + esc(t.status) + '">' + esc(t.status) + '</span></td>' +
    '<td><span class="badge ' + (t.adapter?.ok ? 'ready' : 'failed') + '">' + (t.adapter?.ok ? 'ready' : esc(t.adapter?.error || 'down')) + '</span></td>' +
    '<td>' + (t.port ? esc(t.port) : '—') + '</td>' +
    '<td>' + (t.pid ? esc(t.pid) : '—') + '</td>' +
    '<td>' +
      (t.url ? '<a class="badge" href="' + esc(t.url) + '" target="_blank" rel="noopener">打开</a> ' : '') +
      '<button data-act="archive" data-id="' + esc(t.taskId) + '">归档</button> ' +
      '<button data-act="promote" data-id="' + esc(t.taskId) + '">提升插件…</button>' +
    '</td></tr>').join('');
}
$('create').onclick = async () => {
  const title = $('title').value.trim();
  msg('派生中…（含 Adapter 握手，约 5–20 秒）');
  const { body } = await api('/api/tasks/create', { method: 'POST', body: JSON.stringify({ title }) });
  if (body?.ok) { msg('已派生：' + body.taskId + '（adapter ' + (body.adapter?.ok ? 'ready' : '未就绪') + '）'); if (body.url) window.open(body.url, '_blank', 'noopener'); $('title').value = ''; }
  else msg('派生失败：' + (body?.error || 'unknown') + (body?.detail ? ' — ' + body.detail : ''), true);
  refresh();
};
$('refresh').onclick = refresh;
$('rows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  if (btn.dataset.act === 'archive') {
    if (!confirm('归档该任务？会先 flush 分身缓冲并落审计，再删除 $DSH_HOME。')) return;
    const { body } = await api('/api/tasks/archive', { method: 'POST', body: JSON.stringify({ taskId: id }) });
    msg(body?.ok ? '已归档 ' + id : '归档失败：' + (body?.error || 'unknown'), !body?.ok);
  } else {
    const pluginId = prompt('要提升的插件目录名（位于该任务缓冲区内）：');
    if (!pluginId) return;
    const { body } = await api('/api/tasks/promote', { method: 'POST', body: JSON.stringify({ taskId: id, pluginId }) });
    msg(body?.ok ? '提升已批准：' + (body.note || body.target) : '提升被拒：' + (body?.error || 'unknown'), !body?.ok);
  }
  refresh();
});
refresh();
setInterval(refresh, 5000);
</script>
</body></html>`
}

export const _internals = { resolveCliPath, isShellLauncher, renderPanelHtml, loadRegistry, resolveInside, normalizeSeed }
