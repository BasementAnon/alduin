import type { PipelineDefinition } from './types.js';

/** Generate a unique pipeline ID with a timestamp suffix */
function pipelineId(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

/**
 * Code review pipeline: implement → review → revise.
 * Loops up to 3 times until the review step outputs "pass".
 *
 * Note: To use the orchestrator model for the review step (a stronger model),
 * the caller can set steps[1].model_override after receiving the definition.
 */
export function codeReviewPipeline(description: string): PipelineDefinition {
  return {
    id: pipelineId('code-review'),
    name: 'Code Review Pipeline',
    steps: [
      {
        step_index: 0,
        executor: 'code',
        action: 'implement',
        instruction_template:
          `Implement the following:\n${description}\n\nWrite clean, well-commented code.`,
        depends_on: [],
        output_type: 'text',
      },
      {
        step_index: 1,
        executor: 'code',
        action: 'review',
        // model_override: set by caller to use the orchestrator's stronger model
        instruction_template:
          'Review this code for bugs, security issues, and style:\n\n{step_0_result}\n\n' +
          "Respond with specific issues found and whether the code passes review. " +
          "Include the word 'pass' if approved or 'fail' if not.",
        depends_on: [0],
        output_type: 'text',
      },
      {
        step_index: 2,
        executor: 'code',
        action: 'edit',
        instruction_template:
          'Revise the code based on this review feedback:\n\n{step_1_result}\n\n' +
          'Original code:\n{step_0_result}',
        depends_on: [0, 1],
        output_type: 'text',
      },
    ],
    max_iterations: 3,
    stop_condition: 'step_1.pass',
  };
}

/**
 * Research and draft pipeline: research a topic then write a document from the findings.
 * Single pass — no iteration.
 */
export function researchAndDraftPipeline(topic: string): PipelineDefinition {
  return {
    id: pipelineId('research-draft'),
    name: 'Research and Draft Pipeline',
    steps: [
      {
        step_index: 0,
        executor: 'research',
        action: 'research',
        instruction_template: `Research the following topic thoroughly:\n${topic}`,
        depends_on: [],
        output_type: 'text',
      },
      {
        step_index: 1,
        executor: 'content',
        action: 'draft',
        instruction_template:
          'Write a well-structured document based on this research:\n\n{step_0_result}',
        depends_on: [0],
        output_type: 'text',
      },
    ],
    max_iterations: 1,
  };
}

/**
 * Test-driven development pipeline: write tests → implement → verify → refactor.
 * Loops up to 3 times until the test step outputs "pass".
 */
export function testDrivenDevPipeline(spec: string): PipelineDefinition {
  return {
    id: pipelineId('tdd'),
    name: 'Test-Driven Development Pipeline',
    steps: [
      {
        step_index: 0,
        executor: 'code',
        action: 'test',
        instruction_template: `Write failing tests for this specification:\n${spec}`,
        depends_on: [],
        output_type: 'text',
      },
      {
        step_index: 1,
        executor: 'code',
        action: 'implement',
        instruction_template:
          'Write code to make these tests pass:\n\n{step_0_result}',
        depends_on: [0],
        output_type: 'text',
      },
      {
        step_index: 2,
        executor: 'code',
        action: 'test',
        instruction_template:
          "Run the tests and report results. Tests:\n{step_0_result}\n\n" +
          "Implementation:\n{step_1_result}\n\nInclude 'pass' if all tests pass.",
        depends_on: [0, 1],
        output_type: 'structured',
      },
      {
        step_index: 3,
        executor: 'code',
        action: 'refactor',
        instruction_template:
          'Refactor this code for clarity and performance:\n{step_1_result}\n\n' +
          'Test results:\n{step_2_result}',
        depends_on: [1, 2],
        output_type: 'text',
      },
    ],
    max_iterations: 3,
    stop_condition: 'step_2.pass',
  };
}
