"""Generate editable draw.io and standalone SVG architecture diagrams.

Run from any directory: python du-rework/architecture/diagrams/generate.py
The diagrams are source-driven documentation, not a deployment inventory.
"""

from __future__ import annotations

from dataclasses import dataclass
from html import escape
from pathlib import Path
import xml.etree.ElementTree as ET


OUT = Path(__file__).resolve().parent


@dataclass(frozen=True)
class Node:
    key: str
    x: int
    y: int
    w: int
    h: int
    title: str
    lines: tuple[str, ...]
    fill: str
    stroke: str


@dataclass(frozen=True)
class Edge:
    source: str
    target: str
    label: str
    points: tuple[tuple[int, int], ...]
    dashed: bool = False


def make_svg(name: str, title: str, subtitle: str, width: int, height: int,
             nodes: tuple[Node, ...], edges: tuple[Edge, ...], footer: str) -> None:
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">',
        f'<title id="title">{escape(title)}</title>',
        f'<desc id="desc">{escape(subtitle)} {escape(footer)}</desc>',
        '<defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M1,1 L8,4.5 L1,8" fill="none" stroke="#64748b" stroke-width="1.7"/></marker></defs>',
        f'<rect width="{width}" height="{height}" fill="#f8fafc"/>',
        f'<text x="48" y="52" font-family="Arial,sans-serif" font-size="29" font-weight="700" fill="#0f172a">{escape(title)}</text>',
        f'<text x="48" y="79" font-family="Arial,sans-serif" font-size="15" fill="#475569">{escape(subtitle)}</text>',
    ]
    for edge in edges:
        points = ' '.join(f'{x},{y}' for x, y in edge.points)
        dash = ' stroke-dasharray="7 6"' if edge.dashed else ''
        parts.append(f'<polyline points="{points}" fill="none" stroke="#64748b" stroke-width="2.2" marker-end="url(#arrow)"{dash}/>')
        # Keep detailed edge labels in the editable draw.io source. Static SVG
        # uses arrows only so crossings never obscure the component names.
    for node in nodes:
        parts.append(f'<rect x="{node.x}" y="{node.y}" width="{node.w}" height="{node.h}" rx="16" fill="{node.fill}" stroke="{node.stroke}" stroke-width="2"/>')
        parts.append(f'<text x="{node.x+18}" y="{node.y+30}" font-family="Arial,sans-serif" font-size="18" font-weight="700" fill="#0f172a">{escape(node.title)}</text>')
        for i, line in enumerate(node.lines):
            parts.append(f'<text x="{node.x+18}" y="{node.y+55+i*20}" font-family="Arial,sans-serif" font-size="14" fill="#334155">{escape(line)}</text>')
    parts.append(f'<text x="48" y="{height-28}" font-family="Arial,sans-serif" font-size="13" fill="#64748b">{escape(footer)}</text>')
    parts.append('</svg>')
    (OUT / f'{name}.svg').write_text('\n'.join(parts) + '\n', encoding='utf-8')


def make_drawio(name: str, title: str, width: int, height: int,
                nodes: tuple[Node, ...], edges: tuple[Edge, ...]) -> None:
    mxfile = ET.Element('mxfile', {'host': 'app.diagrams.net', 'modified': '2026-10-02T00:00:00.000Z', 'agent': 'DUGate architecture docs', 'version': '24.7.17'})
    diagram = ET.SubElement(mxfile, 'diagram', {'id': name, 'name': title})
    model = ET.SubElement(diagram, 'mxGraphModel', {'dx': str(width), 'dy': str(height), 'grid': '1', 'gridSize': '10', 'page': '1', 'pageScale': '1', 'pageWidth': str(width), 'pageHeight': str(height)})
    root = ET.SubElement(model, 'root')
    ET.SubElement(root, 'mxCell', {'id': '0'})
    ET.SubElement(root, 'mxCell', {'id': '1', 'parent': '0'})
    for node in nodes:
        value = '<b>' + escape(node.title) + '</b>' + ''.join('<br>' + escape(line) for line in node.lines)
        cell = ET.SubElement(root, 'mxCell', {
            'id': node.key, 'value': value,
            'style': f'rounded=1;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacingTop=10;spacingLeft=12;fontSize=14;fillColor={node.fill};strokeColor={node.stroke};fontColor=#0f172a;',
            'vertex': '1', 'parent': '1',
        })
        ET.SubElement(cell, 'mxGeometry', {'x': str(node.x), 'y': str(node.y), 'width': str(node.w), 'height': str(node.h), 'as': 'geometry'})
    for i, edge in enumerate(edges):
        style = 'edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#64748b;fontColor=#475569;'
        if edge.dashed:
            style += 'dashed=1;'
        cell = ET.SubElement(root, 'mxCell', {'id': f'e{i}', 'value': edge.label, 'style': style, 'edge': '1', 'parent': '1', 'source': edge.source, 'target': edge.target})
        ET.SubElement(cell, 'mxGeometry', {'relative': '1', 'as': 'geometry'})
    ET.indent(mxfile, space='  ')
    ET.ElementTree(mxfile).write(OUT / f'{name}.drawio', encoding='utf-8', xml_declaration=True)


