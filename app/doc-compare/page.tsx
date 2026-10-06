'use client';

// app/doc-compare/page.tsx
// So sánh Văn bản Nâng cao — Upload 2 văn bản, phân tích mục lục, so sánh từng mục

import React, { useState, useRef, useCallback, useMemo } from 'react';
import {
  FileText, FolderOpen, Search, X, RotateCcw,
  Sparkles, AlertCircle, ArrowRight
} from 'lucide-react';
import type { PipelineStep, StepStatus, UploadedFile } from './types';
import { getInitialSteps, getFileIcon, formatBytes } from './lib/mock-data';
import { useWorkflowPolling } from './hooks/useWorkflowPolling';

import { PipelineStepCard } from '@/app/doc-pipeline/components/PipelineStepCard';
import { CompletionBanner } from '@/app/doc-pipeline/components/CompletionBanner';
import { Button, Input, Badge, Card, ConfirmDialog } from '@/components/ui';

// ─── File Slot Component ──────────────────────────────────────────────────────

interface FileSlotProps {
  label: string;
  slotIndex: number;
  file: UploadedFile | null;
  isProcessing: boolean;
  onFileSelected: (file: UploadedFile, realFile: File, slotIndex: number) => void;
  onFileRemoved: (slotIndex: number) => void;
}

