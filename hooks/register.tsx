import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, OtherSession, Snapshot, Stats } from '../types'

// Токенчик — маленький робот в очках, следит за расходом токенов.

const PANE = 'tokenchik'
const TITLE = 'Токенчик'
const STORE_KEY = 'sessions-v1'

const EMPTY_STATS: Stats = {
  turns: 0,
  turnsSinceCompact: 0,
  agentCalls: 0,
  lastGrowth: 0,
  lastOutput: 0,
  lastTools: 0,
  quietTurns: 0,
  lastActivity: 0,
}

const snap = atom({ plugin: 'tokenchik', key: 'snap' } as const, null, { shape: 'snap-1' })
const stats = atom({ plugin: 'tokenchik', key: 'stats' } as const, EMPTY_STATS, { shape: 'stats-1' })
const muted = atom({ plugin: 'tokenchik', key: 'muted' } as const, [], { shape: 'muted-1' })
const others = atom({ plugin: 'tokenchik', key: 'others' } as const, [], { shape: 'others-1' })
const now = atom({ plugin: 'tokenchik', key: 'now' } as const, 0)

type Level = 'info' | 'warn' | 'alarm'
type Action =
  | { kind: 'compact'; label: string }
  | { kind: 'command'; label: string; command: string; args?: string }
type Tip = { id: string; level: Level; text: string; action?: Action }

// ---------- советы ----------

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)
const isOpus = (m: string) => /opus|fable/i.test(m)
const isHaiku = (m: string) => /haiku/i.test(m)

function hhmm(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return ` (сброс в ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')})`
}

function limitName(kind: string): string {
  if (kind === 'five_hour') return '5-часовой лимит'
  if (kind === 'seven_day') return 'Недельный лимит'
  return `Лимит ${kind}`
}

function buildTips(s: Snapshot | null, st: Stats, t: number): Tip[] {
  const tips: Tip[] = []
  if (!s) return tips
  const pct = s.ctxPct

  if (pct >= 80) {
    tips.push({
      id: 'ctx-alarm',
      level: 'alarm',
      text: `Контекст заполнен на ${pct}%. Каждое сообщение отправляет все ${k(s.ctxTokens)} токенов заново — сожми сейчас.`,
      action: { kind: 'compact', label: 'Сжать (/compact)' },
    })
  } else if (pct >= 50) {
    tips.push({
      id: 'ctx-warn',
      level: 'warn',
      text: `Контекст ${pct}%. Хорошее время для /compact — пока детали ещё свежие.`,
      action: { kind: 'compact', label: 'Сжать (/compact)' },
    })
  }

  for (const l of s.limits) {
    if (l.pct >= 75 && !isHaiku(s.model)) {
      tips.push({
        id: `limit-${l.kind}`,
        level: l.pct >= 90 ? 'alarm' : 'warn',
        text: `${limitName(l.kind)} израсходован на ${l.pct}%${hhmm(l.resetsAt)}. Переключись на модель полегче.`,
        action: isOpus(s.model)
          ? { kind: 'command', label: 'Перейти на Sonnet', command: 'model', args: 'sonnet' }
          : { kind: 'command', label: 'Перейти на Haiku', command: 'model', args: 'haiku' },
      })
    }
  }

  if (st.lastGrowth >= 25000) {
    tips.push({
      id: `growth-${st.turns}`,
      level: 'warn',
      text: `Последний ход добавил ~${k(st.lastGrowth)} токенов в контекст — скорее всего большой файл или вывод команды. Проси читать частями и искать через grep, а не выводить всё.`,
    })
  }

  if (isOpus(s.model) && st.quietTurns >= 3) {
    tips.push({
      id: 'model-simple',
      level: 'info',
      text: `Последние ${st.quietTurns} ответа — короткие и без инструментов. Для такого хватит Sonnet: он заметно дешевле Opus.`,
      action: { kind: 'command', label: 'Перейти на Sonnet', command: 'model', args: 'sonnet' },
    })
  }

  const idleMin = st.lastActivity ? Math.floor((t - st.lastActivity) / 60000) : 0
  if (idleMin >= 60 && s.ctxTokens >= 30000) {
    tips.push({
      id: 'idle',
      level: 'info',
      text: `Пауза ${idleMin} мин: кэш остыл, следующее сообщение оплатит все ${k(s.ctxTokens)} токенов по полной цене. Сначала сожми или начни заново.`,
      action: { kind: 'compact', label: 'Сжать (/compact)' },
    })
  }

  if (st.turnsSinceCompact >= 40) {
    tips.push({
      id: 'long',
      level: 'info',
      text: `${st.turnsSinceCompact} ходов в одной сессии. Новая задача? Начни с чистого листа — старая история её только удорожает.`,
      action: { kind: 'command', label: 'Очистить (/clear)', command: 'clear' },
    })
  }

  if (st.agentCalls >= 3) {
    tips.push({
      id: 'agents',
      level: 'info',
      text: `Запущено субагентов: ${st.agentCalls}. Каждый стартует с нуля и заново читает файлы — для простого поиска проси искать напрямую.`,
    })
  }

  return tips
}

