# Pinned third-party release artifacts

`xlsx-0.20.3.tgz` is the unmodified SheetJS Community Edition package from
https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz, downloaded on 2026-10-06.
The vendor recommends this distribution instead of the stale npm release:
https://docs.sheetjs.com/docs/getting-started/installation/nodejs/.

SHA-256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`.
The tarball includes its upstream Apache-2.0 license and notices; retain those
when copying/installing the package. The pnpm lockfile pins the local tarball
integrity. Do not replace it in place with a different artifact under this name.

An update must use a new versioned filename, record authoritative provenance
and checksums, regenerate the lockfile, rerun spreadsheet parser/archive tests
and dependency/image scans. Isolated repo candidates and worker templates must
include this artifact whenever their dependency graph uses document-kit/xlsx.
