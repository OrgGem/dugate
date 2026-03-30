import { NextRequest, NextResponse } from 'next/server';

/**
 * @swagger
 * /api/v1/billing/balance:
 *   get:
 *     summary: Kiểm tra số dư hiện tại (Mock API)
 *     description: Mô phỏng trả về số dư tín dụng còn lại của tài khoản/API Key.
 *     tags:
 *       - Cost Management
 *     responses:
 *       200:
 *         description: Success
 */
export async function GET(req: NextRequest) {
  // Mô phỏng check token
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Để mock cho dễ, không reject 401 mà vẫn trả về nhưng cảnh báo
    console.warn('[Mock] Thiếu Token');
  }

  // Trả về một đối tượng Mock balance
  const mockBalance = {
    object: 'billing_balance',
    user_id: 'mock_user_1',
    plan: 'Pay-As-You-Go',
    currency: 'USD',
    details: {
      total_granted: 100.00,
      total_used: 12.50,
      balance: 87.50,
      hard_limit: 150.00,
      soft_limit: 100.00,
    },
    updated_at: new Date().toISOString()
  };

  return NextResponse.json(mockBalance, { status: 200 });
}