system_nodes = (
    Node('client', 50, 115, 240, 105, 'API client', ('x-api-key, submit / poll', 'download / callback'), '#dbeafe', '#3b82f6'),
    Node('admin', 50, 285, 240, 105, 'Admin operator', ('session / bearer, RBAC', 'registry, profile, audit'), '#e0e7ff', '#6366f1'),
    Node('orchestrator', 360, 145, 335, 260, 'Orchestrator', ('Public + Admin + Runtime API', 'operation / task / lease', 'artifact metadata + grants', 'outbox / usage / webhook'), '#ccfbf1', '#0f766e'),
    Node('platform_db', 790, 115, 275, 105, 'Platform PostgreSQL', ('operations, tasks, outbox', 'metadata, audit, usage'), '#fef3c7', '#d97706'),
    Node('redis', 790, 275, 275, 105, 'Redis / BullMQ', ('delivery queue, sessions', 'shared quota'), '#fee2e2', '#dc2626'),
    Node('storage', 1130, 115, 260, 105, 'S3 / artifact store', ('versioned bytes, multipart', 'optional backend in code'), '#ede9fe', '#7c3aed'),
    Node('workers', 360, 505, 335, 175, 'Business workers', ('document-core · example-review', 'lc-checker', 'Worker SDK + document-kit'), '#dcfce7', '#16a34a'),
    Node('connector', 790, 505, 275, 175, 'Connector', ('grant + revision + quota', 'provider HTTP adapters', 'invocation + usage ledger'), '#ffedd5', '#ea580c'),
    Node('provider', 1130, 505, 260, 105, 'External providers', ('OCR · vision · LLM', 'JSON / multipart HTTP'), '#fce7f3', '#db2777'),
    Node('connector_db', 1130, 660, 260, 90, 'Connector PostgreSQL', ('revision, invocation, outbox',), '#fef3c7', '#d97706'),
)
system_edges = (
    Edge('client', 'orchestrator', 'public API', ((290, 168), (360, 168))),
    Edge('admin', 'orchestrator', 'admin API', ((290, 338), (360, 338))),
    Edge('orchestrator', 'platform_db', 'state', ((695, 195), (790, 195))),
    Edge('orchestrator', 'redis', 'outbox', ((695, 325), (790, 325))),
    Edge('orchestrator', 'storage', 'artifact', ((695, 236), (740, 236), (740, 85), (1260, 85), (1260, 115))),
    Edge('redis', 'workers', 'delivery', ((790, 360), (745, 360), (745, 570), (695, 570))),
    Edge('workers', 'orchestrator', 'runtime reports', ((510, 505), (510, 405))),
    Edge('workers', 'connector', 'invocation', ((695, 610), (790, 610))),
    Edge('connector', 'provider', 'bounded fetch', ((1065, 565), (1130, 565))),
    Edge('connector', 'connector_db', 'ledger', ((930, 680), (930, 705), (1130, 705))),
    Edge('connector', 'orchestrator', 'usage sink', ((790, 520), (745, 520), (745, 395), (695, 395)), True),
)

