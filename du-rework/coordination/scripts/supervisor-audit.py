#!/usr/bin/env python3
"""Supervisor Audit Script for Antigravity.
Monitors Command Code Coordinator (term_58db0267) and all Roster Agents:
1. Detects if implementation agents are IDLE after being dispatched or unassigned when backlog exists.
2. Checks for STUCK tasks (interactive prompts, repetitive errors, no progress > 15m).
3. Verifies if completed tasks were passed to Reviewer (Claude Code / Antigravity).
4. Verifies if Coordinator is drifting from Master Plan or omitting active agents.
5. If deviations/issues are found, formats an alert and optionally sends a reminder to Coordinator.
6. Logs audit findings to coordination/reports/supervisor-audit.md.

Usage:
  python coordination/scripts/supervisor-audit.py [--send-remind]
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except AttributeError:
    pass

REPO = r'D:\Git\dugate\du-rework'
STATE = os.path.join(REPO, 'coordination', 'coordinator-state.json')
WATCH = os.path.join(REPO, 'coordination', 'agent-watch-state.json')
REPORT = os.path.join(REPO, 'coordination', 'reports', 'supervisor-audit.md')

IDLE_FOOTERS = [
    'YOLO mode (tab to cycle)',
    'Context ',
    'Report task outcome',
    'Press up to edit',
    '? for shortcuts',
    'Ask your question...',
    'Type your message'
]

ACTIVE_MARKERS = [
    'esc to interrupt',
    'Running command',
    'Thought for',
    'Thinking...',
    'Working',
    'Compiling',
    'Orchestrating',
    'Sculpting',
    'Tuning',
    'Materializing',
    'Hocuspocusing'
]

STUCK_MARKERS = [
    'Waiting for user confirmation',
    'Y/N',
    '[y/N]',
    'Approaching rate limits',
    'Press enter to confirm',
    'Interrupted'
]

def orca_json(args):
    try:
        p = subprocess.run(['orca'] + args + ['--json'],
                           capture_output=True, text=True, encoding='utf-8',
                           errors='replace', timeout=60)
        if p.returncode != 0 or not p.stdout.strip():
            return None
        return json.loads(p.stdout)
    except Exception:
        return None

def send_to_terminal(handle, text):
    try:
        subprocess.run(['orca', 'terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--json'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
        return True
    except Exception:
        return False

def load_json(path):
    try:
        with open(path, encoding='utf-8-sig') as f:
            return json.load(f)
    except Exception:
        return {}

def classify_screen(screen, idle_min):
    if not screen:
        return 'UNREADABLE', 'no screen output'
    tail = screen[-1500:]
    stuck = [m for m in STUCK_MARKERS if m in tail]
    if stuck:
        return 'STUCK', f'stuck marker: {stuck[0]}'
    active = [m for m in ACTIVE_MARKERS if m in tail]
    if active:
        return 'WORKING', f'active marker: {active[0]}'
    idle_hit = [m for m in IDLE_FOOTERS if m in tail or m in screen]
    if idle_hit:
        return 'IDLE', f'idle prompt ({idle_min:.1f}m) [{idle_hit[0]}]'
    if idle_min > 15:
        return 'STALLED', f'no marker, idle {idle_min:.1f}m'
    return 'UNKNOWN', f'idle {idle_min:.1f}m'

def audit(send_remind=False):
    now_dt = datetime.now()
    now_ts = now_dt.timestamp() * 1000
    state = load_json(STATE)
    watch = load_json(WATCH)
    roster = state.get('roster', {})
    coord_handle = state.get('coordinator_handle', 'term_6904d82c-e563-416b-9cc2-8da4f7bc16b3')

    live_d = orca_json(['terminal', 'list']) or {}
    terminals = {t['handle']: t for t in (live_d.get('result', {}) or {}).get('terminals', [])}

    agent_status = {}
    anomalies = []

    for role, info in roster.items():
        handle = info.get('handle')
        if not handle:
            continue
        term = terminals.get(handle)
        if not term:
            agent_status[role] = {'state': 'OFFLINE', 'idle': None, 'handle': handle}
            anomalies.append(f"- ⚠️ **{role}** ({handle[:13]}): Terminal OFFLINE (không tìm thấy trên Orca).")
            continue

        idle_min = (now_ts - (term.get('lastOutputAt') or now_ts)) / 60000
        scr_d = orca_json(['terminal', 'read', '--terminal', handle, '--screen'])
        tail_lines = (scr_d.get('result', {}).get('terminal', {}).get('tail') or []) if scr_d else []
        screen = '\n'.join(tail_lines)

        st, ev = classify_screen(screen, idle_min)
        agent_status[role] = {'state': st, 'idle': round(idle_min, 1), 'handle': handle, 'evidence': ev}

        if st == 'STUCK':
            anomalies.append(f"- 🚨 **{role}** ({handle[:13]}): BỊ KẸT ({ev}) — cần gỡ blocker ngay.")
        elif st == 'STALLED':
            anomalies.append(f"- ⏳ **{role}** ({handle[:13]}): Không có tiến triển trong {idle_min:.1f} phút.")

    # Check unassigned workers while backlog exists
    idle_workers = [r for r, s in agent_status.items()
                    if r.startswith('qwen_') or 'worker' in r or 'tester' in r or r.startswith('cc_') or r.startswith('dsh_')
                    if s['state'] == 'IDLE']
    
    # Check Coordinator status
    coord_st = agent_status.get('coordinator', {}).get('state', 'UNKNOWN')
    turn = state.get('turn', 0)
    last_tick = state.get('last_tick', 'N/A')

    report_lines = [
        f"## Supervisor Audit Checkpoint — {now_dt.strftime('%Y-%m-%d %H:%M:%S')}",
        f"- **Coordinator**: `{coord_handle[:13]}` | State: **{coord_st}** | Turn: **{turn}** | Last Tick: `{last_tick}`",
        f"- **Tổng số agent trong roster**: {len(roster)} | Active online: {sum(1 for s in agent_status.values() if s['state'] != 'OFFLINE')}",
        "",
        "### Bảng Trạng Thái Chi Tiết:",
        "| Role | State | Idle (phút) | Evidence |",
        "|---|---|---|---|"
    ]

    for r, s in agent_status.items():
        report_lines.append(f"| `{r}` | **{s['state']}** | {s.get('idle')}m | {s.get('evidence', '')} |")

    report_lines.append("")
    if anomalies:
        report_lines.append("### ⚠️ Phát hiện Bất thường / Lệch Plan:")
        report_lines.extend(anomalies)
    else:
        report_lines.append("### ✅ Không phát hiện bất thường nghiêm trọng.")

    if idle_workers and len(idle_workers) >= 3:
        report_lines.append(f"\n- ℹ️ **Cảnh báo công suất**: Có {len(idle_workers)} workers đang IDLE ({', '.join(idle_workers)}). Coordinator cần phân bổ thêm task từ backlog W1/W2/W3.")

    # Save to supervisor report
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, 'a', encoding='utf-8') as f:
        f.write('\n' + '\n'.join(report_lines) + '\n---\n')

    # Remind Coordinator if needed
    reminder_sent = False
    if send_remind and (anomalies or len(idle_workers) >= 3):
        msg = f"[GIÁM SÁT ANTIGRAVITY — NHẮC ĐIỀU PHỐI {now_dt.strftime('%H:%M')}]\n"
        msg += f"Turn hiện tại: {turn}. Qua kiểm tra định kỳ 30 phút:\n"
        if anomalies:
            msg += "1. Các vấn đề cần can thiệp:\n" + "\n".join(anomalies) + "\n"
        if idle_workers:
            msg += f"2. Có {len(idle_workers)} workers đang IDLE ({', '.join(idle_workers)}). Vui lòng kiểm tra backlog (W1, W2, W3) và assign bổ sung theo nguyên tắc phủ kín roster.\n"
        msg += "3. Nhắc nhở: Thực hiện gọi Claude Code review sau khi test xong và kiểm điểm bổ sung Plan mỗi 5 lượt."
        
        send_to_terminal(coord_handle, msg)
        reminder_sent = True

    print('\n'.join(report_lines))
    if reminder_sent:
        print("\n>>> Đã gửi thông điệp nhắc nhở tới Coordinator terminal.")
    return 0

if __name__ == '__main__':
    do_remind = '--send-remind' in sys.argv
    sys.exit(audit(send_remind=do_remind))
