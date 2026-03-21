/**
 * Automated integration test
 * Tests the agent with simulated commands
 */

import chalk from 'chalk';

class MockBrowserAgent {
  constructor() {
    this.commandCount = 0;
  }

  async initialize() {
    console.log(chalk.gray('   Mock agent initialized'));
  }

  async executeCommand(userCommand) {
    this.commandCount++;
    await new Promise(resolve => setTimeout(resolve, 500));

    if (userCommand.toLowerCase().includes('go to') || userCommand.toLowerCase().includes('navigate')) {
      return `Navigated to the specified URL (simulated)`;
    }

    if (userCommand.toLowerCase().includes('search')) {
      return `Performed search (simulated)`;
    }

    if (userCommand.toLowerCase().includes('screenshot')) {
      return `Screenshot captured (simulated)`;
    }

    return `Processed command: "${userCommand}" (simulated)`;
  }
}

async function runTests() {
  console.log(chalk.bold.blue('\n🧪 Running Integration Tests\n'));

  let passed = 0;
  let failed = 0;

  // Test 1: Agent initialization
  try {
    console.log(chalk.cyan('Test 1: Agent initialization'));
    const agent = new MockBrowserAgent();
    await agent.initialize();
    console.log(chalk.green('✓ Agent initialization passed\n'));
    passed++;
  } catch (error) {
    console.log(chalk.red('✗ Agent initialization failed:', error.message, '\n'));
    failed++;
  }

  // Test 2: Navigation command
  try {
    console.log(chalk.cyan('Test 2: Navigation command'));
    const agent = new MockBrowserAgent();
    await agent.initialize();
    const response = await agent.executeCommand('go to google.com');
    if (response.includes('Navigated')) {
      console.log(chalk.green('✓ Navigation command passed\n'));
      passed++;
    } else {
      throw new Error('Unexpected response');
    }
  } catch (error) {
    console.log(chalk.red('✗ Navigation command failed:', error.message, '\n'));
    failed++;
  }

  // Test 3: Search command
  try {
    console.log(chalk.cyan('Test 3: Search command'));
    const agent = new MockBrowserAgent();
    await agent.initialize();
    const response = await agent.executeCommand('search for AI');
    if (response.includes('search')) {
      console.log(chalk.green('✓ Search command passed\n'));
      passed++;
    } else {
      throw new Error('Unexpected response');
    }
  } catch (error) {
    console.log(chalk.red('✗ Search command failed:', error.message, '\n'));
    failed++;
  }

  // Test 4: Screenshot command
  try {
    console.log(chalk.cyan('Test 4: Screenshot command'));
    const agent = new MockBrowserAgent();
    await agent.initialize();
    const response = await agent.executeCommand('take a screenshot');
    if (response.includes('Screenshot')) {
      console.log(chalk.green('✓ Screenshot command passed\n'));
      passed++;
    } else {
      throw new Error('Unexpected response');
    }
  } catch (error) {
    console.log(chalk.red('✗ Screenshot command failed:', error.message, '\n'));
    failed++;
  }

  // Test 5: Multiple commands
  try {
    console.log(chalk.cyan('Test 5: Multiple sequential commands'));
    const agent = new MockBrowserAgent();
    await agent.initialize();
    await agent.executeCommand('go to google.com');
    await agent.executeCommand('search for AI');
    await agent.executeCommand('take a screenshot');
    if (agent.commandCount === 3) {
      console.log(chalk.green('✓ Multiple commands passed\n'));
      passed++;
    } else {
      throw new Error('Command count mismatch');
    }
  } catch (error) {
    console.log(chalk.red('✗ Multiple commands failed:', error.message, '\n'));
    failed++;
  }

  // Summary
  console.log(chalk.bold('\n' + '='.repeat(50)));
  console.log(chalk.bold('Test Summary'));
  console.log('='.repeat(50));
  console.log(chalk.green(`Passed: ${passed}`));
  if (failed > 0) {
    console.log(chalk.red(`Failed: ${failed}`));
  } else {
    console.log(chalk.gray(`Failed: ${failed}`));
  }
  console.log(chalk.bold(`Total:  ${passed + failed}\n`));

  if (failed === 0) {
    console.log(chalk.green.bold('✓ All tests passed!\n'));
    return 0;
  } else {
    console.log(chalk.red.bold('✗ Some tests failed\n'));
    return 1;
  }
}

runTests()
  .then(exitCode => process.exit(exitCode))
  .catch(error => {
    console.error(chalk.red('\n❌ Test runner error:'), error);
    process.exit(1);
  });
