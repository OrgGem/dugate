import { NextRequest, NextResponse } from 'next/server';

/**
 * @swagger
 * /api/v1/billing/usage:
 *   get:
 *     summary: Thống kê chi phí theo Token/Page (Mock API)
 *     description: Mô phỏng lịch sử tiêu thụ tài nguyên của API key hoặc User.
 *     tags:
 *       - Cost Management
 *     parameters:
 *       - name: start_date
 *         in: query
 *       - name: end_date
 *         in: query
 *     responses:
 *       200:
 *         description: Success
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const startDate = searchParams.get('start_date') || '2026-03-01';
  const endDate = searchParams.get('end_date') || new Date().toISOString().split('T')[0];

  const mockUsage = {
    object: 'billing_usage',
    start_date: startDate,
    end_date: endDate,
    total_cost_usd: 12.50,
    usage: [
      {
        model: 'dugate-gemini-1.5',
        task_type: 'transform',
        prompt_tokens: 150000,
        completion_tokens: 30000,
        pages_processed: 120,
        cost_usd: 5.50
      },
      {
        model: 'dugate-gemini-1.5',
        task_type: 'generate',
        prompt_tokens: 50000,
        completion_tokens: 25000,
        pages_processed: 0,
        cost_usd: 4.00
      },
      {
        model: 'dugate-compare',
        task_type: 'compare',
        prompt_tokens: 0,
        completion_tokens: 0,
        pages_processed: 30,
        cost_usd: 3.00
      }
    ]
  };

  return NextResponse.json(mockUsage, { status: 200 });
}
