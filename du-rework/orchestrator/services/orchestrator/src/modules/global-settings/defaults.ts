import type { TenantAiDefaults, TenantPromptDefaults } from '@du/contracts';

/** Legacy-compatible defaults. These are code fallbacks only; edits are never
 * written back as mutable process configuration. */
export const DEFAULT_TENANT_AI_DEFAULTS: TenantAiDefaults = {
  provider: 'gemini',
  model: 'gemini-1.5-flash',
  connectorId: null,
  connectorRevision: null,
};

export const TENANT_PROMPT_PRESETS: Readonly<Record<'en' | 'vi', Partial<TenantPromptDefaults>>> = {
  en: {
    image: `You are describing an image from an internal SOP (Standard Operating Procedure) document. Purpose: to help AI agents guide employees through procedures without seeing the original image.\n\nDescribe in detail using this structure:\n\n1. IMAGE TYPE: Screenshot of software, process diagram, real photo, or table/chart.\n\n2. MAIN CONTENT:\n   - If software screenshot: app name, current screen, data fields, sample values, highlighted buttons or arrows.\n   - If process diagram: list each step in order with arrow directions.\n   - If real photo: describe objects, positions, conditions.\n   - If table/chart: list column headers and sample rows.\n\n3. TEXT IN IMAGE: Transcribe ALL visible text exactly as shown, especially labels, titles, values, button names.\n\n4. ACTION REQUIRED: If the image illustrates a specific action, describe exactly what to click/type/select and where.\n\nDo not add personal opinions. Do not guess information not visible in the image.`,
    pdf: `Transform this document to Markdown. Preserve heading structure, tables, and lists.\n\nFor each image in the document, replace with a detailed description block:\n> **[Image]:** [detailed description]\n\nInclude: image type, software name if screenshot, all visible text, and required actions if applicable.\n\nOutput clean Markdown with proper heading hierarchy (h1, h2, h3).`,
    docx: `Transform this Word document to Markdown. Preserve heading structure, tables, and lists.\nUse GitHub Flavored Markdown for tables. \n\nFor each image in the document, replace with a placeholder:\n![Image placeholder]()\n\nOutput clean Markdown with proper heading hierarchy (h1, h2, h3).`,
    compare: `You are a careful document comparison assistant. Compare the original document in FILE 1 with the revised document in FILE 2.\n\nFILE 1 (original):\n{file1}\n\nFILE 2 (revised):\n{file2}\n\nList only substantive additions, deletions, or edits. Preserve each changed passage verbatim where possible, identify its section or clause, and state the change briefly. Do not infer changes from missing or ambiguous text.\n\nReturn only a valid JSON array. Each item must have this shape:\n{\n  "clause": "section or clause identifier",\n  "file1Content": "exact original text, or an empty string when absent",\n  "file2Content": "exact revised text, or an empty string when absent",\n  "note": "brief description of the addition, deletion, or edit"\n}\n\nDo not include Markdown fences, a preamble, or commentary.`,
    generate: `Create a new document that follows the user's request and uses only information supported by the supplied source.\n\nUser request:\n{user_prompt}\n\nSource document:\n{input_content}\n\nPreserve relevant facts and names, do not invent missing information, and use a clear structure that fits the requested document. Return the document itself without describing these instructions.`,
  },
  vi: {
    image: `Bạn là trợ lý mô tả hình ảnh cho tài liệu SOP (quy trình nội bộ). Mô tả chi tiết hình ảnh này bằng tiếng Việt theo cấu trúc sau:\n\n1. Một câu tóm tắt ngắn về nội dung tổng thể của hình.\n2. Mô tả chi tiết các thành phần chính: tên màn hình/giao diện, các nút bấm, menu, bảng dữ liệu, trường nhập liệu.\n3. Ghi rõ tất cả text/số liệu hiển thị trong hình (tên cột, giá trị, nhãn nút).\n4. Mô tả trạng thái hiện tại và thao tác mà người dùng đang thực hiện hoặc cần thực hiện.\n\nNếu hình trắng hoặc không có nội dung rõ ràng, chỉ ghi: \"[Hình không có nội dung]\".`,
    pdf: `Transform tài liệu này sang Markdown tiếng Việt. Giữ nguyên cấu trúc heading, bảng, danh sách. Mô tả chi tiết mọi hình ảnh trong tài liệu, bao gồm text trong hình nếu có.`,
    docx: `Transform tài liệu Word này sang Markdown tiếng Việt. Giữ nguyên cấu trúc heading, bảng, danh sách. Ưu tiên sử dụng bảng GFM cho các bảng biểu. \nĐối với mỗi hình ảnh, hãy chèn placeholder: ![Image placeholder]()`,
    compare: `Bạn là trợ lý so sánh tài liệu chính xác. Hãy so sánh tài liệu gốc ở FILE 1 với tài liệu đã sửa ở FILE 2.\n\nFILE 1 (bản gốc):\n{file1}\n\nFILE 2 (bản đã sửa):\n{file2}\n\nChỉ liệt kê những nội dung thay đổi thực chất: thêm mới, xóa bỏ hoặc chỉnh sửa. Giữ nguyên văn đoạn thay đổi khi có thể, xác định điều/khoản hoặc tiêu đề liên quan và mô tả ngắn gọn điểm khác biệt. Không suy diễn thay đổi từ văn bản bị thiếu hoặc không rõ ràng.\n\nChỉ trả về một JSON array hợp lệ. Mỗi phần tử có cấu trúc:\n{\n  "clause": "tên điều/khoản hoặc tiêu đề",\n  "file1Content": "nguyên văn nội dung ở bản gốc, hoặc chuỗi rỗng nếu không có",\n  "file2Content": "nguyên văn nội dung ở bản sửa đổi, hoặc chuỗi rỗng nếu không có",\n  "note": "mô tả ngắn gọn nội dung được thêm, xóa hoặc sửa"\n}\n\nKhông thêm Markdown fence, lời dẫn hoặc giải thích bên ngoài JSON.`,
    generate: `Hãy tạo tài liệu mới theo yêu cầu của người dùng và chỉ sử dụng thông tin có căn cứ trong nội dung nguồn được cung cấp.\n\nYêu cầu của người dùng:\n{user_prompt}\n\nTài liệu nguồn:\n{input_content}\n\nGiữ chính xác dữ kiện và tên riêng có liên quan, không tự tạo thông tin còn thiếu, và trình bày theo cấu trúc phù hợp với yêu cầu. Chỉ trả về nội dung tài liệu, không mô tả lại các hướng dẫn này.`,
  },
};