function FileSlot({ label, slotIndex, file, isProcessing, onFileSelected, onFileRemoved }: FileSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = (rawFile: File) => {
    const uploaded: UploadedFile = {
      id: `slot-${slotIndex}-${Date.now()}`,
      name: rawFile.name,
      size: rawFile.size,
      type: rawFile.type,
      icon: getFileIcon(rawFile.name),
    };
    onFileSelected(uploaded, rawFile, slotIndex);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) handleFile(dropped);
  };

  return (
    <div className="flex-1 min-w-0">
      <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">{label}</p>
      {file ? (
        <div className="p-4 rounded-xl border border-primary/20 bg-primary/5 flex items-center gap-3 transition-colors shadow-xs">
          <FileText className="w-8 h-8 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate text-foreground">{file.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{formatBytes(file.size)}</p>
          </div>
          {!isProcessing && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onFileRemoved(slotIndex)}
              aria-label="Xóa file"
              className="text-muted-foreground hover:text-destructive"
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      ) : (
        <div
          className={`border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center gap-2 cursor-pointer transition-all duration-200 ${
            isDragging
              ? 'border-primary bg-primary/10'
              : 'border-border hover:border-primary/50 hover:bg-muted/30'
          }`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <FileText className="w-8 h-8 text-muted-foreground/60" />
          <p className="text-xs text-muted-foreground text-center">
            Kéo thả hoặc <span className="text-primary font-semibold">chọn file</span>
          </p>
          <p className="text-[10px] text-muted-foreground/70 uppercase tracking-wider font-mono">PDF, DOCX, XLSX</p>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,.doc,.xlsx,.xls"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            disabled={isProcessing}
          />
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function DocComparePage() {
  const [files, setFiles] = useState<(UploadedFile | null)[]>([null, null]);
  const [realFiles, setRealFiles] = useState<(File | null)[]>([null, null]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [pipelineComplete, setPipelineComplete] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [testApiKeyId, setTestApiKeyId] = useState('');
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [steps, setSteps] = useState<PipelineStep[]>(getInitialSteps());

  const currentRunningStep = useMemo(
    () => steps.findIndex(s => s.status === 'running'),
    [steps],
  );

  const allFilesReady = files[0] !== null && files[1] !== null;

  const resetPipeline = useCallback(() => {
    setSteps(getInitialSteps());
    setPipelineComplete(false);
    setPipelineError(null);
  }, []);

  const toggleCollapse = useCallback((stepIndex: number) => {
    setSteps(prev => prev.map((s, idx) =>
      idx === stepIndex ? { ...s, isCollapsed: !s.isCollapsed } : s,
    ));
  }, []);

  const scrollToStep = useCallback((stepIdx: number) => {
    setTimeout(() => {
      stepRefs.current[stepIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 300);
  }, []);

  const handleFileSelected = useCallback((file: UploadedFile, realFile: File, slotIndex: number) => {
    setFiles(prev => { const n = [...prev]; n[slotIndex] = file; return n; });
    setRealFiles(prev => { const n = [...prev]; n[slotIndex] = realFile; return n; });
    resetPipeline();
  }, [resetPipeline]);

  const handleFileRemoved = useCallback((slotIndex: number) => {
    setFiles(prev => { const n = [...prev]; n[slotIndex] = null; return n; });
    setRealFiles(prev => { const n = [...prev]; n[slotIndex] = null; return n; });
    resetPipeline();
  }, [resetPipeline]);

  const revealStep = useCallback((stepIdx: number, backendStep: Record<string, unknown>) => {
    setSteps(prev => {
      const newSteps = [...prev];
      if (stepIdx >= newSteps.length) return prev;
      const uiStep = { ...newSteps[stepIdx] };

      uiStep.status = 'done';
      uiStep.progress = 100;

      // Step 0 (OCR) shows per-file results
      if (stepIdx === 0 && Array.isArray(backendStep.sub_results)) {
        uiStep.filesProgress = (backendStep.sub_results as any[]).map((r, idx) => ({
          id: r.doc_id ?? `sub-${idx}`,
          file: { id: r.doc_id ?? `sub-${idx}`, name: r.doc_label ?? `File ${idx + 1}`, size: 0, type: '', icon: '📄' },
          status: (r.status === 'success' ? 'done' : 'error') as StepStatus,
          progress: 100,
          output: r.content ?? null,
          duration: null,
        }));
        uiStep.output = null;
      } else {
        const extracted = backendStep.extracted_data;
        if (extracted) {
          uiStep.output = typeof extracted === 'string'
            ? extracted
            : JSON.stringify(extracted, null, 2);
        } else if (typeof backendStep.content_preview === 'string') {
          uiStep.output = backendStep.content_preview;
        }
      }

      newSteps[stepIdx] = uiStep;
      const nextIdx = stepIdx + 1;
      if (nextIdx < newSteps.length && newSteps[nextIdx].status === 'pending') {
        newSteps[nextIdx] = { ...newSteps[nextIdx], status: 'running', progress: 15 };
      }
      return newSteps;
    });
    scrollToStep(stepIdx);
  }, [scrollToStep]);

  const polling = useWorkflowPolling({
    onStepReveal: revealStep,
    onComplete: () => { setPipelineComplete(true); setIsProcessing(false); },
    onError: (stepIdx, message) => {
      setSteps(prev => prev.map((s, idx) =>
        idx === stepIdx ? { ...s, status: 'error' as StepStatus, output: message } : s,
      ));
      setPipelineError(message);
      setPipelineComplete(true);
      setIsProcessing(false);
    },
    onProgress: (stepIdx, percent) => {
      setSteps(prev => prev.map((s, idx) =>
        idx === stepIdx && s.status !== 'done'
          ? { ...s, status: 'running' as StepStatus, progress: percent }
          : s,
      ));
    },
  });

  const runPipeline = async () => {
    if (!allFilesReady || isProcessing) return;
    if (!testApiKeyId.trim()) {
      setPipelineError('Vui lòng nhập Profile API Key ID để chạy so sánh.');
      return;
    }

    setIsProcessing(true);
    setPipelineError(null);
    resetPipeline();
    setSteps(prev => prev.map((s, idx) =>
      idx === 0 ? { ...s, status: 'running' as StepStatus, progress: 5 } : s,
    ));

    try {
      const uploadedFiles = files.filter(Boolean) as UploadedFile[];
      const rawFiles = realFiles.filter(Boolean) as File[];
      await polling.submitWorkflow(uploadedFiles, rawFiles, testApiKeyId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSteps(prev => prev.map((s, idx) =>
        idx === 0 ? { ...s, status: 'error' as StepStatus, output: msg } : s,
      ));
      setPipelineError(msg);
      setPipelineComplete(true);
      setIsProcessing(false);
    }
  };

  const confirmAbort = useCallback(async () => {
    if (!polling.operationId) return;
    try {
      await fetch(`/api/v1/operations/${polling.operationId}/cancel`, { method: 'POST' });
    } catch {}
    polling.stopPolling();
    setPipelineError('Workflow đã bị hủy bởi người dùng.');
    setPipelineComplete(true);
    setIsProcessing(false);
  }, [polling]);

  const uploadedFileList = files.filter(Boolean) as UploadedFile[];

  return (
    <div className="min-h-screen pb-20 relative">
      {/* Confirm Dialog */}
      <ConfirmDialog
        isOpen={showAbortConfirm}
        onClose={() => setShowAbortConfirm(false)}
        onConfirm={confirmAbort}
        isDestructive
        title="Hủy Quá Trình So Sánh"
        description="Thao tác hủy này không thể khôi phục. Các bước so sánh đang chạy sẽ bị dừng ngay lập tức."
        confirmText="Dừng workflow"
      />

      {/* Header */}
      <div className="max-w-5xl mx-auto px-4 pt-8 pb-6">
        <div className="text-center mb-6">
          <div className="inline-flex items-center gap-2 mb-3">
            <Badge variant="primary" dot>
              Advanced Document Comparison
            </Badge>
          </div>

          <h1 className="text-3xl md:text-4xl font-heading font-bold tracking-tight mb-3 text-foreground">
            So sánh Văn bản Nâng cao
          </h1>
          <p className="text-muted-foreground text-sm md:text-base max-w-2xl mx-auto leading-relaxed">
            Upload 2 văn bản quy trình/quy định → OCR → Phân tích Mục lục → So sánh từng mục (phát hiện thêm/xóa/sửa) → Báo cáo chi tiết
          </p>

          <div className="flex items-center justify-center gap-2 mt-4 flex-wrap">
            {['Phát hiện Thêm mục', 'Phát hiện Xóa mục', 'Nội dung Sửa đổi', 'Báo cáo Markdown'].map(badge => (
              <Badge key={badge} variant="outline">
                {badge}
              </Badge>
            ))}
          </div>

          <div className="mt-5 mx-auto max-w-sm">
            <Input
              placeholder="Target Profile API Key ID (Bắt buộc)"
              value={testApiKeyId}
              onChange={(e) => setTestApiKeyId(e.target.value)}
              disabled={isProcessing}
              id="input-api-key-id"
              className="text-center"
              helperText="* Bắt buộc phải nhập Profile API Key ID để định tuyến connector"
            />
          </div>
        </div>

        {/* ─── 2-File Upload Slots ─────────────────────────────────────── */}
        <Card className="p-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <FolderOpen className="w-5 h-5 text-primary" />
            <h2 className="text-base font-bold text-foreground">Upload 2 Văn bản Cần So Sánh</h2>
            {allFilesReady && (
              <Badge variant="success" dot className="ml-auto">
                Sẵn sàng so sánh
              </Badge>
            )}
          </div>

          <div className="flex gap-4 flex-col sm:flex-row">
            <FileSlot
              label="Văn bản gốc (VB1)"
              slotIndex={0}
              file={files[0]}
              isProcessing={isProcessing}
              onFileSelected={handleFileSelected}
              onFileRemoved={handleFileRemoved}
            />

            {/* VS divider */}
            <div className="flex items-center justify-center">
              <div className="w-px h-full bg-border sm:w-8 sm:h-px hidden sm:block" />
              <div className="px-3 py-1.5 rounded-full bg-muted border border-border text-xs font-bold text-muted-foreground shrink-0 select-none">
                VS
              </div>
              <div className="w-px h-full bg-border sm:w-8 sm:h-px hidden sm:block" />
            </div>

            <FileSlot
              label="Văn bản so sánh (VB2)"
              slotIndex={1}
              file={files[1]}
              isProcessing={isProcessing}
              onFileSelected={handleFileSelected}
              onFileRemoved={handleFileRemoved}
            />
          </div>
        </Card>

        {/* Action button */}
        {allFilesReady && (
          <div className="flex items-center gap-3 mb-6">
            <Button
              onClick={runPipeline}
              disabled={isProcessing || pipelineComplete}
              isLoading={isProcessing}
              leftIcon={<Search className="w-4 h-4" />}
              size="lg"
              id="btn-start-doc-compare"
              className="flex-1 sm:flex-none shadow-sm"
            >
              {pipelineComplete && !pipelineError ? 'So sánh Hoàn tất' : 'Bắt đầu So sánh Văn bản'}
            </Button>

            {isProcessing && (
              <Button
                variant="destructive"
                onClick={() => setShowAbortConfirm(true)}
                leftIcon={<X className="w-4 h-4" />}
              >
                Hủy Workflow
              </Button>
            )}

            {pipelineComplete && (
              <Button
                variant="outline"
                onClick={() => resetPipeline()}
                leftIcon={<RotateCcw className="w-4 h-4" />}
                id="btn-reset-doc-compare"
              >
                So sánh lại
              </Button>
            )}
          </div>
        )}

        {/* Error notification */}
        {pipelineError && !pipelineComplete && (
          <div className="p-4 rounded-xl border border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-3 mb-6 animate-in slide-in-from-top-2 duration-300" role="alert">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium">{pipelineError}</p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPipelineError(null)}
              className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        )}

        {/* Pipeline Steps */}
        {allFilesReady && (
          <div className="space-y-0 relative">
            <div className="absolute left-[27px] top-[40px] bottom-[40px] w-px bg-gradient-to-b from-primary/30 via-primary/10 to-transparent z-0" />
            {steps.map((step, i) => (
              <React.Fragment key={step.id}>
                <PipelineStepCard
                  ref={el => { stepRefs.current[i] = el; }}
                  step={step}
                  stepIndex={i}
                  totalSteps={steps.length}
                  isProcessing={isProcessing}
                  onRetry={() => {}}
                  onToggleCollapse={toggleCollapse}
                  isLastStep={i === steps.length - 1}
                />
              </React.Fragment>
            ))}
          </div>
        )}

        {/* Completion Banner */}
        {pipelineComplete && (
          <CompletionBanner steps={steps} files={uploadedFileList} error={pipelineError} />
        )}
      </div>

      {/* Floating progress badge */}
      {isProcessing && (
        <div
          className="fixed bottom-6 right-6 px-4 py-2.5 rounded-2xl bg-card/95 backdrop-blur-md border border-border shadow-xl flex items-center gap-3 animate-in slide-in-from-bottom-4 duration-300 z-40"
          role="status" aria-live="polite"
        >
          <div className="w-2.5 h-2.5 rounded-full bg-primary animate-pulse" />
          <span className="text-sm font-semibold text-foreground">Đang so sánh 2 văn bản...</span>
          <Badge variant="secondary" className="font-mono text-[11px]">
            {currentRunningStep >= 0 ? `Bước ${currentRunningStep + 1}/${steps.length}` : 'Khởi tạo...'}
          </Badge>
        </div>
      )}
    </div>
  );
}
