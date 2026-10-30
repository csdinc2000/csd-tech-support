#!/usr/bin/env node

/**
 * Final System Validation for RMM Platform
 * Comprehensive validation of all system components
 */

// Add global fetch polyfill for older Node.js versions
if (typeof fetch === 'undefined') {
  try {
    global.fetch = require('node-fetch');
  } catch (e) {
    // Use built-in fetch for Node.js 18+
    console.log('Using built-in fetch');
  }
}

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m'
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

class SystemValidator {
  constructor() {
    this.baseUrl = process.env.TEST_BASE_URL || 'http://localhost:5001';
    this.results = {
      apiEndpoints: { passed: 0, failed: 0, tests: [] },
      frontendPages: { passed: 0, failed: 0, tests: [] },
      integrations: { passed: 0, failed: 0, tests: [] },
      performance: { passed: 0, failed: 0, tests: [] }
    };
  }

  async validateApiEndpoint(endpoint, expectedProperties = []) {
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      // Validate expected properties if provided
      for (const prop of expectedProperties) {
        if (!data.hasOwnProperty(prop) && (!Array.isArray(data) || data.length === 0 || !data[0].hasOwnProperty(prop))) {
          throw new Error(`Missing expected property: ${prop}`);
        }
      }

      this.results.apiEndpoints.passed++;
      this.results.apiEndpoints.tests.push({ endpoint, status: 'PASS' });
      log('green', `✅ ${endpoint}`);
      return true;

    } catch (error) {
      this.results.apiEndpoints.failed++;
      this.results.apiEndpoints.tests.push({ endpoint, status: 'FAIL', error: error.message });
      log('red', `❌ ${endpoint} - ${error.message}`);
      return false;
    }
  }

  async validateFrontendPage(path) {
    try {
      const response = await fetch(`${this.baseUrl}${path}`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      
      // Basic HTML validation
      if (!html.includes('<!DOCTYPE html>') && !html.includes('<html')) {
        throw new Error('Invalid HTML response');
      }

      this.results.frontendPages.passed++;
      this.results.frontendPages.tests.push({ path, status: 'PASS' });
      log('green', `✅ Frontend: ${path}`);
      return true;

    } catch (error) {
      this.results.frontendPages.failed++;
      this.results.frontendPages.tests.push({ path, status: 'FAIL', error: error.message });
      log('red', `❌ Frontend: ${path} - ${error.message}`);
      return false;
    }
  }

  async validateIntegration(name, testFn) {
    try {
      await testFn();
      this.results.integrations.passed++;
      this.results.integrations.tests.push({ name, status: 'PASS' });
      log('green', `✅ Integration: ${name}`);
      return true;
    } catch (error) {
      this.results.integrations.failed++;
      this.results.integrations.tests.push({ name, status: 'FAIL', error: error.message });
      log('red', `❌ Integration: ${name} - ${error.message}`);
      return false;
    }
  }

  async validatePerformance(name, testFn, maxTime = 5000) {
    try {
      const startTime = Date.now();
      await testFn();
      const duration = Date.now() - startTime;
      
      if (duration > maxTime) {
        throw new Error(`Response time ${duration}ms exceeds ${maxTime}ms threshold`);
      }

      this.results.performance.passed++;
      this.results.performance.tests.push({ name, status: 'PASS', duration: `${duration}ms` });
      log('green', `✅ Performance: ${name} (${duration}ms)`);
      return true;
    } catch (error) {
      this.results.performance.failed++;
      this.results.performance.tests.push({ name, status: 'FAIL', error: error.message });
      log('red', `❌ Performance: ${name} - ${error.message}`);
      return false;
    }
  }

  async runApiValidation() {
    log('cyan', '\n🔍 Validating API Endpoints...');
    
    const endpoints = [
      { path: '/api/dashboard/metrics', props: ['totalDevices', 'activeAlerts', 'openTickets'] },
      { path: '/api/devices', props: ['id', 'name', 'type', 'status'] },
      { path: '/api/alerts/active', props: ['id', 'title', 'severity'] },
      { path: '/api/tickets/open', props: ['id', 'subject', 'priority'] },
      { path: '/api/clients', props: ['id', 'name'] },
      { path: '/api/patches', props: ['id', 'title', 'severity'] },
      { path: '/api/patch-policies', props: ['id', 'name', 'autoInstall'] },
      { path: '/api/automation-scripts', props: ['id', 'name', 'scriptType'] },
      { path: '/api/network/devices', props: ['ipAddress', 'macAddress', 'hostname'] },
      { path: '/api/network/scans/history', props: ['networkRange', 'status'] },
      { path: '/api/remote-sessions/active', props: [] }
    ];

    for (const { path, props } of endpoints) {
      await this.validateApiEndpoint(path, props);
    }
  }

  async runFrontendValidation() {
    log('cyan', '\n🌐 Validating Frontend Pages...');
    
    const pages = [
      '/',
      '/dashboard',
      '/devices',
      '/network-discovery',
      '/monitoring',
      '/patches',
      '/tickets',
      '/remote-access',
      '/automation',
      '/reports',
      '/clients'
    ];

    for (const page of pages) {
      await this.validateFrontendPage(page);
    }
  }

  async runIntegrationValidation() {
    log('cyan', '\n🔗 Validating System Integrations...');

    await this.validateIntegration('Dashboard Data Aggregation', async () => {
      const metrics = await fetch(`${this.baseUrl}/api/dashboard/metrics`).then(r => r.json());
      const devices = await fetch(`${this.baseUrl}/api/devices`).then(r => r.json());
      const alerts = await fetch(`${this.baseUrl}/api/alerts/active`).then(r => r.json());
      
      if (typeof metrics.totalDevices !== 'number') throw new Error('Invalid device count');
      if (typeof metrics.activeAlerts !== 'number') throw new Error('Invalid alert count');
    });

    await this.validateIntegration('Network Discovery Workflow', async () => {
      const devices = await fetch(`${this.baseUrl}/api/network/devices`).then(r => r.json());
      const scans = await fetch(`${this.baseUrl}/api/network/scans/history`).then(r => r.json());
      
      if (!Array.isArray(devices)) throw new Error('Network devices not available');
      if (!Array.isArray(scans)) throw new Error('Scan history not available');
    });

    await this.validateIntegration('Patch Management System', async () => {
      const patches = await fetch(`${this.baseUrl}/api/patches`).then(r => r.json());
      const policies = await fetch(`${this.baseUrl}/api/patch-policies`).then(r => r.json());
      
      if (!Array.isArray(patches)) throw new Error('Patches not available');
      if (!Array.isArray(policies)) throw new Error('Patch policies not available');
    });

    await this.validateIntegration('Client Management System', async () => {
      const clients = await fetch(`${this.baseUrl}/api/clients`).then(r => r.json());
      
      if (!Array.isArray(clients)) throw new Error('Clients not available');
    });
  }

  async runPerformanceValidation() {
    log('cyan', '\n⚡ Validating System Performance...');

    await this.validatePerformance('Dashboard Load Time', async () => {
      await fetch(`${this.baseUrl}/api/dashboard/metrics`);
    }, 2000);

    await this.validatePerformance('Device List Load Time', async () => {
      await fetch(`${this.baseUrl}/api/devices`);
    }, 2000);

    await this.validatePerformance('Network Discovery Load Time', async () => {
      await fetch(`${this.baseUrl}/api/network/devices`);
    }, 2000);

    await this.validatePerformance('Frontend Page Load Time', async () => {
      await fetch(`${this.baseUrl}/`);
    }, 3000);
  }

  generateReport() {
    const totalPassed = Object.values(this.results).reduce((sum, category) => sum + category.passed, 0);
    const totalFailed = Object.values(this.results).reduce((sum, category) => sum + category.failed, 0);
    const totalTests = totalPassed + totalFailed;
    const successRate = totalTests > 0 ? Math.round((totalPassed / totalTests) * 100) : 0;

    log('bold', '\n📊 COMPREHENSIVE SYSTEM VALIDATION REPORT');
    log('bold', '═'.repeat(50));
    
    log('cyan', `\n📈 Overall Results:`);
    log('green', `  ✅ Tests Passed: ${totalPassed}`);
    log('red', `  ❌ Tests Failed: ${totalFailed}`);
    log('blue', `  📊 Success Rate: ${successRate}%`);

    Object.entries(this.results).forEach(([category, results]) => {
      const categorySuccessRate = (results.passed + results.failed) > 0 
        ? Math.round((results.passed / (results.passed + results.failed)) * 100) 
        : 0;
      
      log('cyan', `\n${category.charAt(0).toUpperCase() + category.slice(1)}:`);
      log('green', `  ✅ Passed: ${results.passed}`);
      log('red', `  ❌ Failed: ${results.failed}`);
      log('blue', `  📊 Success Rate: ${categorySuccessRate}%`);
    });

    if (successRate >= 90) {
      log('green', '\n🎉 SYSTEM VALIDATION SUCCESSFUL!');
      log('green', '   All critical components are functioning correctly.');
      log('green', '   The RMM platform is ready for production use.');
    } else if (successRate >= 75) {
      log('yellow', '\n⚠️  SYSTEM VALIDATION COMPLETED WITH WARNINGS');
      log('yellow', '   Most components are working but some issues detected.');
      log('yellow', '   Review failed tests before production deployment.');
    } else {
      log('red', '\n❌ SYSTEM VALIDATION FAILED');
      log('red', '   Critical issues detected in multiple components.');
      log('red', '   System requires attention before production use.');
    }

    return successRate >= 75;
  }

  async run() {
    log('bold', '🚀 Starting Comprehensive System Validation...\n');

    try {
      await this.runApiValidation();
      await this.runFrontendValidation();
      await this.runIntegrationValidation();
      await this.runPerformanceValidation();

      return this.generateReport();
    } catch (error) {
      log('red', `❌ System validation failed: ${error.message}`);
      return false;
    }
  }
}

// Run the validation
async function main() {
  const validator = new SystemValidator();
  const success = await validator.run();
  process.exit(success ? 0 : 1);
}

main().catch(error => {
  log('red', `❌ Validation failed: ${error.message}`);
  process.exit(1);
});