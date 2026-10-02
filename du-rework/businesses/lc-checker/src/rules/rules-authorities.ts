import { defineRule, type LcRule } from './rule-types';

/**
 * The published authorities: UCP 600 articles (PHẦN 5) and ISBP 821 paragraphs
 * (PHẦN 6) of the legacy compliance prompt.
 */
export const LC_AUTHORITY_RULES: readonly LcRule[] = [
  defineRule(
    'UCP600-ART-3',
    'ucp600',
    'UCP 600 Art. 3',
    'GIẢI THÍCH: "Vào hoặc vào khoảng" là 5 ngày trước đến 5 ngày sau, bao gồm cả hai đầu. "Đến", "cho đến", "từ", "giữa" gồm ngày được đề cập. "Trước", "sau" loại trừ ngày được đề cập. "Nửa đầu tháng" là 1-15; "Nửa cuối tháng" là 16-cuối tháng. "Đầu tháng" là 1-10; "Giữa tháng" là 11-20; "Cuối tháng" là 21-cuối tháng. Chữ ký bao gồm chữ ký tay, fax, đục lỗ, con dấu, ký hiệu, xác thực cơ học hoặc điện tử.'
  ),
  defineRule(
    'UCP600-ART-14',
    'ucp600',
    'UCP 600 Art. 14',
    'TIÊU CHUẨN KIỂM TRA: (a) kiểm tra dựa trên bề mặt chứng từ. (c) xuất trình không muộn hơn 21 ngày sau ngày giao hàng, không muộn hơn ngày hết hạn. (d) dữ liệu không cần giống hệt nhưng không được mâu thuẫn giữa các chứng từ và L/C. (e) chứng từ ngoài Invoice: mô tả chung, không mâu thuẫn L/C. (f) chứng từ không yêu cầu trong L/C nhưng được xuất trình thì bỏ qua. (j) địa chỉ Beneficiary và Applicant không cần giống hệt L/C, phải cùng quốc gia. (k) Shipper hoặc Consignor không nhất thiết là Beneficiary.'
  ),
  defineRule(
    'UCP600-ART-17',
    'ucp600',
    'UCP 600 Art. 17',
    'BẢN GỐC VÀ BẢN SAO: ít nhất 1 bản gốc mỗi chứng từ. Chữ ký, dấu hiệu, con dấu, nhãn gốc rõ ràng hoặc trên giấy tiêu đề gốc.'
  ),
  defineRule(
    'UCP600-ART-18',
    'ucp600',
    'UCP 600 Art. 18',
    'HÓA ĐƠN THƯƠNG MẠI: (a) do Beneficiary phát hành, lập cho Applicant, cùng loại tiền tệ L/C, không cần ký. (b) ngân hàng có thể chấp nhận Invoice vượt quá số tiền L/C. (c) mô tả hàng hóa phải tương ứng L/C.'
  ),
  defineRule(
    'UCP600-ART-19',
    'ucp600',
    'UCP 600 Art. 19',
    'VẬN TẢI ĐA PHƯƠNG THỨC: (a) nêu tên carrier, ký đúng, chỉ rõ hàng đã gửi, nhận hoặc xếp tàu, nêu nơi gửi và nơi đến, bản gốc đầy đủ, có điều khoản vận chuyển, không chỉ dẫn hợp đồng thuê tàu. (b-c) chuyển tải được chấp nhận ngay cả khi L/C cấm.'
  ),
  defineRule(
    'UCP600-ART-20',
    'ucp600',
    'UCP 600 Art. 20',
    'VẬN ĐƠN ĐƯỜNG BIỂN: (a) nêu tên carrier, ký đúng, chỉ rõ hàng đã xếp tàu tại cảng bốc L/C, nêu vận chuyển từ cảng bốc đến cảng dỡ L/C, bản gốc đầy đủ, không chỉ dẫn hợp đồng thuê tàu. (b-d) chuyển tải: chấp nhận nếu hàng trong container, ngay cả khi L/C cấm.'
  ),
  defineRule(
    'UCP600-ART-22',
    'ucp600',
    'UCP 600 Art. 22',
    'VẬN ĐƠN THUÊ TÀU: (a) ký bởi master, owner, charterer hoặc agent, chỉ rõ hàng đã xếp tàu, nêu cảng bốc và cảng dỡ, bản gốc đầy đủ.'
  ),
  defineRule(
    'UCP600-ART-23',
    'ucp600',
    'UCP 600 Art. 23',
    'VẬN TẢI HÀNG KHÔNG: (a) nêu tên carrier, ký đúng, chỉ rõ hàng đã chấp nhận vận chuyển, ngày phát hành bằng ngày gửi hàng trừ khi có ghi chú ngày gửi thực tế, nêu sân bay khởi hành và đến.'
  ),
  defineRule(
    'UCP600-ART-26',
    'ucp600',
    'UCP 600 Art. 26',
    'XẾP TRÊN BOONG: không được chỉ ra hàng được hoặc sẽ xếp trên boong. "Có thể xếp trên boong" thì chấp nhận. "Shipper\'s load and count" và "said to contain" thì chấp nhận.'
  ),
  defineRule(
    'UCP600-ART-27',
    'ucp600',
    'UCP 600 Art. 27',
    'CHỨNG TỪ VẬN TẢI SẠCH (CLEAN): không có điều khoản hoặc ghi chú tuyên bố rõ ràng tình trạng khiếm khuyết hàng hóa, bao bì. Từ "clean" không cần xuất hiện.'
  ),
  defineRule(
    'UCP600-ART-28',
    'ucp600',
    'UCP 600 Art. 28',
    'BẢO HIỂM: (a-b) do công ty bảo hiểm, người bảo hiểm hoặc đại lý phát hành và ký. (c) cover note KHÔNG được chấp nhận. (e) ngày không muộn hơn ngày gửi hàng, trừ khi có ngày hiệu lực sớm hơn. (f) số tiền bảo hiểm cùng tiền tệ L/C, tối thiểu 110% CIF hoặc CIP nếu L/C im lặng.'
  ),
  defineRule(
    'UCP600-ART-29',
    'ucp600',
    'UCP 600 Art. 29',
    'GIA HẠN: ngày hết hạn rơi vào ngày ngân hàng đóng cửa thì gia hạn đến ngày làm việc tiếp theo. Ngày cuối cùng gửi hàng KHÔNG được gia hạn.'
  ),
  defineRule(
    'UCP600-ART-30',
    'ucp600',
    'UCP 600 Art. 30',
    'DUNG SAI: (a) "Khoảng" hoặc "xấp xỉ" thì dung sai +/-10%. (b) dung sai +/-5% số lượng, không áp dụng nếu tính theo đơn vị bao, kiện, chiếc, tổng tiền không vượt L/C. (c) dung sai -5% số tiền L/C dù không cho phép giao từng phần, nếu giao đủ số lượng và đơn giá không giảm.'
  ),
  defineRule(
    'UCP600-ART-31',
    'ucp600',
    'UCP 600 Art. 31',
    'GIAO HÀNG TỪNG PHẦN: cho phép trừ khi L/C cấm. Nhiều bộ chứng từ vận tải cùng phương tiện, cùng hành trình, cùng đích đến thì KHÔNG phải giao từng phần.'
  ),
  defineRule(
    'UCP600-ART-32',
    'ucp600',
    'UCP 600 Art. 32',
    'GIAO HÀNG THEO ĐỢT: bất kỳ đợt nào không thực hiện trong thời gian cho phép thì L/C hết hiệu lực cho đợt đó và các đợt tiếp theo.'
  ),

  defineRule('ISBP-GENERAL', 'isbp821', 'ISBP 821 — Nguyên tắc chung', 'NGUYÊN TẮC CHUNG.', [
    'Viết tắt thông dụng được chấp nhận: "Int\'l" là "International", "Co." là "Company", "kgs" là "kilograms"',
    'Chữ ký không nhất thiết viết tay. Chấp nhận fax, đục lỗ, con dấu. "Signed and stamped" là chữ ký cộng tên tổ chức',
    'Lỗi chính tả hoặc đánh máy không ảnh hưởng ý nghĩa thì không làm chứng từ không phù hợp',
    'Sửa chữa: chứng từ do Beneficiary phát hành thì sửa chữa không cần xác thực; chứng từ không do Beneficiary phát hành thì sửa chữa phải được người phát hành xác thực',
  ]),
  defineRule('ISBP-DRAFT', 'isbp821', 'ISBP 821 — Hối phiếu', 'HỐI PHIẾU.', [
    'Ký phát cho ngân hàng được nêu trong L/C. Kỳ hạn phù hợp L/C',
    'Số tiền bằng chữ và bằng số mâu thuẫn thì lấy bằng chữ',
    'Ký bởi Beneficiary, ghi ngày phát hành',
  ]),
  defineRule('ISBP-INVOICE', 'isbp821', 'ISBP 821 — Hóa đơn', 'HÓA ĐƠN.', [
    '"Invoice" không mô tả thêm thì bất kỳ loại hóa đơn nào, trừ "provisional" hoặc "pro-forma"',
    '"$" không có thông tin thêm khi L/C bằng USD thì chấp nhận',
    'Điều kiện thương mại là phần mô tả hàng hóa nên Invoice phải chỉ ra',
  ]),
  defineRule('ISBP-BL', 'isbp821', 'ISBP 821 — Vận đơn đường biển', 'VẬN ĐƠN ĐƯỜNG BIỂN.', [
    'B/L in sẵn "Shipped on board": ngày phát hành bằng ngày giao hàng, TRỪ KHI có ghi chú on board riêng',
    'Có pre-carriage, tức place of receipt khác port of loading: BẮT BUỘC ghi chú on board có ngày, tên tàu, cảng bốc',
    '"To order" hoặc "to order of shipper" thì phải ký hậu bởi shipper',
    '"Shipped in apparent good order", "Laden on board", "Clean on board" đều là "Shipped on board"',
    'Cước phí: "freight payable at destination" là "freight collect". Chi phí lưu kho, lưu container KHÔNG phải chi phí bổ sung ngoài cước phí',
  ]),
  defineRule('ISBP-INSURANCE', 'isbp821', 'ISBP 821 — Bảo hiểm', 'BẢO HIỂM.', [
    'Đại lý ký: không cần nêu tên đại lý, nhưng phải nêu tên công ty bảo hiểm',
    'Ngày phát hành sau ngày giao hàng thì BẮT BUỘC có ghi chú effective date không muộn hơn ngày giao hàng',
    '"Warehouse to warehouse" cộng ngày phát hành sau ngày giao hàng thì KHÔNG đủ, vẫn cần ghi chú effective date',
    'Miễn thường, khấu trừ: chấp nhận, trừ khi L/C yêu cầu "irrespective of percentage"',
    'Institute Cargo Clauses (A) hoặc (Air) là đáp ứng "all risks"',
  ]),
  defineRule('ISBP-CO', 'isbp821', 'ISBP 821 — C/O', 'CERTIFICATE OF ORIGIN.', [
    'L/C yêu cầu do Beneficiary, exporter hoặc manufacturer thì Chamber of Commerce cũng chấp nhận',
    'Consignee: nếu B/L "to order" hoặc "to order of issuing bank" thì C/O có thể hiển thị bất kỳ bên nào trong L/C, trừ Beneficiary',
    'Shipper hoặc exporter có thể khác Beneficiary',
  ]),
  defineRule('ISBP-PACKING-LIST', 'isbp821', 'ISBP 821 — Packing List', 'PACKING LIST.', [
    'Tổng số lượng, trọng lượng, kiện hàng không mâu thuẫn L/C và chứng từ khác',
    'Dữ liệu chi tiết như số container, seal phải nhất quán với chứng từ vận tải. Mâu thuẫn là discrepancy',
  ]),
];
