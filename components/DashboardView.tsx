'use client';

// components/DashboardView.tsx
// Traditional Flat Material Dashboard for DU Gate Observability

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, BarChart, Bar, Legend, PieChart, Pie, Cell
} from 'recharts';
import {
  Activity, CheckCircle, Database, DollarSign, RefreshCw,
  AlertCircle, ArrowRight, Layers, SlidersHorizontal
} from 'lucide-react';

const COLORS = ['#2563eb', '#16a34a', '#8b5cf6', '#ea580c', '#eab308', '#ec4899', '#06b6d4'];

interface AnalyticsData {
  success: boolean;
  summary: {
    totalRequests: number;
    successRate: number;
    totalTokens: number;
    totalCost: number;
  };
  timeSeries: Array<{
    time: string;
    requests: number;
    tokens: number;
    cost: number;
    successRequests: number;
    failRequests: number;
    pendingRequests: number;
  }>;
  profileBreakdown: Array<{ id: string; name: string; value: number }>;
  pipelineBreakdown: Array<{ name: string; value: number }>;
}

export default function DashboardView() {
  const [timeRange, setTimeRange] = useState('24h');
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/analytics?timeRange=${timeRange}&resolution=${timeRange === '24h' ? 'hour' : 'day'}`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to fetch analytics');
      }
      setData(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  if (error) {
    return (
      <div className="p-4 bg-red-50 dark:bg-red-950/30 text-destructive rounded-lg border border-red-200 dark:border-red-900 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 shrink-0" />
        <p className="text-sm font-medium">{error}</p>
        <button onClick={fetchAnalytics} className="ml-auto btn-outline text-xs px-3 py-1.5 rounded">
          Thử lại
        </button>
      </div>
    );
  }

  const { summary, timeSeries, profileBreakdown, pipelineBreakdown } = data || {};

  return (
    <div className="space-y-6">
      {/* ── CONTROLS TOOLBAR ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-3 bg-card border border-border rounded-lg shadow-xs">
        <div className="flex bg-muted p-1 rounded-md">
          {[
            { key: '24h', label: '24 giờ qua' },
            { key: '7d', label: '7 ngày qua' },
            { key: '30d', label: '30 ngày qua' },
          ].map(tr => (
            <button
              key={tr.key}
              onClick={() => setTimeRange(tr.key)}
              className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors ${
                timeRange === tr.key
                  ? 'bg-card text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tr.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/history"
            className="btn-outline inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md"
          >
            <span>Xem danh sách Operations</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
          <button
            onClick={fetchAnalytics}
            disabled={loading}
            className="btn-outline inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Làm mới</span>
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-pulse">
          {[1, 2, 3, 4].map(k => (
            <div key={k} className="h-28 bg-muted rounded-lg" />
          ))}
          <div className="lg:col-span-4 h-72 bg-muted rounded-lg mt-4" />
        </div>
      ) : (
        <>
          {/* ── KPI METRIC CARDS (Traditional Flat Cards) ──────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 bg-card border border-border rounded-lg shadow-xs">
              <div className="flex items-center justify-between text-muted-foreground mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">Tổng Requests</span>
                <Activity className="w-4 h-4 text-primary" />
              </div>
              <p className="text-2xl font-bold font-mono text-foreground">
                {summary?.totalRequests?.toLocaleString() || 0}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">Các lệnh gọi API ghi nhận</p>
            </div>

            <div className="p-4 bg-card border border-border rounded-lg shadow-xs">
              <div className="flex items-center justify-between text-muted-foreground mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">Tỷ lệ thành công</span>
                <CheckCircle className="w-4 h-4 text-green-600" />
              </div>
              <p className="text-2xl font-bold font-mono text-foreground">
                {summary?.successRate?.toFixed(1) || 0}%
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">Tỷ lệ hoàn tất không lỗi</p>
            </div>

            <div className="p-4 bg-card border border-border rounded-lg shadow-xs">
              <div className="flex items-center justify-between text-muted-foreground mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">Tokens Tiêu thụ</span>
                <Database className="w-4 h-4 text-primary" />
              </div>
              <p className="text-2xl font-bold font-mono text-foreground">
                {(summary?.totalTokens || 0).toLocaleString()}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">Input + Output token qua LLM</p>
            </div>

            <div className="p-4 bg-card border border-border rounded-lg shadow-xs">
              <div className="flex items-center justify-between text-muted-foreground mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">Chi phí ước tính</span>
                <DollarSign className="w-4 h-4 text-green-600" />
              </div>
              <p className="text-2xl font-bold font-mono text-green-600 dark:text-green-400">
                ${(summary?.totalCost || 0).toFixed(4)}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">Hạch toán theo model pricing</p>
            </div>
          </div>

          {/* ── CHARTS SECTION ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Request Volume Bar Chart */}
            <div className="lg:col-span-2 p-5 bg-card border border-border rounded-lg shadow-xs">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-foreground">Lưu lượng Yêu cầu (Request Volume)</h3>
                <span className="text-xs text-muted-foreground font-mono">
                  {timeRange === '24h' ? 'Theo từng giờ' : 'Theo từng ngày'}
                </span>
              </div>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={timeSeries || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" opacity={0.1} />
                    <XAxis
                      dataKey="time"
                      tickFormatter={(val) => {
                        const date = new Date(val);
                        return timeRange === '24h'
                          ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                          : date.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
                      }}
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 11, fill: 'currentColor', opacity: 0.6 }}
                      dy={8}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 11, fill: 'currentColor', opacity: 0.6 }}
                    />
                    <RechartsTooltip
                      labelFormatter={(label) => label ? new Date(String(label)).toLocaleString('vi-VN') : ''}
                      contentStyle={{
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        backgroundColor: 'var(--card)',
                        color: 'var(--card-foreground)',
                        boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
                        fontSize: '12px'
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                    <Bar dataKey="successRequests" stackId="a" fill="#16a34a" radius={[0, 0, 0, 0]} name="Thành công" />
                    <Bar dataKey="failRequests" stackId="a" fill="#dc2626" radius={[0, 0, 0, 0]} name="Thất bại" />
                    <Bar dataKey="pendingRequests" stackId="a" fill="#d97706" radius={[2, 2, 0, 0]} name="Đang xử lý" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Pipeline Distribution Chart */}
            <div className="p-5 bg-card border border-border rounded-lg shadow-xs">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-foreground">Phân bổ Pipeline</h3>
                <Layers className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="h-64 w-full flex items-center justify-center">
                {pipelineBreakdown && pipelineBreakdown.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={pipelineBreakdown}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={80}
                        paddingAngle={2}
                        dataKey="value"
                      >
                        {pipelineBreakdown.map((entry: any, index: number) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <RechartsTooltip
                        contentStyle={{
                          borderRadius: '6px',
                          border: '1px solid var(--border)',
                          backgroundColor: 'var(--card)',
                          color: 'var(--card-foreground)',
                          fontSize: '12px'
                        }}
                      />
                      <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '11px' }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-muted-foreground text-xs">Chưa có dữ liệu phân bổ pipeline</p>
                )}
              </div>
            </div>
          </div>

          {/* ── PROFILE USAGE DATA TABLE ────────────────────────────────────── */}
          <div className="data-table-container">
            <div className="px-4 py-3 border-b border-border bg-muted/40 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-bold text-foreground">Lưu lượng theo Profile Khách hàng</h3>
              </div>
              <Link href="/profiles" className="text-xs text-primary hover:underline font-semibold">
                Quản lý Profiles &rarr;
              </Link>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tên Profile</th>
                  <th className="text-right">Số lượng Operations</th>
                  <th className="text-right">Tỷ trọng</th>
                </tr>
              </thead>
              <tbody>
                {profileBreakdown && profileBreakdown.length > 0 ? (
                  profileBreakdown.map((item: any, i: number) => {
                    const totalOps = summary?.totalRequests || 1;
                    const percent = ((item.value / totalOps) * 100).toFixed(1);
                    return (
                      <tr key={i}>
                        <td className="font-semibold text-foreground">{item.name}</td>
                        <td className="text-right font-mono text-muted-foreground">{item.value.toLocaleString()}</td>
                        <td className="text-right font-mono text-xs">{percent}%</td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground text-xs">
                      Chưa có dữ liệu tác vụ cho profile trong khoảng thời gian này.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
