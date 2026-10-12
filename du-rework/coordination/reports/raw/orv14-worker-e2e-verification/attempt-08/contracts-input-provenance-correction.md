# Contracts input provenance correction

- Appended: `2026-10-12T01:38:43.845332+00:00` UTC.
- The original run-context copied the earlier 01:08 contracts manifest by mistake. Keep those original files as historical metadata.
- The 01:32:14–01:32:34 UTC Backend refresh was the compiled contracts snapshot present during this attempt. Its source manifest SHA-256 is `fd6f92da8c6948f42b28b5126b6de4d8feb801140a8c5f73d448444a16f81934` (46 rows); its post-build dist manifest SHA-256 is `4880c7cc7e0da0e01e3a0895078096c7a4009f7fa47be45f32727d4f1eb85b44` (184 rows).
- I compared every source and dist row in those 01:32 manifests with the 943-file dependency-input manifest captured before this attempt. All 46 source rows and 184 post-build dist rows match exactly; zero rows were missing or mismatched. The same 943-file manifest is unchanged after the attempt.
- Correct Backend receipt: `orchestrator/coordination/reports/raw/orv14-backend/contracts-refresh-2026-10-12T013214Z.md`. No Worker test rerun was needed for this metadata correction.
