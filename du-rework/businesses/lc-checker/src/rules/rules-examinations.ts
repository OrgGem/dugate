import { defineRule, type LcRule, type LcTriggerRule } from './rule-types';

/** Per-document-type checklists, PHẦN 4 of the legacy compliance prompt. */
export const LC_CHECKLIST_RULES: readonly LcRule[] = [
  defineRule('CHK-DRAFT', 'document-checklist', 'ISBP 821 — Hối phiếu', 'Kiểm tra hối phiếu và bill of exchange theo checklist.', [
    'Ký phát cho ngân hàng được nêu trong L/C',
    'Kỳ hạn phù hợp điều khoản L/C',
    'Số tiền bằng số và bằng chữ khớp nhau, mâu thuẫn thì lấy bằng chữ',
    'Số tiền khớp với bộ chứng từ xuất trình',
    'Ngày phát hành',
    'Ký bởi Beneficiary',
    'Ký hậu nếu cần',
    'Loại tiền tệ phù hợp L/C',
    'Sửa chữa nếu có phải được xác thực bởi Beneficiary',
  ]),
  defineRule('CHK-INVOICE', 'document-checklist', 'UCP 600 Art. 18', 'Kiểm tra commercial invoice theo checklist.', [
    'Phát hành bởi Beneficiary',
    'Lập cho Applicant, tên Applicant phải xuất hiện trên Invoice',
    'Loại tiền tệ bằng loại tiền L/C',
    'Số tiền không vượt quá L/C, trừ UCP 600 Art 18(b)',
    'Mô tả hàng hóa tương ứng L/C, không cần giống hệt, không mâu thuẫn',
    'Đơn giá phù hợp L/C nếu L/C nêu',
    'Điều kiện thương mại Incoterms phù hợp L/C',
    'Số lượng trong dung sai cho phép, +/-5% theo UCP 600 Art 30',
    'Không thể hiện hàng hóa hoặc dịch vụ không được yêu cầu trong L/C',
    'Không cần ký trừ khi L/C yêu cầu',
    'Tổng số lượng, trọng lượng không mâu thuẫn với chứng từ khác',
  ]),
  defineRule('CHK-TRANSPORT', 'document-checklist', 'UCP 600 Art. 19, 20, 22, 23', 'Kiểm tra chứng từ vận tải B/L, AWB, MTD theo checklist.', [
    'Thể hiện tên Carrier, nếu Agent phát hành thì tên Agent cộng chức năng',
    'Ký bởi Carrier, Master hoặc Agent đúng tư cách',
    'Shipper phù hợp L/C',
    'Consignee theo yêu cầu L/C',
    'Notify Party không mâu thuẫn L/C',
    'Cảng, địa điểm xuất phát và đến phù hợp L/C',
    'Mô tả hàng hóa: thuật ngữ chung, không mâu thuẫn L/C',
    'Ngày giao hàng trong thời hạn L/C',
    'Ghi chú on board nếu cần: ngày, tên tàu, cảng bốc',
    'Pre-carriage thì bắt buộc ghi chú on board có ngày, tên tàu, cảng bốc',
    'Freight phù hợp Incoterms L/C, không cần giống hệt, không mâu thuẫn',
    'Clean, tức không ghi chú bất lợi về hàng hóa, bao bì theo UCP 600 Art 27',
    'Không chỉ dẫn hợp đồng thuê tàu trừ charter party B/L',
    'Ký hậu nếu là To Order',
    'Số bản gốc',
    'Chuyển tải hoặc giao hàng từng phần theo L/C',
    'Đáp ứng điều khoản đặc biệt L/C liên quan vận tải',
  ]),
  defineRule('CHK-INSURANCE', 'document-checklist', 'UCP 600 Art. 28', 'Kiểm tra chứng từ bảo hiểm theo checklist.', [
    'Phát hành và ký bởi công ty bảo hiểm, người bảo hiểm hoặc đại lý',
    'Người được bảo hiểm phù hợp L/C',
    'Loại bảo hiểm theo L/C như Institute Cargo Clauses',
    'Giá trị bảo hiểm không nhỏ hơn 110% CIF hoặc CIP, trừ khi L/C quy định khác',
    'Cùng loại tiền tệ với L/C',
    'Ngày hiệu lực không muộn hơn ngày giao hàng',
    'Rủi ro được bảo hiểm phù hợp L/C',
    'Bao phủ toàn bộ hành trình, từ nơi nhận đến nơi đến cuối cùng',
    'Ký hậu nếu yêu cầu',
    'Cover note KHÔNG được chấp nhận theo UCP 600 Art 28(c)',
  ]),
  defineRule('CHK-CO', 'document-checklist', 'ISBP 821 — C/O', 'Kiểm tra certificate of origin theo checklist.', [
    'Phát hành bởi tổ chức được L/C nêu, hoặc Chamber of Commerce nếu L/C im lặng',
    'Xuất xứ hàng hóa phù hợp L/C',
    'Mô tả hàng hóa: thuật ngữ chung, không mâu thuẫn L/C',
    'Consignee không mâu thuẫn, áp dụng quy tắc phân cấp Consignee PROC-3.9',
    'Ký và đóng dấu',
    'Form đúng mẫu nếu L/C yêu cầu form cụ thể',
  ]),
  defineRule('CHK-PACKING-LIST', 'document-checklist', 'ISBP 821 — Packing List', 'Kiểm tra packing list theo checklist.', [
    'Phát hành bởi tổ chức L/C nêu, hoặc bất kỳ nếu L/C im lặng',
    'Tổng số lượng, trọng lượng, kiện hàng không mâu thuẫn L/C và chứng từ khác',
    'Dữ liệu chi tiết như số container, seal, trọng lượng từng mục nhất quán với chứng từ vận tải',
  ]),
  defineRule('CHK-OTHER-CERT', 'document-checklist', null, 'Kiểm tra các chứng từ chứng nhận khác theo checklist.', [
    'Phát hành bởi tổ chức L/C yêu cầu',
    'Nội dung xác nhận phù hợp chức năng chứng từ',
    'Mô tả hàng hóa nhất quán',
    'Ký và đóng dấu nếu yêu cầu',
    'Đáp ứng điều khoản đặc biệt L/C',
  ]),
];

