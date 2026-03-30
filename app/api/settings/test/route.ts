// app/api/settings/test/route.ts
// POST /api/settings/test — verify API key hợp lệ với provider

import { getSetting } from '@/lib/settings';

export async function POST() {
  try {
    const provider = await getSetting('ai_provider');
    const model = await getSetting('ai_model');
    if (provider === 'gemini') {
      const apiKey = await getSetting('ai_api_key');
      if (!apiKey) {
        return Response.json({ success: false, message: 'Chưa nhập Gemini API key. Vui lòng nhập và lưu trước.' }, { status: 400 });
      }
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(apiKey);
      const geminiModel = genAI.getGenerativeModel({ model: model || 'gemini-2.0-flash-lite' });
      await geminiModel.generateContent('Hello');
      return Response.json({ success: true, message: `Kết nối ${provider} (${model}) thành công!` });
    }

    if (provider === 'openai') {
      const apiKey = await getSetting('openai_api_key');
      const baseURL = await getSetting('openai_base_url');
      if (!apiKey && !baseURL) {
        return Response.json({ success: false, message: 'Chưa nhập OpenAI API key hoặc Base URL.' }, { status: 400 });
      }
      const { OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: apiKey || 'dummy-key', baseURL: baseURL || 'https://api.openai.com/v1' });
      await openai.chat.completions.create({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 5
      });
      return Response.json({ success: true, message: `Kết nối OpenAI (${model}) thông qua ${baseURL} thành công!` });
    }

    return Response.json(
      { success: false, message: `Provider "${provider}" chưa được hỗ trợ kiểm tra.` },
      { status: 400 }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return Response.json(
      { success: false, message: `Kết nối thất bại: ${msg}` },
      { status: 400 }
    );
  }
}