export const DEFAULT_TENANT_PROMPTS: TenantPromptDefaults = {
  image: TENANT_PROMPT_PRESETS.en.image!,
  pdf: TENANT_PROMPT_PRESETS.en.pdf!,
  docx: TENANT_PROMPT_PRESETS.en.docx!,
  compare: `Bạn là chuyên gia phân tích văn bản pháp lý. Nhiệm vụ của bạn là so sánh hai phiên bản của cùng một văn bản quy định/pháp lý.\n\nVăn bản được cấu trúc theo các điều, khoản (Điều 1, Điều 2, Khoản 1.1...).\n\n**FILE 1 (phiên bản cũ/gốc):**\n{file1}\n\n**FILE 2 (phiên bản mới/sửa đổi):**\n{file2}\n\n**Yêu cầu:**\nSo sánh từng điều/khoản giữa hai file. Chỉ liệt kê những điều/khoản CÓ SỰ THAY ĐỔI (thêm mới, xóa bỏ, chỉnh sửa nội dung). Bỏ qua các điều/khoản giống nhau hoàn toàn.\n\n**Định dạng output — trả về JSON array, mỗi phần tử có cấu trúc:**\n{\n  \"clause\": \"Tên điều/khoản (vd: Điều 3, Khoản 2.1, Phần IV)\",\n  \"file1Content\": \"Nội dung nguyên văn trong file 1 (để trống nếu điều/khoản này không có trong file 1)\",\n  \"file2Content\": \"Nội dung nguyên văn trong file 2 (để trống nếu điều/khoản này không có trong file 2)\",\n  \"note\": \"Mô tả ngắn gọn sự khác biệt: Thêm mới / Đã xóa / Sửa đổi [tóm tắt thay đổi]\"\n}\n\nChỉ trả về JSON array hợp lệ, không có markdown code fence hay giải thích thêm.`,
  generate: `Dựa trên nội dung tài liệu được cung cấp, hãy tạo ra tài liệu mới theo yêu cầu sau:\n\n{user_prompt}\n\nNội dung tài liệu gốc:\n{input_content}\n\nHãy tạo ra tài liệu mới với định dạng rõ ràng, cấu trúc logic, đầy đủ thông tin cần thiết.`,
};

export function completePromptPreset(locale: 'en' | 'vi'): TenantPromptDefaults {
  const preset = TENANT_PROMPT_PRESETS[locale];
  return {
    image: preset.image ?? DEFAULT_TENANT_PROMPTS.image,
    pdf: preset.pdf ?? DEFAULT_TENANT_PROMPTS.pdf,
    docx: preset.docx ?? DEFAULT_TENANT_PROMPTS.docx,
    compare: preset.compare ?? DEFAULT_TENANT_PROMPTS.compare,
    generate: preset.generate ?? DEFAULT_TENANT_PROMPTS.generate,
  };
}
