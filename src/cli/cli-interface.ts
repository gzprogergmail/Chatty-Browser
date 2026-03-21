import inquirer from 'inquirer';
import chalk from 'chalk';
import { BrowserAgent } from '../agent/browser-agent.js';

export class CLIInterface {
  private running = false;

  constructor(private agent: BrowserAgent) {}

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

        // Execute the command through the agent
        console.log(chalk.gray('\n🤖 Agent: Processing...\n'));
        
        const response = await this.agent.executeCommand(trimmedCommand);
        
        console.log(chalk.green(`\n🤖 Agent: ${response}\n`));

        // Show token usage after every response
        this.showTokenUsage();

      } catch (error) {
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
    console.log('  • /new  - Start a new session (clears conversation history)');
    console.log('  • help  - Show this help message');
    console.log('  • clear - Clear the screen');
    console.log('  • exit  - Quit the application\n');
  }

  private showTokenUsage() {
    const { used, max, compacting } = this.agent.getTokenUsage();
    const pct = ((used / max) * 100).toFixed(1);
    const bar = this.buildBar(used, max, 20);
    const colour = used / max > 0.85 ? chalk.red : used / max > 0.60 ? chalk.yellow : chalk.gray;
    const compactingTag = compacting ? chalk.cyan(' [⏳ compacting...]') : '';
    console.log(colour(`   Context: ${bar} ~${used.toLocaleString()} / ${max.toLocaleString()} tokens (${pct}%)`) + compactingTag + '\n');
  }

  private buildBar(used: number, max: number, width: number): string {
    const filled = Math.round((used / max) * width);
    return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
  }

  stop() {
    this.running = false;
  }
}