deployment_nodes = (
    Node('client', 45, 135, 225, 95, 'Client / operator', ('HTTPS, external trust zone',), '#dbeafe', '#3b82f6'),
    Node('ingress', 325, 135, 225, 95, 'Private ingress', ('TLS, routing, policy',), '#e0e7ff', '#6366f1'),
    Node('orchestrator', 615, 105, 315, 145, 'Orchestrator containers', ('Public + Admin + Runtime', 'separate platform secrets'), '#ccfbf1', '#0f766e'),
    Node('connector', 1010, 105, 325, 145, 'Connector containers', ('private endpoint only', 'service identity + grants'), '#ffedd5', '#ea580c'),
    Node('workers', 615, 345, 315, 145, 'Worker host group', ('one image / queue / version', 'per business, no DB creds'), '#dcfce7', '#16a34a'),
    Node('platform_db', 155, 365, 315, 120, 'Platform PostgreSQL', ('own DB/role + migration owner', 'backup / restore'), '#fef3c7', '#d97706'),
    Node('redis', 155, 570, 315, 120, 'Redis / Valkey', ('BullMQ, sessions, quota', 'private network'), '#fee2e2', '#dc2626'),
    Node('s3', 1010, 345, 325, 145, 'Private versioned S3', ('artifact bytes, multipart', 'IAM + encryption policy'), '#ede9fe', '#7c3aed'),
    Node('connector_db', 1010, 570, 325, 120, 'Connector PostgreSQL', ('separate DB/role', 'revision + usage ledger'), '#fef3c7', '#d97706'),
    Node('vault', 615, 570, 315, 120, 'Vault', ('KV v2 / Transit by config', 'credential + key lifecycle'), '#f1f5f9', '#64748b'),
    Node('collector', 325, 780, 300, 95, 'Log collector', ('redacted JSON + disk buffer',), '#f1f5f9', '#64748b'),
    Node('elastic', 785, 780, 300, 95, 'Elasticsearch', ('private TLS, retention',), '#f1f5f9', '#64748b'),
)
deployment_edges = (
    Edge('client', 'ingress', 'HTTPS', ((270, 180), (325, 180))),
    Edge('ingress', 'orchestrator', 'API', ((550, 180), (615, 180))),
    Edge('orchestrator', 'connector', 'private HTTP', ((930, 180), (1010, 180))),
    Edge('orchestrator', 'platform_db', 'SQL', ((615, 205), (520, 205), (520, 420), (470, 420))),
    Edge('orchestrator', 'workers', 'runtime', ((770, 250), (770, 345))),
    Edge('workers', 'redis', 'queues', ((615, 420), (535, 420), (535, 630), (470, 630))),
    Edge('orchestrator', 's3', 'artifact', ((930, 225), (970, 225), (970, 410), (1010, 410))),
    Edge('workers', 's3', 'granted bytes', ((930, 430), (1010, 430))),
    Edge('connector', 'connector_db', 'SQL', ((1170, 250), (1170, 570))),
    Edge('connector', 'vault', 'key / secret', ((1010, 230), (960, 230), (960, 630), (930, 630)), True),
    Edge('orchestrator', 'vault', 'crypto', ((740, 250), (740, 570)), True),
    Edge('orchestrator', 'collector', 'logs', ((665, 250), (580, 250), (580, 780)), True),
    Edge('collector', 'elastic', 'TLS', ((625, 828), (785, 828))),
)


for name, title, subtitle, width, height, nodes, edges, footer in (
    ('system-components', 'DUGate Rework — kiến trúc thành phần', 'Source map · 2 services · 3 business workers · shared packages', 1440, 800, system_nodes, system_edges, 'Mũi tên nét đứt: tích hợp tùy cấu hình · S3 là backend tùy chọn trong code'),
    ('deployment-topology', 'DUGate Rework — topology triển khai', 'Production target · private services and data plane · chưa là deployment đã kiểm chứng', 1400, 920, deployment_nodes, deployment_edges, 'Sơ đồ mục tiêu; infra/docker-compose.yml chỉ là fixture test PostgreSQL/Redis'),
):
    make_svg(name, title, subtitle, width, height, nodes, edges, footer)
    make_drawio(name, title, width, height, nodes, edges)
