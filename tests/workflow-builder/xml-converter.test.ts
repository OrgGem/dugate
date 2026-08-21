// tests/workflow-builder/xml-converter.test.ts
import { xmlToSchema, schemaToXml } from '../../lib/workflow-builder/xml-converter';
import type { WorkflowSchema } from '../../lib/workflow-builder/types';

describe('xml-converter', () => {
  it('converts a workflow XML to a JSON schema (canonical)', () => {
    const xml = `<?xml version="1.0"?>
<workflow slug="demo" name="Demo">
  <input>
    <property name="limit" type="number" required="true" />
  </input>
  <nodes>
    <node id="a" type="connector" connector="ext-a" />
    <node id="b" type="connector" connector="ext-b">
      <input key="prev" value="$a.content" />
    </node>
  </nodes>
  <flow>
    <step id="a" />
    <step id="b" />
  </flow>
  <output from="b" />
</workflow>`;

    const schema = xmlToSchema(xml);
    expect(schema.slug).toBe('demo');
    expect(schema.name).toBe('Demo');
    expect(schema.input_schema?.properties.limit.type).toBe('number');
    expect(schema.nodes).toHaveLength(2);
    expect(schema.nodes[1].type).toBe('connector');
    expect((schema.nodes[1] as any).inputs).toEqual({ prev: '$a.content' });
    expect(schema.flow).toEqual(['a', 'b']);
    expect(schema.output?.from).toBe('b');
  });

  it('round-trips schema -> xml -> schema', () => {
    const schema: WorkflowSchema = {
      slug: 'rt', name: 'RT', flow: ['a'],
      nodes: [{ id: 'a', type: 'connector', connector: 'ext-x' }],
      output: { from: 'a' },
    };
    const xml = schemaToXml(schema);
    const back = xmlToSchema(xml);
    expect(back.slug).toBe('rt');
    expect(back.nodes).toHaveLength(1);
    expect(back.nodes[0].id).toBe('a');
  });

  it('throws on invalid XML', () => {
    expect(() => xmlToSchema('<workflow><unclosed></workflow>')).toThrow();
  });

  it('handles parallel branches', () => {
    const xml = `<?xml version="1.0"?>
<workflow slug="p" name="P">
  <nodes>
    <node id="pr" type="parallel">
      <branch><node id="A" type="connector" connector="ext-A" /></branch>
      <branch><node id="B" type="connector" connector="ext-B" /></branch>
    </node>
    <node id="j" type="join" />
  </nodes>
  <flow><step id="pr" /><step id="j" /></flow>
</workflow>`;
    const schema = xmlToSchema(xml);
    const pr = schema.nodes.find((n) => n.id === 'pr') as any;
    expect(pr.branches).toHaveLength(2);
    expect(pr.branches[0][0].id).toBe('A');
  });
});
