import http from 'http';

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:5001';

// Test real-world API integration scenarios
async function testAPIIntegration() {
  console.log('🔗 Testing API Integration Scenarios...\n');
  
  let passed = 0;
  let failed = 0;
  const errors = [];

  const scenarios = [
    {
      name: 'Dashboard Data Loading',
      steps: async () => {
        // Simulate dashboard loading sequence
        const metrics = await makeAPICall('/api/dashboard/metrics');
        const devices = await makeAPICall('/api/devices');
        const alerts = await makeAPICall('/api/alerts/active');
        const tickets = await makeAPICall('/api/tickets/open');

        return {
          success: metrics.status === 200 && devices.status === 200 && 
                   alerts.status === 200 && tickets.status === 200,
          details: `Metrics: ${metrics.status}, Devices: ${devices.status}, Alerts: ${alerts.status}, Tickets: ${tickets.status}`
        };
      }
    },
    {
      name: 'Device Management Workflow',
      steps: async () => {
        const devices = await makeAPICall('/api/devices');
        const realtime = await makeAPICall('/api/monitoring/realtime');
        
        return {
          success: devices.status === 200 && realtime.status === 200,
          details: `Devices: ${devices.status}, Monitoring: ${realtime.status}`
        };
      }
    },
    {
      name: 'Remote Access Integration',
      steps: async () => {
        const sessions = await makeAPICall('/api/remote-sessions/active');
        const meshStatus = await makeAPICall('/api/meshcentral/status');
        
        return {
          success: sessions.status === 200 && meshStatus.status === 200,
          details: `Sessions: ${sessions.status}, MeshCentral: ${meshStatus.status}`
        };
      }
    },
    {
      name: 'Automation System',
      steps: async () => {
        const scripts = await makeAPICall('/api/automation-scripts');
        const patches = await makeAPICall('/api/patches');
        
        return {
          success: scripts.status === 200 && patches.status === 200,
          details: `Scripts: ${scripts.status}, Patches: ${patches.status}`
        };
      }
    },
    {
      name: 'Client Management System',
      steps: async () => {
        const clients = await makeAPICall('/api/clients');
        
        return {
          success: clients.status === 200,
          details: `Clients: ${clients.status}`
        };
      }
    }
  ];

  for (const scenario of scenarios) {
    try {
      console.log(`Testing: ${scenario.name}`);
      const result = await scenario.steps();
      
      if (result.success) {
        console.log(`  ✅ PASS - ${result.details}`);
        passed++;
      } else {
        console.log(`  ❌ FAIL - ${result.details}`);
        failed++;
        errors.push({ scenario: scenario.name, details: result.details });
      }
    } catch (error) {
      console.log(`  ❌ ERROR - ${error.message}`);
      failed++;
      errors.push({ scenario: scenario.name, details: error.message });
    }
    console.log('');
  }

  console.log('📊 Integration Test Results:');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

  if (errors.length > 0) {
    console.log('\n🚨 Error Details:');
    errors.forEach(error => {
      console.log(`  ${error.scenario}: ${error.details}`);
    });
  }

  return { passed, failed, errors };
}

function makeAPICall(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: new URL(baseUrl).port || 5001,
      path: path,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            data: body ? JSON.parse(body) : null
          });
        } catch (err) {
          resolve({
            status: res.statusCode,
            data: body,
            parseError: err.message
          });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

// Run integration tests
testAPIIntegration()
  .then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  })
  .catch(error => {
    console.error('Integration test failed:', error);
    process.exit(1);
  });

export { testAPIIntegration };