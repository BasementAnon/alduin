import { UsageReporter } from './reporter.js';

const BOX_WIDTH = 46;

/** Pad a string to a fixed width with trailing spaces */
function pad(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + ' '.repeat(width - str.length);
}

/** Format a box row: "│ {content} │" */
function row(content: string): string {
  return `│ ${pad(content, BOX_WIDTH - 4)} │`;
}

function divider(): string {
  return `│${' '.repeat(BOX_WIDTH - 2)}│`;
}

/**
 * Terminal dashboard renderer for Alduin usage stats.
 */
export class CliDashboard {
  private reporter: UsageReporter;

  constructor(reporter: UsageReporter) {
    this.reporter = reporter;
  }

  /** Render a framed daily usage summary for the terminal */
  renderDailySummary(): string {
    const report = this.reporter.getDailyReport();
    const lines: string[] = [];

    const top = '┌' + '─'.repeat(BOX_WIDTH - 2) + '┐';
    const bottom = '└' + '─'.repeat(BOX_WIDTH - 2) + '┘';

    lines.push(top);
    lines.push(row(`Alduin Daily Usage — ${report.date}`));
    lines.push(divider());

    const pct = report.budget_pct_used.toFixed(1);
    const cost = report.total_cost_usd.toFixed(4);
    const remaining = report.budget_remaining_usd.toFixed(2);
    lines.push(row(`Total: $${cost} / $${remaining} remaining (${pct}%)`));
    lines.push(row(`Tasks: ${report.total_tasks} completed`));

    if (Object.keys(report.by_model).length > 0) {
      lines.push(divider());
      lines.push(row('By Model:'));
      for (const [model, stats] of Object.entries(report.by_model)) {
        const shortModel = model.length > 30 ? '...' + model.slice(-27) : model;
        lines.push(
          row(`  ${pad(shortModel, 32)} $${stats.cost.toFixed(4)} (${stats.tasks} tasks)`)
        );
      }
    }

    if (Object.keys(report.by_executor).length > 0) {
      lines.push(divider());
      lines.push(row('By Executor:'));
      for (const [executor, stats] of Object.entries(report.by_executor)) {
        lines.push(
          row(`  ${pad(executor, 12)} $${stats.cost.toFixed(4)}  ${stats.tokens.toLocaleString()} tok`)
        );
      }
    }

    if (report.budget_pct_used > 80) {
      lines.push(divider());
      lines.push(row(`⚠ Warning: ${pct}% of daily budget used`));
    }

    lines.push(bottom);
    return lines.join('\n');
  }

  /** Return the trace summary for a task, or a "not found" message */
  renderTaskTrace(taskId: string): string {
    const report = this.reporter.getTaskReport(taskId);
    return report ?? 'Trace not found.';
  }

  /**
   * One-line status line for the REPL prompt footer.
   * "Memory: {hot} hot | {warm}tok warm | {cold} cold | Session: ${cost}"
   */
  renderStatus(stats: {
    hot_turns: number;
    warm_tokens: number;
    cold_entries: number;
    session_cost: number;
  }): string {
    return (
      `Memory: ${stats.hot_turns} hot | ${stats.warm_tokens}tok warm | ` +
      `${stats.cold_entries} cold | Session: $${stats.session_cost.toFixed(4)}`
    );
  }
}