/** The enforcement mechanism and the self-check gate, PHẦN 7 of the legacy prompt. */
export const LC_ENFORCEMENT_RULES: readonly LcRule[] = [
  defineRule(
    'EM-1',
    'enforcement',
    null,
    'SCRATCHPAD BẮT BUỘC, ghi vào examination_log. GĐ1 thu thập sự thật gồm extracted_data và intermediate_findings như bl_has_pre_carriage, consignee_is_to_order. GĐ2 kiểm tra từng chứng từ theo CHECKLIST tương ứng, ghi kết quả từng checkbox. GĐ3 kiểm tra chéo giữa các chứng từ về mô tả, container, seal, số lượng, trọng lượng, các bên, cảng, số L/C. GĐ4 kiểm tra thời hạn gồm ngày giao hàng, late presentation, L/C expired. GĐ5 kiểm tra điều khoản đặc biệt L/C như 46A, 47A, 47B hoặc tương đương. GĐ6 kiểm tra danh sách loại trừ EX-1 đến EX-7. GĐ7 kiểm tra kép gồm chiều xuôi và chiều ngược.'
  ),
  defineRule(
    'EM-2',
    'enforcement',
    null,
    'BẢNG KÍCH HOẠT QUY TẮC THEO ĐIỀU KIỆN: sau GĐ1, BẮT BUỘC quét bảng trigger. Nếu điều kiện TRUE thì thực thi hành động bắt buộc tương ứng.'
  ),
  defineRule(
    'EM-3',
    'enforcement',
    null,
    'TỰ KIỂM TRA SAU CÙNG trước khi xuất kết quả, phải trả lời ba câu hỏi. Q1: đã kiểm tra TẤT CẢ checkbox trong CHECKLIST cho mỗi chứng từ được xuất trình chưa. Q2: đã quét TẤT CẢ dòng trong bảng trigger chưa. Q3: đã kiểm tra TẤT CẢ điều khoản đặc biệt trong L/C chưa. CHỈ KHI cả ba đều là RỒI thì được phép xuất kết quả.'
  ),
];

