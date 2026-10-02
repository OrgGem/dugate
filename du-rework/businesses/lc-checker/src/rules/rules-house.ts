import { defineRule, type LcRule } from './rule-types';

/**
 * House rules — the meta-rules, core system logic, exclusions and the sequential
 * examination procedure. Transcribed from PHẦN 0, PHẦN 1, PHẦN 2 and PHẦN 3 of the
 * legacy compliance prompt.
 */
export const LC_HOUSE_RULES: readonly LcRule[] = [
  defineRule(
    'MR-1',
    'meta',
    null,
    'NGUỒN CHÂN LÝ DUY NHẤT: Toàn bộ quy tắc trong rules base này là nguồn chân lý duy nhất và tuyệt đối. Mọi kiến thức chung hoặc thông lệ khác bị VÔ HIỆU HÓA nếu mâu thuẫn với các quy tắc này.'
  ),
  defineRule(
    'MR-2',
    'meta',
    null,
    'THỨ TỰ ƯU TIÊN GHI ĐÈ: 1. Cấp 1 (Tối cao) các quy tắc trong rules base. 2. Cấp 2 (Cụ thể) các điều khoản trong L/C của giao dịch. 3. Cấp 3 (Thông lệ) bộ Rules Base (UCP 600 / ISBP 821).'
  ),
  defineRule(
    'MR-3',
    'meta',
    null,
    'XỬ LÝ DỮ LIỆU BẤT ĐỊNH (OCR KHÔNG CHẮC CHẮN): KHÔNG đưa ra giả định hoặc suy diễn. Gắn cờ "Bất định" với severity = ADVISORY. Ghi trong discrepancy: "Cảnh báo: Không thể xác định chắc chắn [Tên trường] trên [Tên chứng từ]. Dữ liệu OCR: [Kết quả]. Đề nghị chuyên gia xác nhận."'
  ),
  defineRule(
    'MR-4',
    'meta',
    null,
    'PHÁ VỞ CHUỖI SUY LUẬN: nếu dữ liệu đầu vào quan trọng bị "Không xác định được" thì hủy bỏ quy tắc kiểm tra đó VÀ tất cả quy tắc phụ thuộc, ghi "Cảnh báo: Không thể kiểm tra [Tên lỗi] do [Tên dữ liệu] không xác định được." NGOẠI LỆ: nếu có lỗi "L/C expired" thì BẮT BUỘC ghi nhận "Late presentation".'
  ),

  defineRule(
    'CL-1',
    'core-logic',
    null,
    'NGỮ CẢNH TOÀN CỤC: tạo một đối tượng ngữ cảnh toàn cục gồm extracted_data (toàn bộ dữ liệu đã trích xuất từ tất cả chứng từ), intermediate_findings (các sự thật phát hiện, ví dụ bl_has_pre_carriage, consignee_is_to_order) và discrepancies (các điểm không phù hợp đã xác nhận).'
  ),
  defineRule(
    'CL-2',
    'core-logic',
    null,
    'THỰC THI HAI GIAI ĐOẠN: Giai đoạn 1 thu thập sự thật — quét toàn bộ L/C và chứng từ để CHỈ thu thập dữ liệu và xác định sự thật, TUYỆT ĐỐI KHÔNG bắt lỗi. Giai đoạn 2 đánh giá lỗi — chỉ sau khi giai đoạn 1 hoàn tất mới được đánh giá lỗi dựa trên toàn bộ ngữ cảnh.'
  ),
  defineRule(
    'CL-3',
    'core-logic',
    null,
    'PHỤ THUỘC QUY TẮC: mỗi quy tắc kiểm tra có Điều Kiện Kích Hoạt dựa trên intermediate_findings. NẾU điều kiện được thỏa mãn thì BẮT BUỘC thực thi quy tắc, không được bỏ qua.'
  ),

  defineRule('EX-1', 'exclusion', null, 'KHÔNG dùng ngày trên thư đòi tiền (covering letter) để xác định ngày xuất trình.'),
  defineRule(
    'EX-2',
    'exclusion',
    null,
    'KHÔNG coi lỗi sai số L/C và ngày phát hành L/C là lỗi nếu ngân hàng phát hành là VPBank (SWIFT: VPBKVNVX).'
  ),
  defineRule('EX-3', 'exclusion', null, 'KHÔNG bắt lỗi thiếu số lượng chứng từ dựa trên file scan, vì file scan chỉ có 1 bản mỗi loại.'),
  defineRule('EX-4', 'exclusion', null, 'KHÔNG đếm số lượng chứng từ liệt kê trên thư đòi tiền để bắt lỗi thiếu chứng từ.'),
  defineRule('EX-5', 'exclusion', null, 'KHÔNG liệt kê mục "số lượng chứng từ xuất trình" trong kết quả đầu ra.'),
  defineRule(
    'EX-6',
    'exclusion',
    null,
    'KHÔNG sử dụng dữ liệu từ Đối tượng Dữ liệu của chứng từ khác khi kiểm tra nội dung một chứng từ cụ thể (Quy tắc Cách Ly Dữ Liệu).'
  ),
  defineRule(
    'EX-7',
    'exclusion',
    null,
    'KHÔNG tự động sửa lỗi chính tả hoặc hoàn thiện dữ liệu ngoài các phép chuẩn hóa được định nghĩa rõ ràng.'
  ),

  defineRule(
    'PROC-STEP-1',
    'procedure',
    null,
    'BƯỚC 1 PHÂN TÍCH YÊU CẦU L/C: đọc kỹ tất cả điều khoản, điều kiện trong L/C gốc và các tu chỉnh. Lưu ý định dạng ngày tháng trong điện L/C và tu chỉnh là YYMMDD.'
  ),
  defineRule(
    'PROC-2.1',
    'procedure',
    null,
    'BƯỚC 2.1: trích xuất tất cả dữ liệu quan trọng từ mỗi chứng từ và tạo Đối tượng Dữ liệu riêng cho từng chứng từ.'
  ),
  defineRule(
    'PROC-2.2',
    'procedure',
    null,
    'BƯỚC 2.2 phân loại mâu thuẫn: Loại 1 mâu thuẫn rõ ràng, tất cả giá trị OCR tin cậy cao hơn 98% nhưng khác nhau, thì bắt lỗi. Loại 2 mâu thuẫn bất định, ít nhất một giá trị OCR tin cậy thấp hơn 98%, thì gắn ADVISORY và đề nghị xác nhận.'
  ),
  defineRule(
    'PROC-2.3',
    'procedure',
    null,
    'BƯỚC 2.3: đối chiếu Toàn vẹn Dữ liệu Quan hệ, dùng trường định danh (số container) làm mốc xác minh TẤT CẢ dữ liệu liên quan.'
  ),
  defineRule('PROC-2.4', 'procedure', null, 'BƯỚC 2.4: so sánh thông tin từng chứng từ với yêu cầu L/C.'),
  defineRule(
    'PROC-2.5',
    'procedure',
    null,
    'BƯỚC 2.5 CHUẨN HÓA DỮ LIỆU (Restricted Normalization). CHỈ ĐƯỢC PHÉP: (a) loại bỏ ký tự giữ chỗ, ví dụ "At XXXXXXXXXX sight" thành "At sight"; (b) chuẩn hóa dấu gạch ngang mã định danh, ví dụ "ABCD-123" thành "ABCD123"; (c) loại bỏ khoảng trắng thừa; (d) chuyển đổi chữ hoa thường thống nhất trừ khi L/C yêu cầu đặc biệt. CẤM: suy diễn, sửa lỗi chính tả, tự động hoàn thiện dữ liệu ngoài danh sách trên.'
  ),
  defineRule(
    'PROC-STEP-3',
    'procedure',
    null,
    'BƯỚC 3: mỗi yêu cầu L/C và mỗi quy tắc Rules Base là một hạng mục bảng kiểm bắt buộc. Tất cả so sánh trên dữ liệu đã chuẩn hóa. Xác minh tuần tự, không bỏ qua.'
  ),
  defineRule(
    'PROC-3.1.1',
    'procedure',
    'UCP 600 Art. 14(c)',
    'Xác định Ngày xuất trình: tìm dấu ngày nhận chứng từ của NHXT/NHĐC trên Thư đòi tiền. Không có thì ghi "Không xác định được". KHÔNG suy diễn.'
  ),
  defineRule('PROC-3.1.2', 'procedure', null, 'Ngày lập Thư đòi tiền CHỈ dùng tham khảo. CẤM dùng để tính toán thời hạn.'),
  defineRule('PROC-3.1.3', 'procedure', 'UCP 600 Art. 14(c)', 'Late presentation: xuất trình muộn hơn 21 ngày sau ngày giao hàng, hoặc theo L/C nếu L/C quy định khác.'),
  defineRule('PROC-3.1.4', 'procedure', null, 'L/C expired: so Ngày xuất trình với Ngày hết hạn L/C.'),
  defineRule(
    'PROC-3.1.5',
    'procedure',
    null,
    'Kiểm tra thay thế: nếu Ngày xuất trình là "Không xác định được" và ngày muộn nhất, tính giữa ngày giao hàng và ngày phát hành tất cả chứng từ TRỪ ngày phát hành Thư đòi tiền, lớn hơn Ngày hết hạn L/C, thì ghi nhận "L/C expired" VÀ "Late presentation".'
  ),
  defineRule(
    'PROC-3.1.6',
    'procedure',
    null,
    'Nếu có lỗi "L/C expired" thì BẮT BUỘC ghi nhận "Late presentation" (ngoại lệ của MR-4).'
  ),
  defineRule(
    'PROC-3.2',
    'procedure',
    'UCP 600 Art. 3, Art. 17',
    'QUY TẮC VỀ CHỮ KÝ: chứng từ yêu cầu ký phải có hành động ký riêng biệt (ký tay, đóng dấu, ký hiệu). Tên in sẵn trên letterhead KHÔNG phải chữ ký hợp lệ. Thiếu chữ ký là Lỗi.'
  ),
  defineRule(
    'PROC-3.3',
    'procedure',
    'UCP 600 Art. 14(c), Art. 14(e)',
    'QUY TẮC VỀ MÔ TẢ HÀNG HÓA: Invoice phải tương ứng với L/C, không mâu thuẫn, không cần giống hệt từng từ, phải phản ánh đúng bản chất hàng hóa. Chứng từ khác ngoài Invoice: mô tả chung, không mâu thuẫn với L/C. Chấp nhận thay đổi thứ tự từ nếu không thay đổi bản chất. Kích thước: nếu L/C quy định khoảng, ví dụ 1.5-3.0mm x 120-180mm, chứng từ thể hiện giá trị trong khoảng thì phù hợp.'
  ),
  defineRule(
    'PROC-3.4',
    'procedure',
    null,
    'QUY TẮC ĐẶC THÙ VPBANK: nếu NHPH là VPBank (SWIFT: VPBKVNVX) thì sai số L/C và ngày phát hành L/C trên chứng từ KHÔNG phải lỗi. Nếu NHPH KHÔNG phải VPBank thì sai số L/C và ngày phát hành L/C VẪN là lỗi và phải chỉ ra.'
  ),
  defineRule(
    'PROC-3.5',
    'procedure',
    null,
    'QUY TẮC VỀ THƯ ĐÒI TIỀN: thông tin trên thư đòi tiền CHỈ dùng để xác định bộ chứng từ đòi tiền đúng L/C. Sai khác trên thư đòi tiền so với L/C hoặc chứng từ khác KHÔNG phải lỗi, chỉ ADVISORY. KHÔNG kiểm tra số lượng chứng từ liệt kê trên thư đòi tiền.'
  ),
  defineRule(
    'PROC-3.6',
    'procedure',
    null,
    'QUY TẮC VỀ NGÔN NGỮ VÀ TÊN: L/C bằng tiếng Anh hoặc tiếng Việt không dấu thì chứng từ có thể bằng tiếng Việt có dấu. Tên công ty, tổ chức, ngân hàng: L/C bằng tiếng Anh, chứng từ bằng tiếng Việt có dấu hoặc không dấu trong phần dấu, chữ ký, letterhead thì chấp nhận.'
  ),
  defineRule(
    'PROC-3.7',
    'procedure',
    null,
    'QUY TẮC VỀ NOTIFY PARTY: có thể xuất hiện ở ô Notify Party hoặc chỗ khác trên chứng từ, miễn không mâu thuẫn L/C.'
  ),
  defineRule(
    'PROC-3.8',
    'procedure',
    null,
    'QUY TẮC VỀ KÝ HẬU: quét theo thứ tự ưu tiên (1) toàn bộ mặt sau chứng từ, tức trang liền sau; (2) bất kỳ khu vực ENDORSEMENT.'
  ),
  defineRule(
    'PROC-3.9',
    'procedure',
    null,
    'QUY TẮC PHÂN CẤP CONSIGNEE. Bước A: chứng từ vận tải thuộc dạng "to order", "to the order of shipper", "to order of issuing bank", "to order of nominated bank", "consigned to issuing bank"? Bước B: NẾU CÓ thì Consignee trên chứng từ khác phù hợp nếu là Applicant hoặc bên bất kỳ có tên trong L/C, trừ Beneficiary. NẾU KHÔNG, tức vận đơn đích danh, thì Consignee phải nhất quán trên tất cả.'
  ),
  defineRule(
    'PROC-3.10',
    'procedure',
    'UCP 600 Art. 14(k)',
    'QUY TẮC VỀ SHIPPER: nếu L/C KHÔNG có điều khoản cấm vận đơn bên thứ ba thì Shipper trên vận đơn có thể khác Beneficiary.'
  ),
  defineRule(
    'PROC-3.11',
    'procedure',
    'UCP 600 Art. 30, Art. 31',
    'GIAO HÀNG TỪNG PHẦN: khi L/C cho phép giao hàng từng phần và quy định số lượng cùng dung sai, bộ chứng từ thể hiện số lượng ít hơn tổng, bao gồm cả dung sai, thì phù hợp.'
  ),
  defineRule(
    'PROC-3.12',
    'procedure',
    'UCP 600 Art. 20(a)',
    'CARRIER TRÊN CHỨNG TỪ VẬN TẢI: phải thể hiện tên Carrier. Nếu do Agent phát hành thì phải thể hiện tên Agent và chức năng Agent.'
  ),
  defineRule(
    'PROC-3.13',
    'procedure',
    null,
    'PHÂN RÃ VÀ KIỂM TRA CHI TIẾT: khi yêu cầu L/C gồm nhiều thành phần trong một khối, BẮT BUỘC xác minh TỪNG thành phần riêng lẻ. Thiếu bất kỳ thành phần nào là lỗi.'
  ),
  defineRule(
    'PROC-STEP-4',
    'procedure',
    null,
    'BƯỚC 4 XỬ LÝ THÔNG TIN BẤT ĐỊNH: khi thông tin không rõ ràng, mờ, thì gắn cờ ADVISORY và không giả định. Ký tự dễ nhầm lẫn 0↔O, 1↔I, 5↔S, 8↔B, 6↔G cần tăng cường kiểm tra. Đặc biệt xác minh số container theo ISO 6346 gồm 4 chữ và 7 số, số tiền, ngày tháng.'
  ),
  defineRule(
    'PROC-STEP-5',
    'procedure',
    null,
    'BƯỚC 5 TỔNG HỢP VÀ KIỂM TRA KÉP TRƯỚC KHI OUTPUT. A, kiểm tra xuôi: với mỗi lỗi đã tìm, rà soát lại không vi phạm quy tắc loại trừ nào. B, kiểm tra ngược: với các yêu cầu quan trọng L/C mà kết luận phù hợp, tự kiểm tra lại xem có bỏ qua quy tắc nào không; nếu có thì chuyển thành lỗi.'
  ),
];
