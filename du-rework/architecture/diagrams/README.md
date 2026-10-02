# Sơ đồ kiến trúc

| Hình SVG (xem ngay) | Bản draw.io (chỉnh sửa) | Ý nghĩa |
|---|---|---|
| [system-components.svg](system-components.svg) | [system-components.drawio](system-components.drawio) | Ranh giới hai services, ba business workers, database, queue, storage và provider. |
| [deployment-topology.svg](deployment-topology.svg) | [deployment-topology.drawio](deployment-topology.drawio) | Topology production **mục tiêu**; không phải môi trường đã triển khai/kiểm chứng. |

Hai định dạng được tạo từ cùng [generate.py](generate.py): `python du-rework/architecture/diagrams/generate.py`. SVG dùng trong Markdown; draw.io giữ nhãn từng cạnh để chỉnh bố cục/chi tiết. Khi source topology đổi, sửa dữ liệu node/edge trong script rồi tạo lại cả hai định dạng và xem lại hình. Không đưa secret, hostname production hoặc thông tin tenant thật vào sơ đồ.
