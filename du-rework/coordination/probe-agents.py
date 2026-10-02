#!/usr/bin/env python3
"""Probe live Orca terminals in du-rework and classify each roster agent.

Purpose: catch agents that are actually idle (finished turn, waiting at the
composer prompt) while the coordinator watch-state still records them as
`running`, and agents that are stalled mid-turn waiting on input.

Read-only. Writes nothing. Sends nothing.

Usage:  python coordination/probe-agents.py [--json] [--role qwen_1] [--full]
"""

import json
import subprocess
import sys
from datetime import datetime

REPO = r'D:\Git\dugate\du-rework'
STATE = REPO + r'\coordination\coordinator-state.json'
WATCH = REPO + r'\coordination\agent-watch-state.json'

# Rendered markers that mean "this agent has finished its turn and is sitting
# at the composer, waiting for the next instruction".
IDLE_FOOTERS = [
    'YOLO mode (tab to cycle)',
    'Context ',              # qwen-code status line, only drawn when idle
    'Report task outcome',   # codex end-of-turn prompt
    'Press up to edit',
    '? for shortcuts',
]

# Markers that mean a turn is in flight (tool call, spinner, thinking).
ACTIVE_MARKERS = [
    'esc to interrupt',
    'Running command',
    'Thought for',
    'Thinking...',
    '⠋', '⠙', '⠹', '⠸', '⠼', '⠴',
    'Working',
    'Compiling',
]


def orca_json(args):
    p = subprocess.run(['orca'] + args + ['--json'],
                       capture_output=True, text=True, encoding='utf-8',
                       errors='replace', timeout=90)
    if p.returncode != 0 or not p.stdout.strip():
        return None
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return None


def load(path):
    try:
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return {}


def screen_text(handle):
    d = orca_json(['terminal', 'read', '--terminal', handle, '--screen'])
    if not d:
        return None
    term = d.get('result', {}).get('terminal', {})
    return '\n'.join(term.get('tail') or [])


def classify(idle_min, screen, title):
    """Return (state, evidence) for one agent."""
    if screen is None:
        # Cannot see it. Fall back on idle time alone; do not claim idle.
        if idle_min > 15:
            return 'UNREADABLE_STALE', 'screen read failed, idle %.1fm' % idle_min
        return 'UNREADABLE', 'screen read failed, idle %.1fm' % idle_min

    tail = screen[-1200:]
    active = [m for m in ACTIVE_MARKERS if m in tail]
    idle_hit = [m for m in IDLE_FOOTERS if m in screen]

    if active:
        return 'WORKING', 'active marker: %s' % active[0]
    if idle_hit:
        if idle_min > 6:
            return 'IDLE_DONE', 'idle prompt (%.1fm) [%s]' % (idle_min, idle_hit[0])
        return 'IDLE_RECENT', 'idle prompt (%.1fm) [%s]' % (idle_min, idle_hit[0])
    if idle_min > 12:
        return 'STALLED', 'no prompt/active marker, idle %.1fm' % idle_min
    return 'UNKNOWN', 'idle %.1fm' % idle_min


def main():
    # Terminal screens carry braille spinners and box-drawing glyphs; the
    # default cp1252 stdout cannot encode them and would abort the sweep.
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except AttributeError:
        pass

    args = set(sys.argv[1:])
    state = load(STATE)
    watch = load(WATCH)
    roster = state.get('roster', {})

    live_d = orca_json(['terminal', 'list']) or {}
    now = datetime.now().timestamp() * 1000
    live = {t['handle']: t for t in (live_d.get('result', {}) or {}).get('terminals', [])}

    # Latest watch-state dispatch per terminal.
    watch_by_term = {}
    for ctx, d in (watch.get('dispatches') or {}).items():
        if not isinstance(d, dict):
            continue
        h = d.get('terminalHandle')
        if not h:
            continue
        prev = watch_by_term.get(h)
        if prev is None or (d.get('lastObservedAt') or '') > (prev[1].get('lastObservedAt') or ''):
            watch_by_term[h] = (ctx, d)

    rows = []
    for role, v in roster.items():
        h = v['handle']
        t = live.get(h)
        if not t:
            rows.append(dict(role=role, handle=h, state='OFFLINE',
                             idle=None, evidence='handle not in live terminal list',
                             watch=None, title=None, screen=None))
            continue
        idle = (now - t.get('lastOutputAt', now)) / 60000
        scr = screen_text(h)
        st, ev = classify(idle, scr, t.get('title'))
        ctx, wd = watch_by_term.get(h, (None, None))
        rows.append(dict(role=role, handle=h, state=st, idle=round(idle, 1),
                         evidence=ev, watch=(wd or {}).get('status'),
                         watch_ctx=ctx,
                         watch_obs=(wd or {}).get('lastObservedAt'),
                         title=t.get('title'), screen=scr,
                         connected=t.get('connected'), orphaned=t.get('orphaned')))

    if '--json' in args:
        out = []
        for r in rows:
            r = dict(r)
            if '--full' not in args:
                r.pop('screen', None)
            out.append(r)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    print('NOW = %s   turn=%s  last_tick=%s  watch.lastCheckedAt=%s'
          % (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), state.get('turn'),
             state.get('last_tick'), watch.get('lastCheckedAt')))
    print()
    hdr = '%-22s %-13s %7s %-10s %-14s %s'
    print(hdr % ('ROLE', 'STATE', 'IDLE_M', 'WATCH', 'CONNECTED', 'EVIDENCE'))
    print('-' * 116)
    order = {'STALLED': 0, 'OFFLINE': 1, 'UNREADABLE_STALE': 2, 'IDLE_DONE': 3,
             'WORKING': 4, 'UNKNOWN': 5, 'UNREADABLE': 6, 'IDLE_RECENT': 7}
    for r in sorted(rows, key=lambda x: (order.get(x['state'], 9), -(x['idle'] or 0))):
        if '--role' in args and args[args.index('--role') + 1] != r['role']:
            continue
        print(hdr % (r['role'], r['state'], str(r['idle']), str(r['watch']),
                     str(r['connected']), r['evidence']))

    print()
    mismatch = [r for r in rows
                if r['state'] in ('IDLE_DONE', 'IDLE_RECENT') and r['watch'] == 'running']
    stale_watch = [r for r in rows
                   if r['state'] in ('STALLED', 'OFFLINE') and r['watch'] == 'running']
    if mismatch:
        print('MISMATCH (watch says running, terminal is idle) -> nudge coordinator:')
        for r in mismatch:
            print('   %-22s idle %5.1fm  ctx=%s obs=%s'
                  % (r['role'], r['idle'] or -1, r['watch_ctx'], r['watch_obs']))
    if stale_watch:
        print('WATCH OVERCLAIMS (watch says running, terminal stalled/offline):')
        for r in stale_watch:
            print('   %-22s %s  ctx=%s obs=%s'
                  % (r['role'], r['state'], r['watch_ctx'], r['watch_obs']))
    if not mismatch and not stale_watch:
        print('No watch-vs-reality mismatch.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
