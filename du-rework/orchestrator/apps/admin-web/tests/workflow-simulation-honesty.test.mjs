import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const screenPath = 'src/features/workflows/workflows-screen.tsx';
const screenSource = await readFile(new URL(`../${screenPath}`, import.meta.url), 'utf8');
const sourceFile = ts.createSourceFile(screenPath, screenSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findSimulationResultPayload() {
  let payload;
  const visit = (node) => {
    if (ts.isIfStatement(node) && node.expression.getText(sourceFile) === "testSource === 'simulation'") {
      const findResultCall = (child) => {
        if (payload || ts.isFunctionLike(child)) return;
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'setTestResult') {
          const argument = child.arguments[0];
          if (argument && ts.isObjectLiteralExpression(argument)) payload = argument.getText(sourceFile);
          return;
        }
        ts.forEachChild(child, findResultCall);
      };
      findResultCall(node.thenStatement);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(payload, 'simulation branch must set a result object');
  return payload;
}

function findSimulationPanelExpression() {
  let expression;
  const visit = (node) => {
    if (expression) return;
    if (ts.isJsxExpression(node) && node.expression && ts.isConditionalExpression(node.expression)) {
      const condition = node.expression.condition.getText(sourceFile);
      if (condition === "testResult.dataSource === 'simulation'") {
        expression = node.expression.getText(sourceFile);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(expression, 'result panel must keep the simulation-specific stage branch');
  return expression;
}

function findWorkflowStageCountExpression() {
  let expression;
  const visit = (node) => {
    if (expression) return;
    if (ts.isJsxExpression(node) && node.expression) {
      const candidate = node.expression.getText(sourceFile);
      if (candidate.startsWith('wf.nodesCount ?? wf.stages?.length ??')) expression = candidate;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(expression, 'workflow row must use an explicit zero fallback for stage count');
  return expression;
}

const simulationPayloadSource = findSimulationResultPayload();
const simulationPanelSource = findSimulationPanelExpression();
const stageCountSource = findWorkflowStageCountExpression();

function createSimulationResult(stages) {
  const selectedWorkflow = { slug: 'invoice-flow', stages };
  const testInputVariables = { documentId: 'doc-17' };
  return new Function('selectedWorkflow', 'testInputVariables', `return (${simulationPayloadSource});`)(
    selectedWorkflow,
    testInputVariables,
  );
}

function renderStagePanel(testResult) {
  const compiled = ts.transpileModule(`const panel = (${simulationPanelSource});`, {
    fileName: 'workflow-simulation-panel.tsx',
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
      jsx: ts.JsxEmit.React,
    },
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
  const panel = new Function('React', 'testResult', `${compiled.outputText}\nreturn panel;`)(React, testResult);
  return renderToStaticMarkup(panel);
}

function workflowStageCount(workflow) {
  return new Function('wf', `return (${stageCountSource});`)(workflow);
}

describe('workflow simulation honesty', () => {
  it('marks local runs as simulation and carries defined stage names', () => {
    const result = createSimulationResult(['validate', 'extract']);

    assert.equal(result.status, 'SIMULATED_SUCCESS');
    assert.equal(result.dataSource, 'simulation');
    assert.deepEqual(result.simulatedStages, ['validate', 'extract']);
    assert.match(result.message, /simulated locally; no backend request was sent/);

    const panel = renderStagePanel(result);
    assert.match(panel, /Stages walked by this simulation \(2\):/);
    assert.match(panel, /validate, extract/);
  });

  it('treats missing or empty stages as an empty simulation flow', () => {
    for (const stages of [undefined, null, []]) {
      const result = createSimulationResult(stages);
      assert.deepEqual(result.simulatedStages, []);
      assert.equal(result.dataSource, 'simulation');
    }
  });

  it('shows a clear configuration-gap message when simulation has no stages', () => {
    const panel = renderStagePanel(createSimulationResult([]));

    assert.match(panel, /No stages defined for this workflow\./);
    assert.match(panel, /no stage ran/);
    assert.match(panel, /configuration gap, not a passing run/);
    assert.doesNotMatch(panel, /Stages walked by this simulation/);
  });

  it('keeps an empty backend stage response distinct from a local simulation', () => {
    const panel = renderStagePanel({ dataSource: 'backend', stagesCompleted: [] });

    assert.match(panel, /No stage list returned for this run\./);
    assert.match(panel, /backend accepted the workflow but returned no stages/);
    assert.doesNotMatch(panel, /No stages defined for this workflow\./);
  });

  it('uses zero rather than one when the workflow has no stages', () => {
    assert.equal(workflowStageCount({ stages: [] }), 0);
    assert.equal(workflowStageCount({}), 0);
    assert.equal(workflowStageCount({ nodesCount: null, stages: ['validate', 'extract'] }), 2);
    assert.equal(workflowStageCount({ nodesCount: 4, stages: ['validate'] }), 4);
  });
});
