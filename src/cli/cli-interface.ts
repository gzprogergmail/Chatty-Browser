import inquirer from 'inquirer';
import chalk from 'chalk';
import { BrowserAgent } from '../agent/browser-agent.js';
import type { AvailableModel } from '../copilot/copilot-client.js';
import type { MemorySidekickStatus } from '../memory/memory-store.js';

export class CLIInterface {
  private running = false;
  private activeTurn = false;
  private pendingMemoryFeedback: MemorySidekickStatus | null = null;
  private lastMemoryFeedbackKey: string | null = null;
  private lastAnnouncedRunAt: string | null = null;
  private readonly unsubscribeMemoryStatus: () => void;

  constructor(private agent: BrowserAgent) {
    this.unsubscribeMemoryStatus = typeof this.agent.onMemorySidekickStatusChange === 'function'
      ? this.agent.onMemorySidekickStatusChange((status) => {
          if (this.activeTurn) {
            this.pendingMemoryFeedback = status;
            return;
          }

          this.maybeRenderMemoryFeedback(status);
        })
      : () => {};
  }

  async start() {
    this.running = true;

    console.log(chalk.gray('Type your commands below. Type "exit" or "quit" to stop.\n'));

    while (this.running) {
      try {
        const { command } = await inquirer.prompt([
          {
            type: 'input',
            name: 'command',
            message: chalk.bold('You:'),
            prefix: '',
          },
        ]);

        const trimmedCommand = command.trim();

        if (!trimmedCommand) {
          continue;
        }

        if (trimmedCommand.toLowerCase() === 'exit' || trimmedCommand.toLowerCase() === 'quit') {
          console.log(chalk.yellow('\n👋 Goodbye!\n'));
          this.running = false;
          process.exit(0);
        }

        // Handle special commands
        if (trimmedCommand.toLowerCase() === 'clear') {
          console.clear();
          continue;
        }

        if (trimmedCommand.toLowerCase() === 'help') {
          this.showHelp();
          continue;
        }

        if (trimmedCommand.toLowerCase() === '/new') {
          await this.agent.newSession();
          console.log(chalk.cyan('\n🆕 New session started. Conversation history cleared.\n'));
          continue;
        }

        if (trimmedCommand.toLowerCase() === '/model') {
          await this.chooseModel();
          continue;
        }

        if (trimmedCommand.toLowerCase() === '/usage') {
          await this.showPremiumRequestsUsage();
          continue;
        }

        if (trimmedCommand.toLowerCase() === '/memory-status') {
          this.showMemorySidekickStatus();
          continue;
        }

        if (trimmedCommand.toLowerCase().startsWith('/timeout')) {
          this.handleTimeoutCommand(trimmedCommand);
          continue;
        }

        // Execute the command through the agent
        console.log(chalk.gray('\n🤖 Agent: Processing...\n'));
        this.activeTurn = true;
        const response = await this.agent.executeCommand(trimmedCommand);
        this.activeTurn = false;
        this.flushPendingMemoryFeedback();

        if (this.agent.didStreamLastTurn()) {
          process.stdout.write('\n');
        } else {
          console.log(chalk.green(`\n🤖 Agent: ${response}\n`));
        }

        // Show token usage after every response
        this.showTokenUsage();
        this.showMemorySidekickStatus();

      } catch (error) {
        this.activeTurn = false;
        this.flushPendingMemoryFeedback();
        if ((error as any).isTtyError) {
          console.error(chalk.red('CLI could not be rendered in this environment'));
          this.running = false;
        } else {
          console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : error}\n`));
        }
      }
    }
  }

  private showHelp() {
    console.log(chalk.cyan('\n📖 Available Commands:\n'));
    console.log('  • Type any natural language command to control the browser');
    console.log('  • Examples:');
    console.log(chalk.gray('    - "Go to google.com"'));
    console.log(chalk.gray('    - "Search for AI news"'));
    console.log(chalk.gray('    - "Click on the first result"'));
    console.log(chalk.gray('    - "Take a screenshot"'));
    console.log(chalk.gray('    - "Fill in the form with my email"'));
    console.log('\n  Special commands:');
    console.log('  • /model - Choose from the live Copilot model list');
    console.log('  • /timeout - Show the current per-turn timeout');
    console.log('  • /timeout 10m - Set the per-turn timeout using ms, s, or m');
    console.log('  • /usage - Show remaining Copilot premium requests allowance');
    console.log('  • /memory-status - Show the background memory sidekick status');
    console.log('  • /new  - Start a new session (clears conversation history)');
    console.log('  • help  - Show this help message');
    console.log('  • clear - Clear the screen');
    console.log('  • exit  - Quit the application\n');
  }

  private async chooseModel() {
    const models = await this.agent.getAvailableModels();
    const { modelId } = await inquirer.prompt<{ modelId: string }>([
      {
        type: 'list',
        name: 'modelId',
        message: 'Choose model:',
        pageSize: Math.min(15, Math.max(6, models.length)),
        choices: models.map((model) => ({
          name: model.label,
          value: model.model,
        })),
      },
    ]);

    const selected = await this.agent.setModel(modelId);
    console.log(chalk.cyan(`\n🔁 Model set to ${selected.label}\n`));
    if (selected.warning) {
      console.log(chalk.yellow(`   Note: ${selected.warning}\n`));
    }
  }

  private showTokenUsage() {
    const { model, used, max, compacting } = this.agent.getTokenUsage();
    const pct = ((used / max) * 100).toFixed(1);
    const bar = this.buildBar(used, max, 20);
    const colour = used / max > 0.85 ? chalk.red : used / max > 0.60 ? chalk.yellow : chalk.gray;
    const compactingTag = compacting ? chalk.cyan(' [⏳ compacting...]') : '';
    console.log(colour(`   Context [${model}]: ${bar} ~${used.toLocaleString()} / ${max.toLocaleString()} tokens (${pct}%)`) + compactingTag + '\n');
  }

  private showMemorySidekickStatus() {
    const status = this.agent.getMemorySidekickStatus();
    const summary = status.lastSummary ? `, last: ${status.lastSummary}` : '';
    const errorText = status.lastError ? `, error: ${status.lastError}` : '';
    const queuedText = status.rerunQueued ? ', rerun queued' : '';
    console.log(
      chalk.gray(
        `   Memory sidekick: ${status.state} (${status.pendingTokenEstimate.toLocaleString()} / ${status.distillationThresholdTokens.toLocaleString()} pending tokens${queuedText}${summary}${errorText})`,
      ) + '\n',
    );
  }

  private flushPendingMemoryFeedback() {
    if (!this.pendingMemoryFeedback) return;
    const pending = this.pendingMemoryFeedback;
    this.pendingMemoryFeedback = null;
    this.maybeRenderMemoryFeedback(pending);
  }

  private maybeRenderMemoryFeedback(status: MemorySidekickStatus) {
    const feedback = this.buildMemoryFeedback(status);
    if (!feedback) return;

    const feedbackKey = `${status.state}|${status.rerunQueued}|${status.lastRunAt ?? ''}|${status.lastSummary ?? ''}|${status.lastError ?? ''}|${status.pendingTokenEstimate}`;
    if (feedbackKey === this.lastMemoryFeedbackKey) return;

    this.lastMemoryFeedbackKey = feedbackKey;
    console.log(feedback);
  }

  private buildMemoryFeedback(status: MemorySidekickStatus): string | null {
    if (status.state === 'pending') {
      return chalk.gray(
        `   Memory sidekick queued in background (${status.pendingTokenEstimate.toLocaleString()} pending tokens).`,
      );
    }

    if (status.state === 'running') {
      return chalk.gray('   Memory sidekick saving in background...');
    }

    if (status.state === 'error' && status.lastError) {
      return chalk.yellow(`   Memory sidekick hit an error: ${status.lastError}`);
    }

    if (status.state === 'idle' && status.lastRunAt && status.lastRunAt !== this.lastAnnouncedRunAt) {
      this.lastAnnouncedRunAt = status.lastRunAt;
      const summary = status.lastSummary ?? (status.lastSavedCount > 0
        ? `Saved ${status.lastSavedCount} memory item${status.lastSavedCount === 1 ? '' : 's'}.`
        : 'No durable memory found.');
      return chalk.gray(`   Memory sidekick finished: ${summary}`);
    }

    return null;
  }

  private handleTimeoutCommand(command: string) {
    const parts = command.split(/\s+/).filter(Boolean);

    if (parts.length === 1) {
      const current = this.agent.getTurnTimeoutMs();
      console.log(chalk.cyan(`\n⏱️ Turn timeout is ${this.formatTimeout(current)} (${current.toLocaleString()} ms)\n`));
      return;
    }

    const parsed = this.parseTimeout(parts.slice(1).join(' '));
    const updated = this.agent.setTurnTimeoutMs(parsed);
    console.log(chalk.cyan(`\n⏱️ Turn timeout set to ${this.formatTimeout(updated)} (${updated.toLocaleString()} ms)\n`));
  }

  private async showPremiumRequestsUsage() {
    const usage = await this.agent.getPremiumRequestsUsage();
    const percent = this.formatPremiumRemainingPercent(usage.remainingRequests, usage.entitlementRequests, usage.remainingPercentage);
    const resetText = this.formatNextPremiumResetDate();
    const overageText = usage.overageAllowedWithExhaustedQuota ? 'allowed' : 'not allowed';

    console.log(chalk.cyan('\n📊 Copilot Premium Usage\n'));
    console.log(`   Quota: ${usage.quotaName}`);
    console.log(`   Remaining: ${usage.remainingRequests.toLocaleString()} / ${usage.entitlementRequests.toLocaleString()} requests (${percent}%)`);
    console.log(`   Used: ${usage.usedRequests.toLocaleString()} requests`);
    console.log(`   Overage: ${usage.overage.toLocaleString()} (${overageText})`);
    console.log(`   Reset: ${resetText}\n`);
  }

  private formatPremiumRemainingPercent(remainingRequests: number, entitlementRequests: number, fallbackPercentage: number): string {
    if (entitlementRequests > 0) {
      return ((remainingRequests / entitlementRequests) * 100).toFixed(1);
    }

    const normalizedPercentage = fallbackPercentage > 1 ? fallbackPercentage : fallbackPercentage * 100;
    return normalizedPercentage.toFixed(1);
  }

  private formatNextPremiumResetDate(now: Date = new Date()): string {
    const nextReset = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() + 1,
      1,
      0,
      0,
      0,
      0,
    ));

    return nextReset.toLocaleString('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });
  }

  private parseTimeout(value: string): number {
    const trimmed = value.trim().toLowerCase();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
    if (!match) {
      throw new Error('Invalid timeout. Use values like /timeout 30000, /timeout 30s, or /timeout 5m.');
    }

    const amount = Number(match[1]);
    const unit = match[2] ?? 's';
    const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1_000 : 60_000;
    const timeoutMs = amount * multiplier;

    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
      throw new Error('Timeout must be at least 1 second.');
    }

    return Math.round(timeoutMs);
  }

  private formatTimeout(timeoutMs: number): string {
    if (timeoutMs % 60_000 === 0) {
      return `${timeoutMs / 60_000}m`;
    }

    if (timeoutMs % 1_000 === 0) {
      return `${timeoutMs / 1_000}s`;
    }

    return `${timeoutMs}ms`;
  }

  private buildBar(used: number, max: number, width: number): string {
    const filled = Math.round((used / max) * width);
    return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
  }

  stop() {
    this.running = false;
    this.unsubscribeMemoryStatus();
  }
}
