# Architecture: mdconvert

## Luồng data tổng thể

```
Browser → Upload API → File Storage (uploads/)
                            │
                ┌───────────┴───────────┐
                │                       │
            .docx?                  .pdf?
                │                       │
                ▼                       ▼
        Pandoc CLI              Ghostscript CLI
        (tách md + hình)        (compress PDF)
                │                       │
                ▼                       ▼
        sharp compress          Gemini Flash API
        (resize hình)           (PDF → markdown)
                │                       │
                ▼                       │
        Gemini Flash API                │
        (hình → mô tả)                 │
                │                       │
                ▼                       ▼
        Assembler               Output: text-only.md
        (ghép md + mô tả)
                │
                ▼
        Output: full.md + text-only.md + images/
                │
                ▼
        DB (Transformation record) + File Storage (outputs/)
                │
                ▼
        Preview / Edit / Download ZIP
```

## Cấu trúc thư mục

```
mdconvert/
├── CLAUDE.md
├── docs/
│   ├── constitution.md
│   ├── architecture.md
│   ├── database-schema.md
│   ├── business-rules.md
│   └── api-contracts.md
├── .claude/
│   └── commands/
│       └── review.md
├── .env.example
├── .gitignore
├── prisma/
│   └── schema.prisma
├── src/
│   └── app/
│       ├── layout.tsx
│       ├── page.tsx                    # Upload page
│       ├── login/page.tsx
│       ├── transform/[id]/page.tsx       # Result: preview + edit + download
│       ├── history/page.tsx
│       └── api/
│           ├── auth/[...nextauth]/route.ts
│           ├── upload/route.ts
│           ├── transform/route.ts        # Trigger transformation
│           ├── transform/[id]/route.ts   # Get transformation result
│           ├── transform/[id]/edit/route.ts  # Save edited markdown
│           └── transform/[id]/download/route.ts  # Download ZIP
├── src/lib/
│   ├── transformers/
│   │   ├── docx.ts                     # Pandoc + assemble pipeline
│   │   └── pdf.ts                      # Ghostscript + Gemini pipeline
│   ├── compress/
│   │   ├── images.ts                   # sharp resize + quality
│   │   └── pdf.ts                      # Ghostscript presets
│   ├── ai/
│   │   └── gemini.ts                   # Gemini API wrapper (vision + PDF)
│   ├── assembler.ts                    # Ghép raw.md + mô tả → full.md + text-only.md
│   ├── zip.ts                          # Đóng gói output thành ZIP
│   └── prisma.ts                       # Prisma client singleton
├── src/components/
│   ├── UploadForm.tsx
│   ├── CompressSelector.tsx            # 4 mức Ghostscript
│   ├── MarkdownPreview.tsx
│   ├── MarkdownEditor.tsx
│   ├── ConversionHistory.tsx
│   └── StatusBadge.tsx
├── uploads/                            # Git-ignored, file gốc upload
└── outputs/                            # Git-ignored, kết quả transform
    └── [transformation-id]/
        ├── raw.md
        ├── full.md
        ├── text-only.md
        ├── images/
        │   ├── [sop]-img-001.png       # Hình gốc
        │   └── [sop]-img-001-compressed.png  # Hình đã nén (tạm, xóa sau)
        └── compressed.pdf              # PDF đã nén (tạm, xóa sau)
```

## Component map

| Component | Dùng ở đâu | Chức năng |
|---|---|---|
| UploadForm | / | Drag-drop hoặc click upload, hiển thị file info |
| CompressSelector | / | Radio 4 mức compress, chỉ hiện khi upload PDF |
| MarkdownPreview | /transform/[id] | react-markdown render HTML từ markdown |
| MarkdownEditor | /transform/[id] | Textarea hoặc md-editor, sửa markdown |
| ConversionHistory | /history | Bảng danh sách transformations, sort theo ngày |
| StatusBadge | /history, /transform/[id] | Badge hiển thị status: pending/compressing/processing/completed/failed |
