import subprocess
import sys

def main():
    text = """=== DIRECT USER REQUEST (YEU CAU TRUC TIEP TU NGUOI DUNG) ===
Nguoi dung chi dinh Claude Code (reviewer): "hay chuyen phan phe duyet danh gia nay cho agent claude code danh gia va xac nhan giup toi".

Nhiem vu: Tham dinh, danh gia chuyen mon doc lap va dua ra ket luan xac nhan / khuyen nghi cho 6 quyet dinh then chot (D1-D6) ma Coordinator DeepSeek da tong hop truoc khi quyet dinh commit wave:

1. D1: Xac nhan danh sach 157 file tracked diff (sau khi COMMIT-PRE-FLIGHT-813 da boc tach 31 file wave-confirmed, 94 file pre-existing theo mtime, 32 file unattributed). Khuyen nghi: Co nen tach commit 31 file nay truoc khong?
2. D2: Pham vi deliverable cho root Next.js app/config (app/doc-compare/page.tsx, app/doc-pipeline/components/Icons.tsx). Khuyen nghi: Co thuoc wave nay khong hay loai tru?
3. D3: Tach commit docs/tasks/coordination rieng biet voi code san pham? (Loai 1,716 file coordination va scratch khoi commit product code).
4. D4: 32 diff chua gan nhan ro rang - khuyen nghi danh gia, phan loai va xu ly ra sao?
5. D5: Phe duyet .env.example, chuan hoa .gitignore, xac nhan OpenAPI catalog (21-openapi.json) va test inventory (28-test-inventory.md).
6. D6: Xem xet cac doan xoa lon trong server.ts va runtime.test.ts, va quyen so huu lockfile/manifest truoc khi stage.

Hay doi chieu truc tiep voi commit-preflight-813-2026-10-05.md, REVIEW-812, REVIEW-813 va hien trang repo tren dia.
Xuat ban danh gia chi tiet tung muc D1-D6 kem khuyen nghi dut khoat cho Nguoi Dung vao section REVIEW-814 trong du-rework/coordination/reports/claude.md.
"""
    cmd = ['orca', 'terminal', 'send', '--terminal', 'term_19edcad8-dcd8-4930-a6a2-24f5f8be5bd8', '--text', text, '--enter', '--json']
    p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
    print("STDOUT:", p.stdout)
    print("STDERR:", p.stderr)
    return p.returncode

if __name__ == '__main__':
    sys.exit(main())