const HINTS = [
  'Называй файл и строку сразу: «в foo.bas, функция X» — Claude не будет искать по всему проекту.',
  '/compact можно дать подсказку: «/compact сохрани план и список файлов».',
  'Повторяющиеся объяснения положи в CLAUDE.md или память — их не придётся писать в каждом чате.',
  'Одна сессия — одна задача. Новая тема → новая сессия: дешевле и точнее.',
  'Для вопросов «что это значит» и мелких правок хватит Sonnet или Haiku.',
  'Вставляй в чат только нужный кусок лога, а не весь файл.',
  'Скриншот стоит ~1–2k токенов; текст ошибки обычно дешевле и точнее.',
]

// ---------- робот ----------

function robotSvg(mood: Level | 'ok'): string {
  const light = { ok: '#3ecf8e', info: '#4aa3ff', warn: '#f5b301', alarm: '#ff4d4f' }[mood]
  const mouth = {
    ok: '<path d="M44 78 Q60 90 76 78" stroke="#2b3140" stroke-width="4" fill="none" stroke-linecap="round"/>',
    info: '<path d="M46 80 Q60 86 74 80" stroke="#2b3140" stroke-width="4" fill="none" stroke-linecap="round"/>',
    warn: '<path d="M46 82 L74 82" stroke="#2b3140" stroke-width="4" stroke-linecap="round"/>',
    alarm: '<ellipse cx="60" cy="83" rx="8" ry="6" fill="#2b3140"/>',
  }[mood]
  const blinkDur = mood === 'alarm' ? '1.2s' : '4s'
  const eye = (cx: number) =>
    `<ellipse cx="${cx}" cy="58" rx="5" ry="5" fill="#2b3140"><animate attributeName="ry" values="5;5;0.6;5" keyTimes="0;0.92;0.96;1" dur="${blinkDur}" repeatCount="indefinite"/></ellipse>`
  const bob = mood === 'alarm' ? '0 -3; 0 3; 0 -3' : '0 0; 0 -2; 0 0'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 140" width="120" height="140">
  <g>
    <animateTransform attributeName="transform" type="translate" values="${bob}" dur="${mood === 'alarm' ? '0.6s' : '3s'}" repeatCount="indefinite"/>
    <line x1="60" y1="10" x2="60" y2="26" stroke="#8a93a6" stroke-width="3"/>
    <circle cx="60" cy="9" r="6" fill="${light}">
      <animate attributeName="opacity" values="1;0.35;1" dur="${mood === 'ok' ? '3s' : '1s'}" repeatCount="indefinite"/>
    </circle>
    <rect x="18" y="26" width="84" height="74" rx="22" fill="#dfe5ef" stroke="#8a93a6" stroke-width="3"/>
    <rect x="10" y="50" width="9" height="22" rx="4" fill="#b8c0cf"/>
    <rect x="101" y="50" width="9" height="22" rx="4" fill="#b8c0cf"/>
    <circle cx="42" cy="58" r="15" fill="#ffffff" stroke="#2b3140" stroke-width="4"/>
    <circle cx="78" cy="58" r="15" fill="#ffffff" stroke="#2b3140" stroke-width="4"/>
    <path d="M57 56 Q60 52 63 56" stroke="#2b3140" stroke-width="4" fill="none"/>
    <line x1="27" y1="56" x2="19" y2="53" stroke="#2b3140" stroke-width="3"/>
    <line x1="93" y1="56" x2="101" y2="53" stroke="#2b3140" stroke-width="3"/>
    ${eye(42)}${eye(78)}
    <path d="M33 50 L38 46" stroke="#ffffff" stroke-width="2" opacity="0.8"/>
    ${mouth}
    <rect x="36" y="104" width="48" height="30" rx="10" fill="#c9d1de" stroke="#8a93a6" stroke-width="3"/>
    <circle cx="60" cy="119" r="5" fill="${light}"/>
  </g>
</svg>`
}

function moodOf(tips: Tip[]): Level | 'ok' {
  if (tips.some(t => t.level === 'alarm')) return 'alarm'
  if (tips.some(t => t.level === 'warn')) return 'warn'
  if (tips.length > 0) return 'info'
  return 'ok'
}

const SPEECH = {
  ok: 'Всё экономно. Я слежу 👓',
  info: 'Есть пара идей, как сэкономить.',
  warn: 'Токены утекают — глянь советы.',
  alarm: 'Тревога! Дорогие сообщения!',
}

// ---------- сбор данных ----------

async function refresh($: EngineInterface) {
  const u = await $.session.usage()
  const model = await $.session.model()
  const limits: Limit[] = u.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt }))
  const t = await $.clock.now()
  const s: Snapshot = {
    ctxPct: u.context.percent ?? 0,
    ctxTokens: u.context.tokens ?? 0,
    window: u.context.window,
    costUsd: u.cost ? u.cost.usd : null,
    model,
    limits,
    updatedAt: t,
  }
  await update($, snap, () => s)
  await update($, now, () => t)

  // общий список сессий (по всем окнам)
  const id = await $.session.id()
  const cwd = await $.session.cwd()
  const all = ((await $.store.get(STORE_KEY)) ?? []) as OtherSession[]
  const day = 24 * 3600 * 1000
  const mine: OtherSession = { id, cwd, ctxPct: s.ctxPct, costUsd: s.costUsd, model, updatedAt: t }
  const list = [mine, ...all.filter(o => o.id !== id && t - o.updatedAt < day)].slice(0, 30)
  await $.store.set(STORE_KEY, list)
  await update($, others, () => list)
  return s
}

let lastAlarm = ''

async function nudge($: EngineInterface) {
  const s = await read($, snap)
  const st = await read($, stats)
  const m = await read($, muted)
  const tips = buildTips(s, st, await $.clock.now()).filter(t => !m.includes(t.id))
  const alarm = tips.find(t => t.level === 'alarm')
  $.ui.status(s ? `👓 контекст ${s.ctxPct}%` : undefined)
  if (alarm && alarm.id !== lastAlarm) {
    lastAlarm = alarm.id
    $.ui.toast(`Токенчик: ${alarm.text}`)
    void $.ui.open({ id: PANE, title: TITLE })
  }
  if (!alarm) lastAlarm = ''
}

async function show($: EngineInterface, why: string) {
  try {
    const panes = await $.ui.panes()
    if (panes.some(p => p.id === PANE && p.isPlaced)) return
    const res = await $.ui.open({ id: PANE, title: TITLE, placement: 'widget' })
    if (!res.isPlaced) $.ui.log(`tokenchik (${why}): панель не показана — ${'reason' in res ? String(res.reason) : '?'}`)
  } catch (err) {
    $.ui.log(`tokenchik (${why}): ошибка открытия — ${String(err)}`)
  }
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    await show($, 'prompt')
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'tokenchik-panel', description: 'Открыть Токенчика — помощника по экономии токенов' })
    void show($, 'start')
    try {
      await refresh($)
    } catch {}
    $.clock.every(60000, () => {
      void (async () => {
        try {
          await refresh($)
          await nudge($)
        } catch {}
      })()
    })
    return r
  })

  on('command.run', { command: 'tokenchik-panel' }, async $ => {
    const res = await $.ui.open({ id: PANE, title: TITLE })
    return {
      text: res.isPlaced
        ? 'Токенчик открыт.'
        : `Токенчик не смог открыться: ${'reason' in res ? String(res.reason) : 'причина неизвестна'}`,
    }
  })

  let toolsThisTurn = 0
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) toolsThisTurn = 0
    return next(e)
  })
  on('tool.call', async ($, e, next) => {
    toolsThisTurn += 1
    const name = e.tool as string
    if (name === 'Agent' || name === 'Task') {
      await update($, stats, st => ({ ...st, agentCalls: st.agentCalls + 1 }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    try {
      const before = (await read($, snap))?.ctxTokens ?? 0
      const s = await refresh($)
      const out = e.usage?.output_tokens ?? 0
      const tools = toolsThisTurn
      const t = await $.clock.now()
      await update($, stats, st => ({
        ...st,
        turns: st.turns + 1,
        turnsSinceCompact: st.turnsSinceCompact + 1,
        lastGrowth: before > 0 ? Math.max(0, s.ctxTokens - before) : 0,
        lastOutput: out,
        lastTools: tools,
        quietTurns: tools === 0 && out < 800 ? st.quietTurns + 1 : 0,
        lastActivity: t,
      }))
      await nudge($)
    } catch {}
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    try {
      await update($, stats, st => ({ ...st, turnsSinceCompact: 0, lastGrowth: 0 }))
      await refresh($)
      await nudge($)
    } catch {}
    return r
  })

  // ---------- панель ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const s = await read($, snap)
    const st = await read($, stats)
    const m = await read($, muted)
    const t = (await read($, now)) || (s?.updatedAt ?? 0)
    const tips = buildTips(s, st, t).filter(x => !m.includes(x.id))
    const mood = moodOf(tips)
    const hint = HINTS[(st.turns + Math.floor(t / 600000)) % HINTS.length]
    const list = (await read($, others)).filter(o => o.ctxPct >= 50)

    const doAction = async (a: Action) => {
      try {
        if (a.kind === 'compact') await $.session.compact({})
        else await $.command.run({ command: a.command, args: a.args })
      } catch (err) {
        $.ui.toast(`Не получилось: ${String(err)}. Набери команду вручную.`)
      }
    }
    const mute = (id: string) => update($, muted, l => [...l, id])

    const color = (l: Level) => (l === 'alarm' ? 'error' : l === 'warn' ? 'warning' : 'suggestion')
    const robot =
      'Svg' in ui ? (
        <ui.Svg source={robotSvg(mood)} alt="Токенчик — робот в очках" width={96} height={112} isInteractive />
      ) : (
        <Text>[o_o]</Text>
      )
    const Progress = 'Progress' in ui ? ui.Progress : undefined

    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {robot}
          <Box flexDirection="column" flexShrink={1}>
            <Text weight="semibold">Токенчик</Text>
            <Text dimColor>{SPEECH[mood]}</Text>
          </Box>
        </Box>

        {s ? (
          <Box flexDirection="column" gap={0}>
            {Progress ? (
              <Progress
                label="Контекст"
                value={s.ctxPct}
                max={100}
                valueText={`${s.ctxPct}% · ${k(s.ctxTokens)} из ${k(s.window)}`}
                color={s.ctxPct >= 80 ? 'error' : s.ctxPct >= 50 ? 'warning' : 'success'}
              />
            ) : (
              <Text>Контекст: {s.ctxPct}% · {k(s.ctxTokens)} из {k(s.window)}</Text>
            )}
            <Text dimColor>
              Модель: {s.model}
              {s.costUsd !== null ? ` · ≈$${s.costUsd.toFixed(2)} (оценка)` : ''} · ходов: {st.turns}
            </Text>
            {s.limits.map(l => (
              <Box key={l.kind}>
                <Text dimColor={l.pct < 75} color={l.pct >= 75 ? 'warning' : undefined}>
                  {limitName(l.kind)}: {l.pct}%{hhmm(l.resetsAt)}
                </Text>
              </Box>
            ))}
          </Box>
        ) : (
          <Text dimColor>Жду первого ответа модели, чтобы снять показания…</Text>
        )}

        {tips.length > 0 && <Text weight="semibold">Советы</Text>}
        {tips.map(tip => (
          <Box key={tip.id} flexDirection="column" gap={0} borderStyle="round" borderColor={color(tip.level)} padding={1}>
            <Text>{tip.text}</Text>
            <Box flexDirection="row" gap={1} marginTop={1}>
              {tip.action && (
                <Button
                  key={`do-${tip.id}`}
                  label={tip.action.label}
                  variant="primary"
                  onPress={() => doAction(tip.action as Action)}
                />
              )}
              <Button key={`mute-${tip.id}`} label="Не сейчас" onPress={() => mute(tip.id)} />
            </Box>
          </Box>
        ))}

        {list.length > 1 && (
          <Box flexDirection="column" gap={0}>
            <Text weight="semibold">Другие сессии с полным контекстом</Text>
            {list.slice(0, 5).map(o => (
              <Box key={o.id}>
                <Text dimColor>
                  {o.ctxPct}% · {o.model} · {o.cwd.split(/[\\/]/).pop()}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        <Box flexDirection="column" gap={0}>
          <Text weight="semibold">Подсказка</Text>
          <Text dimColor>{hint}</Text>
        </Box>

        {m.length > 0 && (
          <Button key="unmute" label="Вернуть скрытые советы" onPress={() => update($, muted, () => [])} />
        )}
      </Box>
    )
  })
}
