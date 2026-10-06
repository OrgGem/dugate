import subprocess

nudges = [
    ('term_37c6cebe-5c6f-4eae-9690-db6d1b3c8740', 'Task VERIFY-WINDOW-DOC-817 - vao lam ngay. Kiem tra doc lap file coordination/reports/encmeta-window-design-808-2026-10-05.md so voi real code. Xuat receipt coordination/reports/verify-window-doc-817-2026-10-05.md.'),
    ('term_2ea0ce2e-1612-449f-b772-b177fe15df31', 'Task SHIPPING-CHECKLIST-817 - vao lam ngay. Kiem tra 7 muc shipping checklist: 6 public endpoints, DAG workflow, BullMQ worker, idempotency, webhook, auth middleware, RBAC. Xuat receipt coordination/reports/shipping-checklist-817-2026-10-05.md.'),
    ('term_822128f8-b2b6-4685-bd12-ce91069949b8', 'Task SKIPPED-TESTS-TRIAGE-816 - vao lam ngay. Phan loai 230 test bi skip trong full-regression. Xuat receipt coordination/reports/skipped-tests-triage-816-2026-10-05.md.')
]

for handle, text in nudges:
    r = subprocess.run(['orca', 'terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--json'],
                       capture_output=True, text=True, encoding='utf-8')
    print(f"{handle[:13]} accepted: {'true' in r.stdout.lower()}")
