import subprocess
import sys

def main():
    text = """[THONG BAO TU SUPERVISOR ANTIGRAVITY]
Nguoi dung da ra chi thi truc tiep: Uy quyen toan bo phan phe duyet, danh gia va xac nhan 6 quyet dinh D1-D6 cho agent Reviewer Claude Code (term_19edcad8).
Claude Code da nhan lenh truc tiep va dang tien hanh tham dinh chuyen mon doc lap de xuat ban danh gia REVIEW-814.
Coordinator DeepSeek ghi nhan de phoi hop va tiep tuc cac cong viec khac trong backlog."""
    cmd = ['orca', 'terminal', 'send', '--terminal', 'term_6904d82c-e563-416b-9cc2-8da4f7bc16b3', '--text', text, '--enter', '--json']
    p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
    print("STDOUT:", p.stdout)
    print("STDERR:", p.stderr)
    return p.returncode

if __name__ == '__main__':
    sys.exit(main())