/** Conditional triggers, the EM-2 table of the legacy prompt. */
export const LC_TRIGGER_RULES: readonly LcTriggerRule[] = [
  { id: 'TR-1', condition: 'consignee_is_to_order == true', action: 'Kiểm tra ký hậu shipper trên B/L' },
  { id: 'TR-2', condition: 'bl_has_pre_carriage == true', action: 'Ghi chú on board phải có ngày, tên tàu, cảng bốc' },
  { id: 'TR-3', condition: 'lc_requires_insurance == true', action: 'Kiểm tra toàn bộ checklist Insurance' },
  { id: 'TR-4', condition: 'transport_type == "multimodal"', action: 'Áp dụng UCP 600 Art 19, không phải Art 20' },
  { id: 'TR-5', condition: 'lc_allows_partial_shipment == false', action: 'Kiểm tra tất cả B/L cùng tàu, hành trình, đích đến' },
  { id: 'TR-6', condition: 'incoterms_includes_insurance == true (CIF/CIP)', action: 'Kiểm tra bảo hiểm không nhỏ hơn 110% giá trị' },
  { id: 'TR-7', condition: 'bl_is_charter_party == true', action: 'Áp dụng UCP 600 Art 22 thay vì Art 20' },
  { id: 'TR-8', condition: 'lc_has_special_conditions == true', action: 'Kiểm tra TỪNG điều khoản đặc biệt' },
  { id: 'TR-9', condition: 'issuing_bank == "VPBKVNVX"', action: 'Áp dụng quy tắc đặc thù VPBank PROC-3.4' },
  { id: 'TR-10', condition: 'presentation_date == "undetermined"', action: 'Thực hiện kiểm tra thay thế PROC-3.1.5' },
  { id: 'TR-11', condition: 'lc_expired == true', action: 'BẮT BUỘC ghi nhận Late presentation theo PROC-3.1.6' },
  { id: 'TR-12', condition: 'draft_required == true', action: 'Kiểm tra toàn bộ checklist Draft' },
  { id: 'TR-13', condition: 'co_required == true', action: 'Kiểm tra toàn bộ checklist C/O' },
  { id: 'TR-14', condition: 'lc_requires_endorsement == true', action: 'Quét ký hậu theo quy tắc PROC-3.8' },
  { id: 'TR-15', condition: 'documents_have_corrections == true', action: 'Kiểm tra xác thực sửa chữa theo ISBP' },
];

/** Severity bands and the verdict/recommendation logic, PHẦN 8 of the legacy prompt. */
export const LC_SEVERITY_RULES: readonly LcRule[] = [
  defineRule(
    'SEV-MAJOR',
    'severity',
    'UCP 600 Art. 16',
    'MAJOR: phải gây từ chối theo UCP 600 Art. 16, ví dụ B/L không clean, xung đột giá trị, thiếu chứng từ bắt buộc, giao hàng muộn, L/C hết hạn, sai consignee.'
  ),
  defineRule(
    'SEV-MINOR',
    'severity',
    null,
    'MINOR: vấn đề hình thức, có thể chấp nhận tùy quyết định của người kiểm tra, ví dụ khác biệt chữ trong từ ngữ nhỏ, thông tin đại lý chưa hoàn chỉnh.'
  ),
  defineRule(
    'SEV-ADVISORY',
    'severity',
    null,
    'ADVISORY: quan sát, thiếu yếu tố tuỳ chọn, hoặc dữ liệu OCR không chắc chắn cần người có chuyên môn xác nhận; không tự động từ chối.'
  ),
  defineRule('VERDICT-COMPLIANT', 'severity', null, 'verdict COMPLIANT: không có MAJOR và không có MINOR nào.'),
  defineRule('VERDICT-DISCREPANT', 'severity', null, 'verdict DISCREPANT: có ít nhất một MAJOR hoặc MINOR.'),
  defineRule(
    'VERDICT-PENDING',
    'severity',
    null,
    'verdict PENDING: dữ liệu không đủ để kết luận, ví dụ thiếu hẳn một chứng từ then chốt, hoặc bất định OCR quan trọng.'
  ),
  defineRule('RECO-ACCEPT', 'severity', null, 'recommendation ACCEPT: COMPLIANT, tất cả kiểm tra đạt.'),
  defineRule('RECO-REJECT', 'severity', null, 'recommendation REJECT: có một hoặc nhiều MAJOR.'),
  defineRule('RECO-RESERVE', 'severity', null, 'recommendation RESERVE_FOR_REVIEW: chỉ MINOR, hoặc MINOR trộn với ADVISORY.'),
];
