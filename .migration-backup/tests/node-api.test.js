// Node.js-based API testing without Playwright browser dependency
import http from 'http';
import { URL } from 'url';

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:5001';

function makeRequest(path, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    if (data && method !== 'GET') {
      const jsonData = JSON.stringify(data);
      options.headers['Content-Length'] = Buffer.byteLength(jsonData);
    }

    const req = http.request(options, (res) => {
      let body = '';
      
      res.on('data', (chunk) => {
        body += chunk;
      });
      
      res.on('end', () => {
        try {
          const result = {
            status: res.statusCode,
            headers: res.headers,
            data: body ? JSON.parse(body) : null
          };
          resolve(result);
        } catch (err) {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: body,
            parseError: err.message
          });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (data && method !== 'GET') {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

async function runTests() {
  console.log('🧪 Starting API Tests...\n');
  let passed = 0;
  let failed = 0;
  const errors = [];

  // Test cases
  const tests = [
    {
      name: 'Dashboard Metrics',
      path: '/api/dashboard/metrics',
      expectStatus: 200,
      expectKeys: ['totalDevices', 'activeAlerts', 'openTickets', 'uptime']
    },
    {
      name: 'Devices List',
      path: '/api/devices',
      expectStatus: 200,
      expectArray: true
    },
    {
      name: 'Active Alerts',
      path: '/api/alerts/active',
      expectStatus: 200,
      expectArray: true
    },
    {
      name: 'Open Tickets',
      path: '/api/tickets/open',
      expectStatus: 200,
      expectArray: true
    },
    {
      name: 'Automation Scripts',
      path: '/api/automation-scripts',
      expectStatus: 200,
      expectArray: true
    },
    {
      name: 'Real-time Monitoring',
      path: '/api/monitoring/realtime',
      expectStatus: 200,
      expectArray: true
    },
    {
      name: 'Patch Management',
      path: '/api/patches',
      expectStatus: 200,
      expectArray: true
    },
    {
      name: 'Remote Sessions',
      path: '/api/remote-sessions/active',
      expectStatus: 200,
      expectArray: true
    },
    {
      name: 'Clients List',
      path: '/api/clients',
      expectStatus: 200,
      expectArray: true
    },
    {
      name: 'MeshCentral Status',
      path: '/api/meshcentral/status',
      expectStatus: 200,
      expectKeys: ['status']
    }
  ];

  for (const test of tests) {
    try {
      console.log(`Testing: ${test.name}`);
      const result = await makeRequest(test.path);
      
      let testPassed = true;
      let reason = '';

      // Check status code
      if (result.status !== test.expectStatus) {
        testPassed = false;
        reason = `Expected status ${test.expectStatus}, got ${result.status}`;
      }

      // Check if response should be array
      if (testPassed && test.expectArray) {
        if (!Array.isArray(result.data)) {
          testPassed = false;
          reason = 'Expected array response';
        }
      }

      // Check for required keys
      if (testPassed && test.expectKeys) {
        for (const key of test.expectKeys) {
          if (!result.data || !result.data.hasOwnProperty(key)) {
            testPassed = false;
            reason = `Missing expected key: ${key}`;
            break;
          }
        }
      }

      if (testPassed) {
        console.log(`  ✅ PASS`);
        passed++;
      } else {
        console.log(`  ❌ FAIL - ${reason}`);
        failed++;
        errors.push({ test: test.name, reason });
      }

    } catch (error) {
      console.log(`  ❌ ERROR - ${error.message}`);
      failed++;
      errors.push({ test: test.name, reason: error.message });
    }

    console.log(''); // Empty line for readability
  }

  // Summary
  console.log('📊 Test Results:');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

  if (errors.length > 0) {
    console.log('\n🚨 Error Details:');
    errors.forEach(error => {
      console.log(`  ${error.test}: ${error.reason}`);
    });
  }

  return { passed, failed, errors };
}

// Run the tests
runTests()
  .then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  })
  .catch(error => {
    console.error('Test runner failed:', error);
    process.exit(1);
  });

export { makeRequest, runTests };